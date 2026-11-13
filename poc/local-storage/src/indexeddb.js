import { withDatasetWriter } from './coordination.js';

const DB_NAME = 'read-book-poc-a';
const DB_VERSION = 3;
const RUNS = 5;
const LONG_TEXT = '长文本'.repeat(16384);
const STORES = ['threads', 'messages', 'readingRounds', 'notes', 'memories', 'sources'];

function ensureStore(db, transaction, name, indexes) {
  const store = db.objectStoreNames.contains(name)
    ? transaction.objectStore(name)
    : db.createObjectStore(name, { keyPath: 'id' });
  for (const [indexName, keyPath, options] of indexes) {
    if (!store.indexNames.contains(indexName)) store.createIndex(indexName, keyPath, options || {});
  }
}
function upgradeSchema(db, transaction) {
  ensureStore(db, transaction, 'threads', [
    ['datasetId', 'datasetId']
  ]);
  ensureStore(db, transaction, 'messages', [
    ['datasetId', 'datasetId'],
    ['threadSequence', ['threadId', 'sequence'], { unique: true }]
  ]);
  ensureStore(db, transaction, 'readingRounds', [
    ['datasetId', 'datasetId'],
    ['threadId', 'threadId', { unique: true }]
  ]);
  ensureStore(db, transaction, 'notes', [
    ['datasetId', 'datasetId'],
    ['readingRoundId', 'readingRoundId', { unique: true }],
    ['sourceId', 'sourceId']
  ]);
  ensureStore(db, transaction, 'memories', [
    ['datasetId', 'datasetId'],
    ['noteId', 'noteId', { unique: true }],
    ['threadId', 'threadId']
  ]);
  ensureStore(db, transaction, 'sources', [
    ['datasetId', 'datasetId']
  ]);
}
function openDb(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION);
    request.onupgradeneeded = () => upgradeSchema(request.result, request.transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB 升级被其他标签页阻塞'));
  });
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function clearDatasetInTransaction(tx, datasetId, onCleared) {
  let remaining = STORES.length;
  for (const storeName of STORES) {
    const request = tx.objectStore(storeName).index('datasetId').openCursor(IDBKeyRange.only(datasetId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
        return;
      }
      remaining -= 1;
      if (remaining === 0) onCleared();
    };
  }
}
function enqueueDatasetWrites(tx, count, datasetId) {
  const threads = tx.objectStore('threads');
  const messages = tx.objectStore('messages');
  const rounds = tx.objectStore('readingRounds');
  const notes = tx.objectStore('notes');
  const memories = tx.objectStore('memories');
  const sources = tx.objectStore('sources');
  const sourceId = datasetId + ':source:book';
  sources.put({ id: sourceId, datasetId, title: 'PoC 测试书籍' });
  for (let thread = 0; thread < 10; thread++) {
    const threadId = datasetId + ':thread:' + thread;
    const roundId = datasetId + ':round:' + thread;
    const noteId = datasetId + ':note:' + thread;
    const memoryId = datasetId + ':memory:' + thread;
    threads.put({ id: threadId, datasetId, title: 'Thread ' + thread });
    rounds.put({ id: roundId, datasetId, threadId, sequence: 1 });
    notes.put({ id: noteId, datasetId, threadId, readingRoundId: roundId, sourceId, content: '测试笔记 ' + thread });
    memories.put({ id: memoryId, datasetId, threadId, noteId, sourceId, content: '测试记忆 ' + thread });
  }
  for (let i = 0; i < count; i++) {
    messages.put({
      id: datasetId + ':' + i,
      datasetId,
      threadId: datasetId + ':thread:' + (i % 10),
      sequence: Math.floor(i / 10),
      role: i % 2 ? 'assistant' : 'user',
      content: i === 0 ? LONG_TEXT : '测试消息 ' + i + ' / ' + '知行阅读与思考内容。'.repeat(8),
      createdAt: i
    });
  }
}
async function writeBatch(db, count, datasetId, failureInjection) {
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readwrite');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入事务中止'));
    clearDatasetInTransaction(tx, datasetId, () => {
      if (failureInjection === 'abort-after-clear') {
        tx.abort();
        return;
      }
      enqueueDatasetWrites(tx, count, datasetId);
    });
  });
  return performance.now() - start;
}
async function queryDataset(db, datasetId, count) {
  const start = performance.now();
  const rows = await new Promise((resolve, reject) => {
    const tx = db.transaction('messages', 'readonly');
    const request = tx.objectStore('messages').index('datasetId').getAll(datasetId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const queryMs = performance.now() - start;
  const joinStart = performance.now();
  const relation = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readonly');
    const threadId = datasetId + ':thread:0';
    const requests = {
      messages: tx.objectStore('messages').index('threadSequence')
        .getAll(IDBKeyRange.bound([threadId, 0], [threadId, Math.ceil(count / 10)])),
      threads: tx.objectStore('threads').index('datasetId').getAll(datasetId),
      rounds: tx.objectStore('readingRounds').index('datasetId').getAll(datasetId),
      notes: tx.objectStore('notes').index('datasetId').getAll(datasetId),
      memories: tx.objectStore('memories').index('datasetId').getAll(datasetId),
      sources: tx.objectStore('sources').index('datasetId').getAll(datasetId)
    };
    const result = {};
    for (const [key, request] of Object.entries(requests)) request.onsuccess = () => { result[key] = request.result; };
    tx.oncomplete = () => {
      const relatedThreadCount = result.threads.filter((thread) => {
        const round = result.rounds.find((item) => item.threadId === thread.id);
        const note = result.notes.find((item) => item.readingRoundId === round?.id);
        const memory = result.memories.find((item) => item.noteId === note?.id);
        const source = result.sources.find((item) => item.id === note?.sourceId);
        return Boolean(round && note?.threadId === thread.id && memory?.threadId === thread.id && memory?.sourceId === note.sourceId && source);
      }).length;
      const thread = result.threads.find((item) => item.id === threadId);
      const round = result.rounds.find((item) => item.threadId === threadId);
      const note = result.notes.find((item) => item.readingRoundId === round?.id);
      const memory = result.memories.find((item) => item.noteId === note?.id);
      const source = result.sources.find((item) => item.id === note?.sourceId);
      const related = Boolean(thread && round && note?.threadId === thread.id && memory?.threadId === thread.id && memory?.sourceId === note.sourceId && source);
      resolve({ relationCount: related ? result.messages.length : 0, relatedThreadCount });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('关联查询事务中止'));
  });
  return { rows, queryMs, relationQueryMs: performance.now() - joinStart, relationCount: relation.relationCount, relatedThreadCount: relation.relatedThreadCount };
}
async function runIndexedDbUnlocked(count, datasetId, failureInjection) {
  const db = await openDb();
  const writeSamples = [], querySamples = [], relationSamples = [];
  let finalCount = 0, relationCount = 0, relatedThreadCount = 0;
  try {
    for (let run = 0; run < RUNS; run++) {
      writeSamples.push(await writeBatch(db, count, datasetId, failureInjection));
      const query = await queryDataset(db, datasetId, count);
      querySamples.push(query.queryMs);
      relationSamples.push(query.relationQueryMs);
      finalCount = query.rows.length;
      relationCount = query.relationCount;
      relatedThreadCount = query.relatedThreadCount;
    }
    return {
      adapter: 'IndexedDB', datasetId, count: finalCount, relationCount,
      runs: RUNS, integrity: finalCount === count && relationCount === Math.ceil(count / 10) && relatedThreadCount === 10, relatedThreadCount,
      writeMs: { p50: percentile(writeSamples, 0.5), p95: percentile(writeSamples, 0.95), samples: writeSamples },
      queryMs: { p50: percentile(querySamples, 0.5), p95: percentile(querySamples, 0.95), samples: querySamples },
      relationQueryMs: { p50: percentile(relationSamples, 0.5), p95: percentile(relationSamples, 0.95), samples: relationSamples },
      memory: performance.memory?.usedJSHeapSize ?? null
    };
  } finally { db.close(); }
}
export async function runIndexedDb(count, datasetId, options = {}) {
  const coordinated = await withDatasetWriter(datasetId, () => runIndexedDbUnlocked(count, datasetId, options.failureInjection));
  return { ...coordinated.result, writerCoordination: coordinated.coordination };
}
export async function checkIndexedDb(datasetId) {
  const db = await openDb();
  try {
    const result = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORES, 'readonly');
      const requests = Object.fromEntries(STORES.map((name) => [
        name,
        tx.objectStore(name).index('datasetId').getAll(datasetId)
      ]));
      tx.oncomplete = () => {
        const data = Object.fromEntries(Object.entries(requests).map(([name, request]) => [name, request.result]));
        const threads = new Map(data.threads.map((item) => [item.id, item]));
        const rounds = new Map(data.readingRounds.map((item) => [item.id, item]));
        const notes = new Map(data.notes.map((item) => [item.id, item]));
        const sources = new Map(data.sources.map((item) => [item.id, item]));
        const memories = new Map(data.memories.map((item) => [item.noteId, item]));
        const threadChains = data.threads.map((thread) => {
          const round = data.readingRounds.find((item) => item.threadId === thread.id);
          const note = data.notes.find((item) => item.readingRoundId === round?.id);
          const memory = memories.get(note?.id);
          const source = sources.get(note?.sourceId);
          return Boolean(
            round && rounds.has(round.id) &&
            note && notes.has(note.id) && note.threadId === thread.id &&
            memory && memory.threadId === thread.id && memory.sourceId === note.sourceId &&
            source && source.datasetId === datasetId
          );
        });
        const messagesValid = data.messages.every((message) =>
          message.datasetId === datasetId && threads.has(message.threadId)
        );
        const longTextIntegrity = data.messages.some((message) =>
          message.id === datasetId + ':0' && message.content === LONG_TEXT
        );
        const integrity = longTextIntegrity && data.threads.length === 10 &&
          data.readingRounds.length === 10 &&
          data.notes.length === 10 &&
          data.memories.length === 10 &&
          data.sources.length === 1 &&
          threadChains.every(Boolean) && messagesValid;
        resolve({
          adapter: 'IndexedDB', datasetId, count: data.messages.length,
          entityCounts: {
            threads: data.threads.length, messages: data.messages.length,
            readingRounds: data.readingRounds.length, notes: data.notes.length,
            memories: data.memories.length, sources: data.sources.length
          },
          relatedThreadCount: threadChains.filter(Boolean).length,
          longTextIntegrity,
          integrity
        });
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('完整性检查事务中止'));
    });
    return result;
  } finally { db.close(); }
}

