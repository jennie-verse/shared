import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as sync from '../v1/sync.js';

test('v1 sync keeps the public API consumed by classic and module apps', async () => {
  const names = [
    'readFile', 'writeFile', 'deleteFile', 'listDir', 'utf8ToBase64', 'base64ToUtf8',
    'outboxEnqueue', 'outboxEnqueueReplace', 'outboxList', 'outboxRemove', 'outboxFlush',
    'outboxWatch', 'getContextId', 'getContextLabel', 'ensureContextId', 'setContextLabel',
    'contextFilePath',
  ];
  names.forEach(name => assert.equal(typeof sync[name], 'function', name));
  const globalLoader = await readFile(new URL('../v1/sync-global.js', import.meta.url), 'utf8');
  names.forEach(name => assert.match(globalLoader, new RegExp(`['\"]${name}['\"]`), name));
});

test('v1 UTF-8 transport round-trips consumer data', () => {
  const originalBtoa = globalThis.btoa;
  const originalAtob = globalThis.atob;
  globalThis.btoa = value => Buffer.from(value, 'binary').toString('base64');
  globalThis.atob = value => Buffer.from(value, 'base64').toString('binary');
  try {
    const value = '한글 · portable 🌱';
    assert.equal(sync.base64ToUtf8(sync.utf8ToBase64(value)), value);
  } finally {
    globalThis.btoa = originalBtoa;
    globalThis.atob = originalAtob;
  }
});
