import assert from 'node:assert/strict';
import { readFile as readLocalFile } from 'node:fs/promises';
import test from 'node:test';

import {
  JOURNAL_APPS,
  JOURNAL_KINDS,
  activityPath,
  createJournalClient,
  createMemoryQueue,
  isDate,
  isOffsetIso,
  localIso,
  mergeRecords,
  notePath,
  readDate,
  sanitizeStatus,
  serializedBytes,
  statusPath,
  validateEnvelope,
  validateRecord,
  writeRecordsForDate,
} from '../v2/journal.js';

const context = 'fixture-a1b2c3d4';
const date = '2026-08-17';
const now = () => new Date('2026-08-18T02:00:00.000Z');

function focusRecord(overrides = {}) {
  return {
    id: 'session-1',
    kind: 'session',
    at: '2026-08-17T09:00:00-05:00',
    updatedAt: '2026-08-17T09:25:00-05:00',
    deleted: false,
    title: 'Focus session',
    data: { mode: 'focus', subject: 'Fixture only' },
    ...overrides,
  };
}

function folioRecord(overrides = {}) {
  return {
    id: 'annotation-1',
    kind: 'highlight-created',
    at: '2026-08-17T09:00:00-05:00',
    updatedAt: '2026-08-17T09:00:00-05:00',
    deleted: false,
    title: 'Document.pdf',
    data: {
      documentId: 'document-1', documentType: 'pdf', locationLabel: 'p. 12',
      quote: 'Cafe\u0301', note: 'Question', semanticColor: 'question',
    },
    ...overrides,
  };
}

class FakeIo {
  constructor() {
    this.files = new Map();
    this.writes = [];
    this.conflicts = 0;
  }

