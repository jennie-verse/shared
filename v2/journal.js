/* ========================================================================== 
   shared/v2/journal.js
   Date-based journal projection contract and GitHub Contents API writer.

   Source apps must load this module with import() so a journal outage can never
   block their original local save, sync, or events behavior.

   Privacy: authentication is accepted only through resolveConfig(). It is not
   retained in module state or written to the pending queue.
   ========================================================================== */

import { listDir, readFile, writeFile, SyncError } from '../v1/sync.js';

export const JOURNAL_VERSION = 1;
export const JOURNAL_MAX_BYTES = 900_000;
export const JOURNAL_DEBOUNCE_MS = 4_000;
export const JOURNAL_APPS = Object.freeze([
  'tide', 'focus', 'loom', 'petal', 'folio', 'quill', 'slate', 'grove', 'today', 'cove',
]);

export const JOURNAL_KINDS = Object.freeze({
  tide: ['clip', 'dump', 'item-activity'],
  focus: ['session'],
  loom: ['block', 'block-activity'],
  petal: [
    'reading-session',
    'highlight-created', 'highlight-updated',
    'note-created', 'note-updated',
    'bookmark-created',
    'vocabulary-created', 'vocabulary-updated',
  ],
  folio: [
    'file-activity',
    'excerpt-exported',
    'highlight-created', 'highlight-updated',
    'note-created', 'note-updated',
  ],
  quill: ['file-activity'],
  slate: ['board-activity'],
  grove: ['map-activity'],
  today: ['task', 'task-activity'],
  cove: ['link-saved', 'link-activity', 'highlight-created', 'highlight-updated', 'note-created', 'note-updated', 'excerpt-exported'],
});

const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
const CONTEXT_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;
const OFFSET_ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const STATUS_FIELDS = new Set([
  'v', 'app', 'context', 'journalEnabled', 'reportedAt', 'enabledAt',
  'lastSuccessfulWriteAt', 'pendingCount', 'lastErrorCode', 'backfill',
  'contentIncluded', 'redaction',
]);
const BACKFILL_FIELDS = new Set([
  'status', 'from', 'to', 'processedDates', 'totalDates', 'updatedAt',
]);
const REDACTION_FIELDS = new Set([
  'status', 'from', 'to', 'processedDates', 'totalDates', 'updatedAt',
]);
const DB_PREFIX = 'shared-journal-pending-';
const DB_STORE = 'records';

export class JournalError extends Error {
  constructor(message, { type = 'invalid', code = 'JOURNAL_INVALID', cause } = {}) {
    super(message);
    this.name = 'JournalError';
    this.type = type;
    this.code = code;
    if (cause) this.cause = cause;
  }
}

function pad(value) {
  return String(value).padStart(2, '0');
}

