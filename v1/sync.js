/* ==========================================================================
   shared/v1/sync.js
   GitHub Contents API 읽기/쓰기 + outbox 재전송 큐 (ES module)

   ⚠️ v1/ 은 한 번 올린 뒤 절대 수정하지 않습니다.
      고칠 일이 생기면 v2/ 를 새로 만들고 앱을 하나씩 옮깁니다.
      자세한 내용은 저장소 루트의 README.md 를 확인하세요.

   이 파일은 ES module 입니다 (import/export 사용).
   classic <script> 에서 쓰려면 같은 폴더의 sync-global.js 를 대신 불러오세요.

   저장하지 않는 것: 토큰(token)은 함수 인자로만 받고,
   이 파일 어디에도(localStorage, IndexedDB, 변수 캐시) 저장하지 않습니다.
   토큰을 어디에 보관할지는 이 파일을 사용하는 앱이 결정합니다.
   ========================================================================== */

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
const OUTBOX_DB_PREFIX = 'shared-sync-outbox-';
const OUTBOX_STORE = 'items';

/* ── 에러 타입 ─────────────────────────────────────────────────────────── */

export class SyncError extends Error {
  constructor(message, { type = 'unknown', status = 0, cause } = {}) {
    super(message);
    this.name = 'SyncError';
    this.type = type; // 'network' | 'auth' | 'conflict' | 'notfound' | 'unknown'
    this.status = status;
    if (cause) this.cause = cause;
  }
}

function classifyStatus(status) {
  if (status === 401 || status === 403) return 'auth';
  if (status === 404) return 'notfound';
  if (status === 409 || status === 422) return 'conflict';
  return 'unknown';
}

/* ── UTF-8 안전 base64 ─────────────────────────────────────────────────
   btoa()/atob() 는 UTF-8이 아닌 UTF-16 코드 유닛 기준이라 한글이 깨집니다.
   TextEncoder/TextDecoder 를 거쳐 바이트 단위로 변환합니다.
   ────────────────────────────────────────────────────────────────────── */

export function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

export function base64ToUtf8(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/* ── GitHub Contents API 요청 ──────────────────────────────────────────── */

function apiUrl(owner, repo, path) {
  const encodedPath = path.split('/').map(encodeURIComponent).join('/');
  return `${API_BASE}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}`;
}

async function ghFetch(url, token, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': API_VERSION,
        ...(init.headers || {}),
      },
    });
  } catch (cause) {
    throw new SyncError('네트워크 요청에 실패했습니다.', { type: 'network', cause });
  }
  return res;
}

/**
 * 파일 읽기.
 * @param {{owner:string, repo:string, token:string, branch?:string}} config
 * @param {string} path - 저장소 루트 기준 경로 (예: 'clip/data.json')
 * @returns {Promise<{exists:boolean, content:string|null, sha:string|null, size:number}>}
 */
