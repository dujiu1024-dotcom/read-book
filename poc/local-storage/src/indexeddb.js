const DB_NAME = 'read-book-poc-a';
const STORE = 'messages';

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

export async function runIndexedDb(count, datasetId) {
  const db = await openDb();
  const writeStart = performance.now();
  try {
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
      tx.onabort = () => reject(tx.error || new Error('事务中止'));
    });
    const writeMs = performance.now() - writeStart;
    const queryStart = performance.now();
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const index = tx.objectStore(STORE).index('datasetId');
      const request = index.getAll(datasetId);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const queryMs = performance.now() - queryStart;
    return { adapter: 'IndexedDB', datasetId, count: rows.length, writeMs, queryMs, integrity: rows.length === count };
  } finally {
    db.close();
  }
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
