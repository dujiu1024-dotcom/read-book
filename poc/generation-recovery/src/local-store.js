const DB = 'read-book-poc-d';
const VERSION = 1;
function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('messages')) db.createObjectStore('messages', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'idempotencyKey' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function write(storeName, value) {
  const db = await openDb();
  try { await new Promise((resolve, reject) => { const tx = db.transaction(storeName, 'readwrite'); tx.objectStore(storeName).put(value); tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); }); }
  finally { db.close(); }
}
async function readAll(storeName) {
  const db = await openDb();
  try { return await new Promise((resolve, reject) => { const tx = db.transaction(storeName, 'readonly'); const request = tx.objectStore(storeName).getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); }); }
  finally { db.close(); }
}
export const saveMessage = (message) => write('messages', message);
export const saveJob = (job) => write('jobs', job);
export const listMessages = () => readAll('messages');
export const listJobs = () => readAll('jobs');