export async function readFile(config, path) {
  const { owner, repo, token, branch = 'main' } = config;
  const url = `${apiUrl(owner, repo, path)}?ref=${encodeURIComponent(branch)}`;

  const res = await ghFetch(url, token, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (res.status === 404) {
    return { exists: false, content: null, sha: null, size: 0 };
  }
  if (!res.ok) {
    throw new SyncError(`파일을 읽지 못했습니다 (HTTP ${res.status}).`, {
      type: classifyStatus(res.status),
      status: res.status,
    });
  }

  const meta = await res.json();
  if (Array.isArray(meta)) {
    throw new SyncError('경로가 폴더입니다. 파일 경로를 지정하세요.', { type: 'unknown' });
  }

  let content;
  const isOversized = meta.encoding === 'none' || (meta.content === '' && meta.size > 1000000);
  if (isOversized) {
    // 1MB 초과 파일은 encoding 이 'none' 으로 오고 content 가 빈 문자열입니다.
    // raw 미디어 타입으로 다시 요청해 실제 내용을 받습니다.
    const rawRes = await ghFetch(`${apiUrl(owner, repo, path)}?ref=${encodeURIComponent(branch)}`, token, {
      headers: { Accept: 'application/vnd.github.raw' },
    });
    if (!rawRes.ok) {
      throw new SyncError(`대용량 파일을 읽지 못했습니다 (HTTP ${rawRes.status}).`, {
        type: classifyStatus(rawRes.status),
        status: rawRes.status,
      });
    }
    content = await rawRes.text();
  } else {
    content = base64ToUtf8(meta.content);
  }

  return { exists: true, content, sha: meta.sha, size: meta.size };
}

/**
 * 폴더 안 항목 목록 조회.
 * @param {{owner:string, repo:string, token:string, branch?:string}} config
 * @param {string} dirPath - 저장소 루트 기준 폴더 경로 (예: 'clip')
 * @returns {Promise<Array<{name:string, path:string, sha:string, size:number, type:string}>>}
 *   폴더가 없으면(404) 빈 배열을 반환합니다.
 */
export async function listDir(config, dirPath) {
  const { owner, repo, token, branch = 'main' } = config;
  const url = `${apiUrl(owner, repo, dirPath)}?ref=${encodeURIComponent(branch)}`;

  const res = await ghFetch(url, token, {
    headers: { Accept: 'application/vnd.github+json' },
  });

  if (res.status === 404) {
    return [];
  }
  if (!res.ok) {
    throw new SyncError(`폴더를 읽지 못했습니다 (HTTP ${res.status}).`, {
      type: classifyStatus(res.status),
      status: res.status,
    });
  }

  const meta = await res.json();
  if (!Array.isArray(meta)) {
    throw new SyncError('경로가 폴더가 아닙니다. 폴더 경로를 지정하세요.', { type: 'unknown' });
  }

  return meta.map((entry) => ({
    name: entry.name,
    path: entry.path,
    sha: entry.sha,
    size: entry.size,
    type: entry.type === 'dir' ? 'dir' : 'file',
  }));
}

/**
 * 파일 쓰기 (생성 또는 수정).
 * @param {{owner:string, repo:string, token:string, branch?:string}} config
 * @param {string} path
 * @param {string} content - UTF-8 문자열 (base64 인코딩은 내부에서 처리)
 * @param {{sha?:string, message?:string}} [opts] - 기존 파일을 수정할 때는 sha 필수 (충돌 감지용)
 * @returns {Promise<{sha:string}>}
 */
export async function writeFile(config, path, content, opts = {}) {
  const { owner, repo, token, branch = 'main' } = config;
  const { sha, message = `sync: update ${path}` } = opts;

  const res = await ghFetch(apiUrl(owner, repo, path), token, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      content: utf8ToBase64(content),
      branch,
      ...(sha ? { sha } : {}),
    }),
  });

  if (!res.ok) {
    const status = res.status;
    const text = await res.text().catch(() => '');
    if (status === 409 || status === 422) {
      throw new SyncError('충돌이 발생했습니다. 최신 sha 를 다시 받아 재시도하세요.', {
        type: 'conflict',
        status,
        cause: text,
      });
    }
    throw new SyncError(`파일을 쓰지 못했습니다 (HTTP ${status}).`, {
      type: classifyStatus(status),
      status,
      cause: text,
    });
  }

  const data = await res.json();
  return { sha: data.content.sha };
}

/**
 * 파일 삭제.
 * @param {{owner:string, repo:string, token:string, branch?:string}} config
 * @param {string} path
 * @param {string} sha - 삭제할 파일의 현재 sha
 * @param {string} [message]
 */
export async function deleteFile(config, path, sha, message = `sync: delete ${path}`) {
  const { owner, repo, token, branch = 'main' } = config;
  const res = await ghFetch(apiUrl(owner, repo, path), token, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sha, branch }),
  });
  if (!res.ok) {
    const status = res.status;
    throw new SyncError(`파일을 삭제하지 못했습니다 (HTTP ${status}).`, {
      type: classifyStatus(status),
      status,
    });
  }
}

/* ── Outbox: 전송 실패한 변경을 IndexedDB 큐에 쌓고, 온라인이 되면 순서대로 재전송
   토큰은 큐에 저장하지 않습니다. resolveConfig() 가 재전송 시점에 매번 새로
   {owner, repo, token, branch} 를 돌려줘야 합니다 (앱이 보관한 토큰을 그때 전달).
   ────────────────────────────────────────────────────────────────────── */

function openOutboxDb(namespace) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(OUTBOX_DB_PREFIX + namespace, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(OUTBOX_STORE)) {
        // 기본 키는 자동 증가하는 seq 입니다 (순서 보존용). id(UUID)는 큐 밖으로
        // 노출되는 항목 식별자이고, sort 불가능한 값이라 순서 판단에는 쓰지 않습니다.
        // createdAt(밀리초)만으로 정렬하면 짧은 시간에 여러 항목을 넣을 때
        // 타임스탬프가 겹쳐 순서가 뒤바뀔 수 있어 seq로 대체했습니다.
        const store = db.createObjectStore(OUTBOX_STORE, { keyPath: 'seq', autoIncrement: true });
        store.createIndex('id', 'id', { unique: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new SyncError('outbox를 열지 못했습니다.', { type: 'unknown', cause: req.error }));
  });
}