  async listDir(_config, dir) {
    return [...this.files.entries()]
      .filter(([path]) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map(([path, file]) => ({
        name: path.slice(dir.length + 1), path, sha: file.sha,
        size: new TextEncoder().encode(file.content).byteLength, type: 'file',
      }));
  }

  async readFile(_config, path) {
    const file = this.files.get(path);
    return file
      ? { exists: true, content: file.content, sha: file.sha, size: file.content.length }
      : { exists: false, content: null, sha: null, size: 0 };
  }

  async writeFile(_config, path, content, options = {}) {
    if (this.conflicts > 0) {
      this.conflicts -= 1;
      const error = new Error('fixture conflict');
      error.type = 'conflict';
      error.status = 409;
      throw error;
    }
    const current = this.files.get(path);
    if (current && options.sha !== current.sha) {
      const error = new Error('stale fixture sha');
      error.type = 'conflict';
      error.status = 422;
      throw error;
    }
    const sha = `sha-${this.writes.length + 1}`;
    this.files.set(path, { content, sha });
    this.writes.push({ path, content, options });
    return { sha };
  }
}

test('path builders accept only the eight apps, real dates, safe contexts, and numbered parts', () => {
  assert.deepEqual(JOURNAL_APPS, ['tide', 'focus', 'loom', 'petal', 'folio', 'quill', 'slate', 'grove']);
  assert.equal(activityPath('focus', date, context, 1),
    'journal/activity/focus/2026-08/2026-08-17.fixture-a1b2c3d4.p01.json');
  assert.equal(statusPath('focus', context), 'journal/status/focus/fixture-a1b2c3d4.json');
  assert.equal(notePath(date, 'daybook-a1b2c3d4'),
    'journal/notes/2026-08/2026-08-17.daybook-a1b2c3d4.json');
  assert.equal(isDate('2026-02-29'), false);
  assert.equal(isDate('2028-02-29'), true);
  assert.throws(() => activityPath('vault', date, context, 1));
  assert.throws(() => activityPath('focus', date, '../token', 1));
  assert.throws(() => activityPath('focus', date, context, 0));
});

test('timestamps include an offset and localIso produces a contract timestamp', () => {
  assert.equal(isOffsetIso('2026-08-17T09:00:00-05:00'), true);
  assert.equal(isOffsetIso('2026-08-17T14:00:00'), false);
  assert.equal(isOffsetIso(localIso(new Date())), true);
});

test('fixture and records validate while invalid fields reject the whole envelope', async () => {
  const fixtureUrl = new URL('./fixtures/focus-day.json', import.meta.url);
  const fixture = JSON.parse(await readLocalFile(fixtureUrl, 'utf8'));
  assert.ok(validateEnvelope(fixture, { app: 'focus', date }));
  assert.equal(validateEnvelope({ ...fixture, records: {} }), null);
  assert.equal(validateEnvelope({ ...fixture, app: 'shared' }), null);
  assert.throws(() => validateRecord('focus', focusRecord({ kind: 'clip' })));
  const normalized = validateRecord('focus', focusRecord({ title: 'Cafe\u0301' }));
  assert.equal(normalized.title, 'Café');
});

test('folio annotation kinds validate additively and normalize private text payloads', () => {
  for (const kind of [
    'excerpt-exported', 'highlight-created', 'highlight-updated',
    'note-created', 'note-updated',
  ]) {
    assert.equal(validateRecord('folio', folioRecord({ kind })).kind, kind);
  }
  const normalized = validateRecord('folio', folioRecord());
  assert.equal(normalized.data.quote, 'Café');
  assert.throws(() => validateRecord('quill', folioRecord()));
});

test('Tide and Loom activity kinds extend the contract without changing existing kinds', () => {
  assert.deepEqual(JOURNAL_KINDS.tide, ['clip', 'dump', 'item-activity']);
  assert.deepEqual(JOURNAL_KINDS.loom, ['block', 'block-activity']);
  assert.equal(validateRecord('tide', {
    ...focusRecord(), id: 'clip-1:2026-08-17', kind: 'item-activity',
    data: { activityDate: date, sourceDate: '2026-08-01', actions: ['copied'],
      firstAt: focusRecord().at, lastAt: focusRecord().updatedAt, historyAccuracy: 'exact' },
  }).kind, 'item-activity');
});

test('folio annotations retain the newest update and disappear after a tombstone', () => {
  const created = validateRecord('folio', folioRecord());
  const updated = validateRecord('folio', folioRecord({
    kind: 'highlight-updated',
    updatedAt: '2026-08-17T10:00:00-05:00',
    data: { ...folioRecord().data, note: 'Revised question' },
  }));
  assert.equal(mergeRecords([
    { record: created, path: 'p01' }, { record: updated, path: 'p02' },
  ])[0].record.data.note, 'Revised question');
  const deleted = { ...updated, deleted: true, updatedAt: '2026-08-17T11:00:00-05:00' };
  assert.equal(mergeRecords([
    { record: created, path: 'p01' }, { record: updated, path: 'p02' }, { record: deleted, path: 'p03' },
  ]).length, 0);
});

test('merge picks newest updatedAt, uses path as a deterministic tie-break, and keeps tombstones only on request', () => {
  const old = focusRecord({ title: 'Old' });
  const newer = focusRecord({ title: 'New', updatedAt: '2026-08-17T10:00:00-05:00' });
  const tied = focusRecord({ title: 'Tie wins', updatedAt: newer.updatedAt });
  const merged = mergeRecords([
    { record: old, path: 'a' }, { record: newer, path: 'b' }, { record: tied, path: 'c' },
  ]);
  assert.equal(merged[0].record.title, 'Tie wins');
  const tombstone = { ...tied, deleted: true, updatedAt: '2026-08-17T11:00:00-05:00' };
  assert.equal(mergeRecords([...merged, { record: tombstone, path: 'd' }]).length, 0);
  assert.equal(mergeRecords([...merged, { record: tombstone, path: 'd' }], { includeDeleted: true }).length, 1);
});

test('writer creates p01 and rolls over before the byte limit', async () => {
  const io = new FakeIo();
  const records = [
    focusRecord({ id: 'a', data: { text: 'a'.repeat(220) } }),
    focusRecord({ id: 'b', data: { text: 'b'.repeat(220) } }),
  ];
  const result = await writeRecordsForDate({ io, config: {}, app: 'focus', date, context,
    records, maxBytes: 900, now });
  assert.equal(result.written, 2);
  assert.equal(io.files.size, 2);
  assert.ok(io.files.has(activityPath('focus', date, context, 1)));
  assert.ok(io.files.has(activityPath('focus', date, context, 2)));
  for (const file of io.files.values()) {
    assert.ok(new TextEncoder().encode(file.content).byteLength <= 900);
  }
});

test('writer reloads and retries 409/422 conflicts three times', async () => {
  const io = new FakeIo();
  io.conflicts = 3;
  const result = await writeRecordsForDate({ io, config: {}, app: 'focus', date, context,
    records: [focusRecord()], now });
  assert.equal(result.conflicts, 3);
  assert.equal(result.written, 1);
  io.conflicts = 4;
  await assert.rejects(() => writeRecordsForDate({ io, config: {}, app: 'focus', date, context,
    records: [focusRecord({ id: 'second' })], now }));
});

test('oversize records are rejected without writing source text', async () => {
  const io = new FakeIo();
  const result = await writeRecordsForDate({ io, config: {}, app: 'focus', date, context,
    records: [focusRecord({ data: { text: 'x'.repeat(2_000) } })], maxBytes: 500, now });
  assert.equal(result.written, 0);
  assert.equal(result.rejected[0].code, 'JOURNAL_RECORD_TOO_LARGE');
  assert.equal(io.writes.length, 0);
});

test('status sanitizer excludes token, text, filenames, and full error messages', () => {
  const safe = sanitizeStatus('focus', context, {
    journalEnabled: true, pendingCount: 2, token: 'never-store', title: 'private',
    lastErrorCode: 'NETWORK', errorMessage: 'private path',
    contentIncluded: false,
    backfill: { status: 'running', processedDates: 2, token: 'never-store' },
    redaction: { status: 'partial', from: date, totalDates: 3, note: 'private' },
  });
  assert.equal(safe.token, undefined);
  assert.equal(safe.title, undefined);
  assert.equal(safe.errorMessage, undefined);
  assert.deepEqual(safe.backfill, { status: 'running', processedDates: 2 });
  assert.deepEqual(safe.redaction, { status: 'partial', from: date, totalDates: 3 });
  assert.equal(safe.contentIncluded, false);
  assert.equal(JSON.stringify(safe).includes('never-store'), false);
});

test('pending projections can be sanitized before a later flush', async () => {
  const queue = createMemoryQueue();
  const io = new FakeIo();
  const client = createJournalClient({ app: 'focus', context, queue, io,
    resolveConfig: async () => ({}), debounceMs: 60_000, now });
  await client.enqueue(focusRecord());
  const result = await client.transformPending((record) => ({
    ...record, title: 'Focus session', updatedAt: localIso(now()),
    data: { mode: record.data.mode, contentIncluded: false },
  }));
  assert.equal(result.transformed, 1);
  const [queued] = await queue.list();
  assert.equal(queued.record.data.subject, undefined);
  assert.equal(queued.record.data.contentIncluded, false);
  client.destroy();
});

test('redaction reads only the current context and queues metadata-only replacements', async () => {
  const io = new FakeIo();
  await writeRecordsForDate({ io, config: {}, app: 'focus', date, context,
    records: [focusRecord({ data: { mode: 'focus', subject: 'Private', task: 'Draft', contentIncluded: true } })], now });
  await writeRecordsForDate({ io, config: {}, app: 'focus', date, context: 'other-context',
    records: [focusRecord({ id: 'other', data: { subject: 'Other private content' } })], now });
  const queue = createMemoryQueue();
  const client = createJournalClient({ app: 'focus', context, queue, io,
    resolveConfig: async () => ({}), debounceMs: 60_000,
    now: () => new Date('2026-08-18T03:00:00.000Z') });
  const result = await client.redactRange({ from: date, to: date, transform: (record) => {
    const { subject, task, ...data } = record.data;
    return { ...record, title: 'Focus session', data: { ...data, contentIncluded: false } };
  } });
  assert.equal(result.error, null);
  assert.equal(result.redactedRecords, 1);
  const redacted = await readDate({ io, config: {}, app: 'focus', date });
  const own = redacted.records.find((record) => record.id === 'session-1');
  const other = redacted.records.find((record) => record.id === 'other');
  assert.equal(own.data.subject, undefined);
  assert.equal(own.data.task, undefined);
  assert.equal(own.data.contentIncluded, false);
  assert.equal(other.data.subject, 'Other private content');
});

test('client queue contains projections only and preserves pending work after a write error', async () => {
  const queue = createMemoryQueue();
  const io = new FakeIo();
  const client = createJournalClient({ app: 'focus', context, queue, io,
    resolveConfig: async () => { throw Object.assign(new Error('offline'), { type: 'network' }); },
    debounceMs: 60_000, now });
  await client.enqueue(focusRecord());
  const queued = await queue.list();
  assert.equal(JSON.stringify(queued).includes('token'), false);
  const failed = await client.flush();
  assert.equal(failed.pendingCount, 1);
  assert.equal(await queue.count(), 1);
  client.destroy();
});

test('reader ignores malformed files, merges parts, removes tombstones, and reports diagnostics', async () => {
  const io = new FakeIo();
  const firstPath = activityPath('focus', date, context, 1);
  const secondPath = activityPath('focus', date, context, 2);
  io.files.set(firstPath, { sha: 'one', content: JSON.stringify({
    v: 1, app: 'focus', context, date, part: 1,
    updatedAt: '2026-08-17T10:00:00-05:00', records: [focusRecord()],
  }) });
  io.files.set(secondPath, { sha: 'two', content: JSON.stringify({
    v: 1, app: 'focus', context, date, part: 2,
    updatedAt: '2026-08-17T11:00:00-05:00',
    records: [focusRecord({ deleted: true, updatedAt: '2026-08-17T11:00:00-05:00' })],
  }) });
  io.files.set(`journal/activity/focus/2026-08/${date}.bad.p01.json`, { sha: 'bad', content: '{' });
  const result = await readDate({ io, config: {}, app: 'focus', date });
  assert.equal(result.records.length, 0);
  assert.equal(result.diagnostics.length, 1);
  assert.equal(result.error, null);
});