export function localDate(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new JournalError('Invalid date.');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function localIso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new JournalError('Invalid timestamp.');
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `.${String(date.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function isDate(value) {
  if (!DATE_RE.test(String(value || ''))) return false;
  const [year, month, day] = value.split('-').map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month - 1
    && parsed.getUTCDate() === day;
}

export function isOffsetIso(value) {
  return OFFSET_ISO_RE.test(String(value || '')) && !Number.isNaN(Date.parse(value));
}

export function validateApp(app) {
  if (!JOURNAL_APPS.includes(app)) throw new JournalError('Unsupported journal app.');
  return app;
}

export function validateContext(context) {
  if (!CONTEXT_RE.test(String(context || ''))) {
    throw new JournalError('Invalid journal context.');
  }
  return context;
}

export function activityPath(app, date, context, part = 1) {
  validateApp(app);
  if (!isDate(date)) throw new JournalError('Invalid journal date.');
  validateContext(context);
  if (!Number.isInteger(part) || part < 1 || part > 99) {
    throw new JournalError('Invalid journal part.');
  }
  return `journal/activity/${app}/${date.slice(0, 7)}/${date}.${context}.p${pad(part)}.json`;
}

export function statusPath(app, context) {
  validateApp(app);
  validateContext(context);
  return `journal/status/${app}/${context}.json`;
}

export function notePath(date, context) {
  if (!isDate(date)) throw new JournalError('Invalid journal date.');
  validateContext(context);
  return `journal/notes/${date.slice(0, 7)}/${date}.${context}.json`;
}

function normalizeText(value) {
  return String(value).normalize('NFC');
}

function normalizeValue(value) {
  if (typeof value === 'string') return normalizeText(value);
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, normalizeValue(child)]));
  }
  return value;
}

export function validateRecord(app, input) {
  validateApp(app);
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new JournalError('Journal record must be an object.');
  }
  const id = normalizeText(input.id || '').trim();
  const kind = String(input.kind || '');
  if (!id || id.length > 512) throw new JournalError('Journal record id is required.');
  if (!JOURNAL_KINDS[app].includes(kind)) throw new JournalError('Unsupported journal record kind.');
  if (!isOffsetIso(input.at) || !isOffsetIso(input.updatedAt)) {
    throw new JournalError('Journal timestamps require an ISO 8601 offset.');
  }
  if (typeof input.title !== 'string') throw new JournalError('Journal record title is required.');
  if (!input.data || typeof input.data !== 'object' || Array.isArray(input.data)) {
    throw new JournalError('Journal record data must be an object.');
  }
  return {
    id,
    kind,
    at: input.at,
    updatedAt: input.updatedAt,
    deleted: input.deleted === true,
    title: normalizeText(input.title),
    data: normalizeValue(input.data),
  };
}

export function validateEnvelope(input, expected = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (input.v !== JOURNAL_VERSION || !JOURNAL_APPS.includes(input.app)) return null;
  if (!CONTEXT_RE.test(String(input.context || '')) || !isDate(input.date)) return null;
  if (!Number.isInteger(input.part) || input.part < 1 || !isOffsetIso(input.updatedAt)) return null;
  if (!Array.isArray(input.records)) return null;
  if (expected.app && input.app !== expected.app) return null;
  if (expected.context && input.context !== expected.context) return null;
  if (expected.date && input.date !== expected.date) return null;
  if (expected.part && input.part !== expected.part) return null;
  try {
    return {
      v: JOURNAL_VERSION,
      app: input.app,
      context: input.context,
      date: input.date,
      part: input.part,
      updatedAt: input.updatedAt,
      records: input.records.map((record) => validateRecord(input.app, record)),
    };
  } catch {
    return null;
  }
}

export function serializedBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function serializeEnvelope(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function envelopeBytes(value) {
  return new TextEncoder().encode(serializeEnvelope(value)).byteLength;
}

function compareVersion(a, b) {
  const time = Date.parse(a.record.updatedAt) - Date.parse(b.record.updatedAt);
  if (time) return time;
  return String(a.path || '').localeCompare(String(b.path || ''));
}

export function mergeRecords(entries, { includeDeleted = false } = {}) {
  const byId = new Map();
  for (const entry of entries) {
    if (!entry || !entry.record) continue;
    const previous = byId.get(entry.record.id);
    if (!previous || compareVersion(previous, entry) <= 0) byId.set(entry.record.id, entry);
  }
  return [...byId.values()]
    .filter((entry) => includeDeleted || entry.record.deleted !== true)
    .sort((a, b) => Date.parse(a.record.at) - Date.parse(b.record.at)
      || a.record.id.localeCompare(b.record.id));
}

export function createMemoryQueue(initial = []) {
  const records = new Map(initial.map((item) => [item.key, structuredClone(item)]));
  return {
    async put(item) { records.set(item.key, structuredClone(item)); },
    async list() { return [...records.values()].map((item) => structuredClone(item)); },
    async remove(keys) { keys.forEach((key) => records.delete(key)); },
    async replace(items) {
      records.clear();
      items.forEach((item) => records.set(item.key, structuredClone(item)));
    },
    async count() { return records.size; },
  };
}

function openPendingDb(namespace) {
  if (typeof indexedDB === 'undefined') {
    throw new JournalError('IndexedDB is unavailable.', { type: 'storage', code: 'JOURNAL_STORAGE' });
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`${DB_PREFIX}${namespace}`, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new JournalError('Journal queue could not be opened.', {
      type: 'storage', code: 'JOURNAL_STORAGE', cause: request.error,
    }));
  });
}

async function pendingTransaction(namespace, mode, callback) {
  const db = await openPendingDb(namespace);
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(DB_STORE, mode);
      const result = callback(transaction.objectStore(DB_STORE));
      transaction.oncomplete = () => resolve(result);
      transaction.onerror = () => reject(new JournalError('Journal queue operation failed.', {
        type: 'storage', code: 'JOURNAL_STORAGE', cause: transaction.error,
      }));
    });
  } finally {
    db.close();
  }
}

export function createIndexedDbQueue(namespace) {
  if (!CONTEXT_RE.test(String(namespace || ''))) throw new JournalError('Invalid queue namespace.');
  return {
    put: (item) => pendingTransaction(namespace, 'readwrite', (store) => store.put(item)),
    list: () => pendingTransaction(namespace, 'readonly', (store) => new Promise((resolve, reject) => {
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })),
    remove: (keys) => pendingTransaction(namespace, 'readwrite', (store) => {
      keys.forEach((key) => store.delete(key));
    }),
    replace: (items) => pendingTransaction(namespace, 'readwrite', (store) => {
      store.clear();
      items.forEach((item) => store.put(item));
    }),
    count: () => pendingTransaction(namespace, 'readonly', (store) => new Promise((resolve, reject) => {
      const request = store.count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })),
  };
}

const defaultIo = Object.freeze({ listDir, readFile, writeFile });

function parsePartName(name, date, context) {
  const escaped = `${date}.${context}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped}\\.p(\\d{2})\\.json$`).exec(name);
  return match ? Number(match[1]) : null;
}

function datesInRange(from, to, maximum = 366) {
  if (!isDate(from) || !isDate(to) || from > to) {
    throw new JournalError('Invalid journal date range.', { code: 'JOURNAL_DATE_RANGE' });
  }
  const dates = [];
  let cursor = new Date(`${from}T12:00:00Z`);
  const end = new Date(`${to}T12:00:00Z`);
  while (cursor <= end) {
    dates.push(cursor.toISOString().slice(0, 10));
    if (dates.length > maximum) {
      throw new JournalError('Journal date range is too large.', { code: 'JOURNAL_DATE_RANGE' });
    }
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return dates;
}

async function loadParts({ io, config, app, date, context }) {
  const dir = `journal/activity/${app}/${date.slice(0, 7)}`;
  const entries = await io.listDir(config, dir);
  const candidates = entries
    .map((entry) => ({ ...entry, part: parsePartName(entry.name, date, context) }))
    .filter((entry) => entry.type === 'file' && Number.isInteger(entry.part))
    .sort((a, b) => a.part - b.part);
  const parts = [];
  for (const entry of candidates) {
    const file = await io.readFile(config, entry.path);
    if (!file.exists) continue;
    let parsed;
    try { parsed = JSON.parse(file.content); } catch { continue; }
    const envelope = validateEnvelope(parsed, { app, context, date, part: entry.part });
    if (envelope) parts.push({ path: entry.path, sha: file.sha, envelope });
  }
  return parts;
}

function emptyPart(app, date, context, part, updatedAt) {
  return { v: JOURNAL_VERSION, app, context, date, part, updatedAt, records: [] };
}

function placeRecords({ app, date, context, parts, records, maxBytes, updatedAt }) {
  const working = parts.map((part) => ({
    ...part,
    original: JSON.stringify(part.envelope),
    envelope: structuredClone(part.envelope),
  }));
  if (!working.length) {
    working.push({ path: activityPath(app, date, context, 1), sha: null,
      envelope: emptyPart(app, date, context, 1, updatedAt), original: null });
  }

  const rejected = [];
  for (const record of records) {
    const single = emptyPart(app, date, context, 1, updatedAt);
    single.records.push(record);
    if (envelopeBytes(single) > maxBytes) {
      rejected.push({ record, code: 'JOURNAL_RECORD_TOO_LARGE' });
      continue;
    }

    let target = null;
    let targetVersion = null;
    for (const part of working) {
      for (const candidate of part.envelope.records) {
        if (candidate.id !== record.id) continue;
        const version = { record: candidate, path: part.path };
        if (!targetVersion || compareVersion(targetVersion, version) <= 0) {
          target = part;
          targetVersion = version;
        }
      }
    }

    if (target) {
      const next = structuredClone(target.envelope);
      next.records = next.records.filter((candidate) => candidate.id !== record.id);
      next.records.push(record);
      next.updatedAt = updatedAt;
      if (envelopeBytes(next) <= maxBytes) {
        target.envelope = next;
        continue;
      }
    }

    let last = working[working.length - 1];
    let next = structuredClone(last.envelope);
    next.records = next.records.filter((candidate) => candidate.id !== record.id);
    next.records.push(record);
    next.updatedAt = updatedAt;
    if (envelopeBytes(next) > maxBytes) {
      const partNumber = last.envelope.part + 1;
      last = { path: activityPath(app, date, context, partNumber), sha: null,
        envelope: emptyPart(app, date, context, partNumber, updatedAt), original: null };
      last.envelope.records.push(record);
      working.push(last);
    } else {
      last.envelope = next;
    }
  }

  const changed = working.filter((part) => part.envelope.records.length > 0
    && JSON.stringify(part.envelope) !== part.original);
  return { changed, rejected };
}

function isConflict(error) {
  return error instanceof SyncError && error.type === 'conflict'
    || error && (error.type === 'conflict' || error.status === 409 || error.status === 422);
}

export async function writeRecordsForDate({
  io = defaultIo, config, app, date, context, records,
  maxBytes = JOURNAL_MAX_BYTES, now = () => new Date(), conflictRetries = 3,
}) {
  validateApp(app);
  validateContext(context);
  if (!isDate(date)) throw new JournalError('Invalid journal date.');
  const validated = records.map((record) => validateRecord(app, record));
  let conflicts = 0;
  while (true) {
    try {
      const parts = await loadParts({ io, config, app, date, context });
      const updatedAt = localIso(now());
      const { changed, rejected } = placeRecords({
        app, date, context, parts, records: validated, maxBytes, updatedAt,
      });
      for (const part of changed) {
        await io.writeFile(config, part.path, serializeEnvelope(part.envelope), {
          ...(part.sha ? { sha: part.sha } : {}),
          message: `journal: update ${app} ${date} p${pad(part.envelope.part)}`,
        });
      }
      return { written: validated.length - rejected.length, rejected, conflicts };
    } catch (error) {
      if (!isConflict(error) || conflicts >= conflictRetries) throw error;
      conflicts += 1;
    }
  }
}

function safeErrorCode(error) {
  if (error && typeof error.code === 'string' && /^[A-Z0-9_-]{1,64}$/.test(error.code)) return error.code;
  if (error && error.type === 'auth') return 'AUTH';
  if (error && error.type === 'network') return 'NETWORK';
  if (isConflict(error)) return 'CONFLICT';
  return 'WRITE_FAILED';
}

export function sanitizeStatus(app, context, input) {
  validateApp(app);
  validateContext(context);
  const output = { v: JOURNAL_VERSION, app, context };
  for (const [key, value] of Object.entries(input || {})) {
    if (!STATUS_FIELDS.has(key) || key === 'v' || key === 'app' || key === 'context') continue;
    if (key === 'backfill' || key === 'redaction') {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const fields = key === 'backfill' ? BACKFILL_FIELDS : REDACTION_FIELDS;
      output[key] = Object.fromEntries(Object.entries(value).filter(([child]) => fields.has(child)));
    } else {
      output[key] = value;
    }
  }
  return output;
}

export async function writeStatus({ io = defaultIo, config, app, context, status, conflictRetries = 3 }) {
  const path = statusPath(app, context);
  const safe = sanitizeStatus(app, context, status);
  let conflicts = 0;
  while (true) {
    try {
      const current = await io.readFile(config, path);
      let existing = {};
      if (current.exists) {
        try { existing = JSON.parse(current.content); } catch { existing = {}; }
      }
      const content = `${JSON.stringify(sanitizeStatus(app, context, { ...existing, ...safe }), null, 2)}\n`;
      await io.writeFile(config, path, content, {
        ...(current.sha ? { sha: current.sha } : {}), message: `journal: report ${app} status`,
      });
      return { conflicts };
    } catch (error) {
      if (!isConflict(error) || conflicts >= conflictRetries) throw error;
      conflicts += 1;
    }
  }
}

export async function readDate({ io = defaultIo, config, app, date }) {
  validateApp(app);
  if (!isDate(date)) throw new JournalError('Invalid journal date.');
  const dir = `journal/activity/${app}/${date.slice(0, 7)}`;
  const diagnostics = [];
  let entries;
  try {
    entries = await io.listDir(config, dir);
  } catch (error) {
    return { app, date, records: [], diagnostics, error };
  }
  const candidates = entries.filter((entry) => entry.type === 'file' && entry.name.startsWith(`${date}.`));
  const records = [];
  for (const entry of candidates) {
    try {
      const file = await io.readFile(config, entry.path);
      const parsed = file.exists ? JSON.parse(file.content) : null;
      const envelope = validateEnvelope(parsed, { app, date });
      if (!envelope) {
        diagnostics.push({ code: 'INVALID_ENVELOPE', path: entry.path });
        continue;
      }
      envelope.records.forEach((record) => records.push({ record, path: entry.path, context: envelope.context }));
    } catch {
      diagnostics.push({ code: 'READ_FAILED', path: entry.path });
    }
  }
  return { app, date, records: mergeRecords(records).map((entry) => entry.record), diagnostics, error: null };
}

export function createJournalClient({
  app, context, namespace = `${app}-journal`, resolveConfig,
  queue = createIndexedDbQueue(namespace), io = defaultIo,
  isEnabled = () => true, debounceMs = JOURNAL_DEBOUNCE_MS,
  now = () => new Date(), onState,
}) {
  validateApp(app);
  validateContext(context);
  if (typeof resolveConfig !== 'function') throw new JournalError('resolveConfig is required.');
  let timer = null;
  let flushing = null;
  const emit = (state) => { if (typeof onState === 'function') onState(state); };

  async function enqueue(record, options = {}) {
    if (!isEnabled()) return { queued: false, reason: 'disabled' };
    const validated = validateRecord(app, record);
    const date = options.date || localDate(validated.at);
    if (!isDate(date)) throw new JournalError('Invalid journal date.');
    const item = { key: `${date}::${validated.id}`, date, record: validated, queuedAt: localIso(now()) };
    await queue.put(item);
    if (options.previousDate && options.previousDate !== date) {
      const tombstone = { ...validated, updatedAt: localIso(now()), deleted: true };
      await queue.put({ key: `${options.previousDate}::${validated.id}`, date: options.previousDate,
        record: tombstone, queuedAt: localIso(now()) });
    }
    schedule();
    const pendingCount = await queue.count();
    emit({ status: 'pending', pendingCount });
    return { queued: true, pendingCount };
  }

  async function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      if (!isEnabled()) return { written: 0, rejected: [], pendingCount: await queue.count() };
      const items = await queue.list();
      if (!items.length) return { written: 0, rejected: [], pendingCount: 0 };
      let config;
      try {
        config = await resolveConfig();
      } catch (error) {
        const pendingCount = await queue.count();
        emit({ status: 'error', pendingCount, errorCode: safeErrorCode(error) });
        return { written: 0, rejected: [], pendingCount, error };
      }
      const groups = new Map();
      items.forEach((item) => {
        if (!groups.has(item.date)) groups.set(item.date, []);
        groups.get(item.date).push(item);
      });
      let written = 0;
      const rejected = [];
      for (const [date, dateItems] of groups) {
        try {
          const result = await writeRecordsForDate({
            io, config, app, date, context, records: dateItems.map((item) => item.record), now,
          });
          written += result.written;
          rejected.push(...result.rejected);
          await queue.remove(dateItems.map((item) => item.key));
        } catch (error) {
          const pendingCount = await queue.count();
          emit({ status: 'error', pendingCount, errorCode: safeErrorCode(error) });
          return { written, rejected, pendingCount, error };
        }
      }
      const pendingCount = await queue.count();
      emit({ status: rejected.length ? 'partial' : 'ready', pendingCount,
        lastSuccessfulWriteAt: localIso(now()) });
      return { written, rejected, pendingCount, error: null };
    })();
    try { return await flushing; } finally { flushing = null; }
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush().catch(() => {}); }, debounceMs);
  }

  const resume = () => flush().catch(() => {});
  if (typeof window !== 'undefined') window.addEventListener('online', resume);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resume();
    });
  }

  return {
    enqueue,
    enqueueMany: async (entries) => {
      const results = [];
      for (const entry of entries) results.push(await enqueue(entry.record || entry, entry.options || {}));
      return results;
    },
    flush,
    pendingCount: () => queue.count(),
    transformPending: async (transform) => {
      if (typeof transform !== 'function') throw new JournalError('Pending transform is required.');
      const items = await queue.list();
      const transformed = [];
      for (const item of items) {
        const nextRecord = await transform(structuredClone(item.record), {
          date: item.date, queuedAt: item.queuedAt,
        });
        if (nextRecord == null) continue;
        transformed.push({ ...item, record: validateRecord(app, nextRecord) });
      }
      if (typeof queue.replace !== 'function') {
        throw new JournalError('Pending queue cannot be transformed safely.', {
          type: 'storage', code: 'JOURNAL_QUEUE_TRANSFORM_UNAVAILABLE',
        });
      }
      await queue.replace(transformed);
      const pendingCount = await queue.count();
      emit({ status: pendingCount ? 'pending' : 'ready', pendingCount });
      return { transformed: transformed.length, removed: items.length - transformed.length, pendingCount };
    },
    redactRange: async ({ from, to, transform }) => {
      if (typeof transform !== 'function') {
        throw new JournalError('Redaction transform is required.', { code: 'JOURNAL_REDACTION_TRANSFORM' });
      }
      const dates = datesInRange(from, to);
      const config = await resolveConfig();
      let processedDates = 0;
      let redactedRecords = 0;
      const status = (state) => writeStatus({
        io, config, app, context,
        status: {
          journalEnabled: isEnabled(),
          redaction: {
            status: state, from, to, processedDates,
            totalDates: dates.length, updatedAt: localIso(now()),
          },
        },
      }).catch(() => {});
      await status('running');
      try {
        for (const date of dates) {
          let parts = [];
          try {
            parts = await loadParts({ io, config, app, date, context });
          } catch (error) {
            if (!(error?.type === 'notfound' || error?.status === 404)) throw error;
          }
          const current = mergeRecords(parts.flatMap((part) => part.envelope.records.map((record) => ({
            record, path: part.path,
          }))));
          for (const entry of current) {
            const original = entry.record;
            const candidate = await transform(structuredClone(original), { date });
            if (!candidate) continue;
            const next = validateRecord(app, {
              ...candidate,
              id: original.id,
              kind: original.kind,
              at: original.at,
              deleted: false,
              updatedAt: localIso(now()),
            });
            await queue.put({
              key: `${date}::${next.id}`, date, record: next, queuedAt: localIso(now()),
            });
            redactedRecords += 1;
          }
          const result = await flush();
          if (result.error) throw result.error;
          processedDates += 1;
        }
        await status('complete');
        return { processedDates, totalDates: dates.length, redactedRecords, pendingCount: await queue.count(), error: null };
      } catch (error) {
        await status('partial');
        emit({ status: 'error', pendingCount: await queue.count(), errorCode: safeErrorCode(error) });
        return { processedDates, totalDates: dates.length, redactedRecords, pendingCount: await queue.count(), error };
      }
    },
    reportStatus: async (status) => writeStatus({
      io, config: await resolveConfig(), app, context,
      status: { ...status, reportedAt: status.reportedAt || localIso(now()), pendingCount: await queue.count() },
    }),
    destroy() {
      if (timer) clearTimeout(timer);
      if (typeof window !== 'undefined') window.removeEventListener('online', resume);
    },
  };
}