async function withOutboxStore(namespace, mode, fn) {
  const db = await openOutboxDb(namespace);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(OUTBOX_STORE, mode);
      const store = tx.objectStore(OUTBOX_STORE);
      const result = fn(store);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(new SyncError('outbox 작업에 실패했습니다.', { type: 'unknown', cause: tx.error }));
    });
  } finally {
    db.close();
  }
}

function genId() {
  return (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
}

/**
 * 실패한 변경을 outbox 큐에 추가합니다.
 * @param {string} namespace - 앱 구분용 이름 (예: 'clip'). 같은 GitHub Pages 오리진을
 *   여러 앱이 공유하므로 앱마다 다른 namespace 를 사용해야 IndexedDB가 섞이지 않습니다.
 * @param {{path:string, content:string, sha?:string, message?:string, branch?:string}} item
 * @returns {Promise<string>} 큐에 들어간 항목의 id
 */
export async function outboxEnqueue(namespace, item) {
  const record = { id: genId(), createdAt: Date.now(), ...item };
  await withOutboxStore(namespace, 'readwrite', (store) => store.add(record));
  return record.id; // seq(정렬 키)는 store.add() 가 내부에서 자동 부여합니다.
}

/**
 * outbox 큐에 추가하되, 같은 path 로 이미 대기 중인 항목이 있으면 먼저 지우고 하나만 남깁니다.
 * 전체 상태를 통째로 저장하는 앱(예: 매번 전체 스냅샷을 쓰는 앱)에 맞는 함수입니다.
 * 옛 대기 항목은 최신 항목으로 어차피 덮어써질 것이므로 큐에 남겨둘 필요가 없고,
 * 그대로 두면 conflict 재시도가 여러 번 반복되며 outboxFlush 를 막을 수 있습니다.
 * @param {string} namespace
 * @param {{path:string, content:string, sha?:string, message?:string, branch?:string}} item
 * @returns {Promise<string>} 큐에 들어간 항목의 id
 */
export async function outboxEnqueueReplace(namespace, item) {
  const record = { id: genId(), createdAt: Date.now(), ...item };
  await withOutboxStore(namespace, 'readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          if (cursor.value.path === item.path) cursor.delete();
          cursor.continue();
        } else {
          store.add(record);
          resolve(record.id);
        }
      };
      req.onerror = () => reject(req.error);
    });
  });
  return record.id;
}

/**
 * @returns {Promise<Array>} 큐에 쌓인 항목 목록 (삽입 순서 = seq 오름차순, cursor 기본 방향).
 */
