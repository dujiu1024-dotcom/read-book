import { withDatasetWriter } from './coordination.js';

const DB_NAME = 'read-book-poc-a';
const RUNS = 5;
const STORES = ['threads', 'messages', 'readingRounds', 'notes', 'memories', 'sources'];

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('threads')) {
        const store = db.createObjectStore('threads', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
      }
      if (!db.objectStoreNames.contains('messages')) {
        const store = db.createObjectStore('messages', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
        store.createIndex('threadSequence', ['threadId', 'sequence'], { unique: true });
      }
      if (!db.objectStoreNames.contains('readingRounds')) {
        const store = db.createObjectStore('readingRounds', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
        store.createIndex('threadId', 'threadId', { unique: true });
      }
      if (!db.objectStoreNames.contains('notes')) {
        const store = db.createObjectStore('notes', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
        store.createIndex('readingRoundId', 'readingRoundId', { unique: true });
        store.createIndex('sourceId', 'sourceId');
      }
      if (!db.objectStoreNames.contains('memories')) {
        const store = db.createObjectStore('memories', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
        store.createIndex('noteId', 'noteId', { unique: true });
        store.createIndex('threadId', 'threadId');
      }
      if (!db.objectStoreNames.contains('sources')) {
        const store = db.createObjectStore('sources', { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('IndexedDB 升级被其他标签页阻塞'));
  });
}
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
async function clearDataset(db, datasetId) {
  for (const storeName of STORES) {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(storeName, 'readwrite');
      const request = tx.objectStore(storeName).index('datasetId').openCursor(IDBKeyRange.only(datasetId));
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('清理事务中止'));
    });
  }
}
async function writeBatch(db, count, datasetId) {
  await clearDataset(db, datasetId);
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORES, 'readwrite');
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
        content: '测试消息 ' + i + ' / ' + '知行阅读与思考内容。'.repeat(8),
        createdAt: i
      });
    }
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('写入事务中止'));
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
        return Boolean(round && note && memory && source);
      }).length;
      const thread = result.threads.find((item) => item.id === threadId);
      const round = result.rounds.find((item) => item.threadId === threadId);
      const note = result.notes.find((item) => item.readingRoundId === round?.id);
      const memory = result.memories.find((item) => item.noteId === note?.id);
      const source = result.sources.find((item) => item.id === note?.sourceId);
      const related = Boolean(thread && round && note && memory && source);
      resolve({ relationCount: related ? result.messages.length : 0, relatedThreadCount });
    };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('关联查询事务中止'));
  });
  return { rows, queryMs, relationQueryMs: performance.now() - joinStart, relationCount: relation.relationCount };
}
async function runIndexedDbUnlocked(count, datasetId) {
  const db = await openDb();
  const writeSamples = [], querySamples = [], relationSamples = [];
  let finalCount = 0, relationCount = 0, relatedThreadCount = 0;
  try {
    for (let run = 0; run < RUNS; run++) {
      writeSamples.push(await writeBatch(db, count, datasetId));
      const query = await queryDataset(db, datasetId, count);
      querySamples.push(query.queryMs);
      relationSamples.push(query.relationQueryMs);
      finalCount = query.rows.length;
      relationCount = query.relationCount;\n      relatedThreadCount = query.relatedThreadCount;
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
export async function runIndexedDb(count, datasetId) {
  const coordinated = await withDatasetWriter(datasetId, () => runIndexedDbUnlocked(count, datasetId));
  return { ...coordinated.result, writerCoordination: coordinated.coordination };
}
export async function checkIndexedDb(datasetId) {
  const db = await openDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction('messages', 'readonly');
      const request = tx.objectStore('messages').index('datasetId').getAll(datasetId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { adapter: 'IndexedDB', datasetId, count: rows.length, integrity: rows.every((row) => row.datasetId === datasetId) };
  } finally { db.close(); }
}