export async function runMigrationProbe() {
  const name = DB_NAME + '-migration-' + crypto.randomUUID();
  let db;
  try {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => {
        const legacy = request.result;
        const threads = legacy.createObjectStore('threads', { keyPath: 'id' });
        threads.createIndex('datasetId', 'datasetId');
        const messages = legacy.createObjectStore('messages', { keyPath: 'id' });
        messages.createIndex('datasetId', 'datasetId');
        messages.createIndex('threadSequence', ['threadId', 'sequence'], { unique: true });
      };
      request.onsuccess = () => {
        const legacy = request.result;
        const tx = legacy.transaction(['threads', 'messages'], 'readwrite');
        tx.objectStore('threads').put({ id: 'legacy-thread', datasetId: 'legacy', title: 'Legacy Thread' });
        tx.objectStore('messages').put({
          id: 'legacy-message', datasetId: 'legacy', threadId: 'legacy-thread',
          sequence: 0, role: 'user', content: '迁移前原文', createdAt: 1
        });
        tx.oncomplete = () => { legacy.close(); resolve(); };
        tx.onerror = () => { legacy.close(); reject(tx.error); };
        tx.onabort = () => { legacy.close(); reject(tx.error || new Error('迁移夹具创建中止')); };
      };
      request.onerror = () => reject(request.error);
    });
    db = await openDb(name);
    const migrated = await new Promise((resolve, reject) => {
      const tx = db.transaction(['threads', 'messages'], 'readonly');
      const threadRequest = tx.objectStore('threads').get('legacy-thread');
      const messageRequest = tx.objectStore('messages').get('legacy-message');
      tx.oncomplete = () => resolve({
        thread: threadRequest.result,
        message: messageRequest.result,
        stores: [...db.objectStoreNames],
        messageIndexes: [...tx.db.transaction('messages').objectStore('messages').indexNames]
      });
      tx.onerror = () => reject(tx.error);
    });
    const expectedStores = STORES.every((store) => migrated.stores.includes(store));
    const expectedIndexes = ['datasetId', 'threadSequence'].every((index) => migrated.messageIndexes.includes(index));
    return {
      adapter: 'IndexedDB', migration: 'v1-to-v3',
      legacyThreadPreserved: migrated.thread?.title === 'Legacy Thread',
      legacyMessagePreserved: migrated.message?.content === '迁移前原文',
      expectedStores, expectedIndexes,
      integrity: migrated.thread?.title === 'Legacy Thread' &&
        migrated.message?.content === '迁移前原文' && expectedStores && expectedIndexes
    };
  } finally {
    db?.close();
    await new Promise((resolve) => {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = resolve;
      request.onerror = resolve;
      request.onblocked = resolve;
    });
  }
}