export async function outboxList(namespace) {
  return withOutboxStore(namespace, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const items = [];
      const req = store.openCursor(); // 기본 방향(next) = seq 오름차순 = 삽입 순서
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          resolve(items);
        }
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/** 큐에서 항목 하나를 id(outboxEnqueue가 돌려준 값)로 제거합니다. */
export async function outboxRemove(namespace, id) {
  await withOutboxStore(namespace, 'readwrite', (store) => {
    return new Promise((resolve, reject) => {
      const req = store.index('id').openCursor(IDBKeyRange.only(id));
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) cursor.delete();
        resolve();
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/**
 * 큐에 쌓인 항목을 순서대로 재전송합니다.
 * 네트워크 실패를 만나면 그 지점에서 멈춰 순서를 보존합니다
 * (뒤 항목이 먼저 성공해 파일 순서가 뒤섞이는 것을 방지).
 * 충돌(409/422)은 최신 sha 를 다시 읽어 한 번만 재시도합니다. 그래도 실패하면
 * 그 자리에서 멈춥니다 (무한 재시도 없음).
 * @param {string} namespace
 * @param {() => Promise<{owner:string, repo:string, token:string, branch?:string}>} resolveConfig
 * @returns {Promise<{flushed:string[], stoppedAt:(object|null), error:(SyncError|null)}>}
 */
export async function outboxFlush(namespace, resolveConfig) {
  const items = await outboxList(namespace);
  const flushed = [];
  for (const item of items) {
    let config;
    try {
      config = await resolveConfig();
      await writeFile(config, item.path, item.content, { sha: item.sha, message: item.message });
      await outboxRemove(namespace, item.id);
      flushed.push(item.id);
      continue;
    } catch (err) {
      const syncErr = err instanceof SyncError ? err : new SyncError(String(err));
      if (syncErr.type === 'conflict' && config) {
        try {
          const fresh = await readFile(config, item.path);
          await writeFile(config, item.path, item.content, { sha: fresh.sha, message: item.message });
          await outboxRemove(namespace, item.id);
          flushed.push(item.id);
          continue;
        } catch (retryErr) {
          const retrySyncErr = retryErr instanceof SyncError ? retryErr : new SyncError(String(retryErr));
          return { flushed, stoppedAt: item, error: retrySyncErr };
        }
      }
      return { flushed, stoppedAt: item, error: syncErr };
    }
  }
  return { flushed, stoppedAt: null, error: null };
}

/**
 * 온라인 상태가 되면 자동으로 outboxFlush 를 호출하도록 등록합니다.
 * 등록하는 시점에 이미 온라인이면(예: 오프라인 상태에서 앱을 껐다가 이미
 * 온라인인 채로 다시 켠 경우) online 이벤트가 따로 발생하지 않으므로
 * 등록 직후에도 한 번 flush를 시도합니다.
 * @returns {() => void} 등록 해제 함수
 */
export function outboxWatch(namespace, resolveConfig, { onFlushed, onError } = {}) {
  const handler = async () => {
    try {
      const result = await outboxFlush(namespace, resolveConfig);
      if (result.error && onError) onError(result.error, result);
      else if (onFlushed) onFlushed(result);
    } catch (err) {
      if (onError) onError(err, null);
    }
  };
  window.addEventListener('online', handler);
  if (typeof navigator !== 'undefined' && navigator.onLine) {
    handler();
  }
  return () => window.removeEventListener('online', handler);
}

/* ── 저장소 컨텍스트 ID ────────────────────────────────────────────────
   iOS Safari 인스턴스와 홈 화면 앱 인스턴스는 같은 기기에서도 localStorage/
   IndexedDB가 분리됩니다. 그래서 "기기 하나 = ID 하나"가 아니라
   "저장소 컨텍스트 하나(=분리된 storage) = ID 하나"로 다룹니다.
   같은 iPhone에서 iphone-safari 와 iphone-app 이 서로 다른 ID를 갖는 것이 정상입니다.
   ────────────────────────────────────────────────────────────────────── */

function contextKey(namespace) {
  return `${namespace}.syncContextId`;
}

function contextLabelKey(namespace) {
  return `${namespace}.syncContextLabel`;
}

// 파일 이름에 들어가는 ID는 영문 소문자와 하이픈만 남깁니다(프로젝트 파일 이름 규칙).
// 사용자에게 보이는 라벨(contextLabelKey에 저장)에는 한글을 그대로 둡니다.
// 한글만 입력하면 여기서 전부 걸러져 빈 문자열이 되고, 'context'로 자동 대체됩니다.
function slugify(label) {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'context';
}

/** 저장된 컨텍스트 ID를 반환합니다. 없으면 null. */
export function getContextId(namespace) {
  return localStorage.getItem(contextKey(namespace));
}

/** 저장된 컨텍스트 라벨(사용자가 붙인 이름)을 반환합니다. 없으면 null. */
export function getContextLabel(namespace) {
  return localStorage.getItem(contextLabelKey(namespace));
}

/**
 * 컨텍스트 ID가 없으면 만듭니다. 있으면 그대로 반환합니다.
 * @param {string} namespace
 * @param {() => (string|Promise<string>)} [promptFn] - 사용자에게 이름을 물어보는 함수.
 *   예: "iPhone Safari", "iPhone 홈 화면 앱". 생략하거나 빈 값을 반환하면 이름 없이 자동 생성합니다.
 * @returns {Promise<string>} 컨텍스트 ID
 */
export async function ensureContextId(namespace, promptFn) {
  const existing = getContextId(namespace);
  if (existing) return existing;

  let label = '';
  if (typeof promptFn === 'function') {
    label = (await promptFn()) || '';
  }
  const id = `${slugify(label || 'context')}-${genId().slice(0, 8)}`;
  localStorage.setItem(contextKey(namespace), id);
  if (label) localStorage.setItem(contextLabelKey(namespace), label);
  return id;
}

/** 컨텍스트 이름을 나중에 바꿀 때 사용합니다 (ID 자체는 유지). */
export function setContextLabel(namespace, label) {
  localStorage.setItem(contextLabelKey(namespace), label);
}

/** 컨텍스트별로 분리된 파일 경로를 만들 때 쓰는 편의 함수. */
export function contextFilePath(basePath, contextId) {
  const dot = basePath.lastIndexOf('.');
  if (dot === -1) return `${basePath}.${contextId}`;
  return `${basePath.slice(0, dot)}.${contextId}${basePath.slice(dot)}`;
}
