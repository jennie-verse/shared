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
  if (meta.content === '' && meta.size > 1000000) {
    // 1MB 초과 파일은 content 가 빈 문자열로 옵니다.
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
        db.createObjectStore(OUTBOX_STORE, { keyPath: 'id' });
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
  return record.id;
}

/** @returns {Promise<Array>} 큐에 쌓인 항목 목록 (생성 순서) */
export async function outboxList(namespace) {
  return withOutboxStore(namespace, 'readonly', (store) => {
    return new Promise((resolve, reject) => {
      const items = [];
      const req = store.openCursor();
      req.onsuccess = () => {
        const cursor = req.result;
        if (cursor) {
          items.push(cursor.value);
          cursor.continue();
        } else {
          resolve(items.sort((a, b) => a.createdAt - b.createdAt));
        }
      };
      req.onerror = () => reject(req.error);
    });
  });
}

/** 큐에서 항목 하나를 제거합니다. */
export async function outboxRemove(namespace, id) {
  await withOutboxStore(namespace, 'readwrite', (store) => store.delete(id));
}

/**
 * 큐에 쌓인 항목을 순서대로 재전송합니다.
 * 네트워크 실패나 충돌을 만나면 그 지점에서 멈춰 순서를 보존합니다
 * (뒤 항목이 먼저 성공해 파일 순서가 뒤섞이는 것을 방지).
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
    } catch (err) {
      return { flushed, stoppedAt: item, error: err instanceof SyncError ? err : new SyncError(String(err)) };
    }
  }
  return { flushed, stoppedAt: null, error: null };
}

/**
 * 온라인 상태가 되면 자동으로 outboxFlush 를 호출하도록 등록합니다.
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

function slugify(label) {
  const s = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
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
