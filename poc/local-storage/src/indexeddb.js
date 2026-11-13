import { withDatasetWriter } from './coordination.js';

const DB_NAME = 'read-book-poc-a';
const STORE = 'messages';
const RUNS = 5;

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('datasetId', 'datasetId');
        store.createIndex('threadSequence', ['threadId', 'sequence'], { unique: true });
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
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const request = tx.objectStore(STORE).index('datasetId').openCursor(IDBKeyRange.only(datasetId));
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('清理事务中止'));
  });
}
async function writeBatch(db, count, datasetId) {
  await clearDataset(db, datasetId);
  const start = performance.now();
  await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    for (let i = 0; i < count; i++) {
      store.put({
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
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index('datasetId').getAll(datasetId);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const queryMs = performance.now() - start;
  const joinStart = performance.now();
  const threadRows = await new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).index('threadSequence')
      .getAll(IDBKeyRange.bound([datasetId + ':thread:0', 0], [datasetId + ':thread:0', Math.ceil(count / 10)]));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return { rows, queryMs, relationQueryMs: performance.now() - joinStart, relationCount: threadRows.length };
}
async function runIndexedDbUnlocked(count, datasetId) {
  const db = await openDb();
  const writeSamples = [], querySamples = [], relationSamples = [];
  let finalCount = 0, relationCount = 0;
  try {
    for (let run = 0; run < RUNS; run++) {
      writeSamples.push(await writeBatch(db, count, datasetId));
      const query = await queryDataset(db, datasetId, count);
      querySamples.push(query.queryMs);
      relationSamples.push(query.relationQueryMs);
      finalCount = query.rows.length;
      relationCount = query.relationCount;
    }
    return {
      adapter: 'IndexedDB', datasetId, count: finalCount, relationCount,
      runs: RUNS, integrity: finalCount === count && relationCount === Math.ceil(count / 10),
      writeMs: { p50: percentile(writeSamples, 0.5), p95: percentile(writeSamples, 0.95), samples: writeSamples },
      queryMs: { p50: percentile(querySamples, 0.5), p95: percentile(querySamples, 0.95), samples: querySamples },
      relationQueryMs: { p50: percentile(relationSamples, 0.5), p95: percentile(relationSamples, 0.95), samples: relationSamples },
      memory: performance.memory?.usedJSHeapSize ?? null
    };
  } finally { db.close(); }
}

export async function checkIndexedDb(datasetId) {
  const db = await openDb();
  try {
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).index('datasetId').getAll(datasetId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    return { adapter: 'IndexedDB', datasetId, count: rows.length, integrity: rows.every((row) => row.datasetId === datasetId) };
  } finally { db.close(); }
}


export async function runIndexedDb(count, datasetId) {
  const coordinated = await withDatasetWriter(datasetId, () => runIndexedDbUnlocked(count, datasetId));
  return { ...coordinated.result, writerCoordination: coordinated.coordination };
}
