const DEFAULT_DB_NAME = "read-book-backup-keyring";
const DEFAULT_STORE_NAME = "dataset-keys";

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}
function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed"));
  });
}

/**
 * Stores only a non-extractable HKDF CryptoKey and public key envelope in IndexedDB.
 * The independent recovery credential is intentionally never persisted here.
 */
export function createBrowserBackupKeyStore({
  indexedDBImpl = globalThis.indexedDB,
  databaseName = DEFAULT_DB_NAME,
  storeName = DEFAULT_STORE_NAME,
} = {}) {
  if (!indexedDBImpl) throw new Error("IndexedDB is unavailable in this browser context");
  let databasePromise;
  function database() {
    if (!databasePromise) {
      databasePromise = new Promise((resolve, reject) => {
        const request = indexedDBImpl.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains(storeName)) db.createObjectStore(storeName, { keyPath: "datasetId" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error || new Error("Could not open backup key store"));
        request.onblocked = () => reject(new Error("Backup key store upgrade is blocked by another tab"));
      });
    }
    return databasePromise;
  }
  return Object.freeze({
    async get(datasetId) {
      const db = await database();
      const tx = db.transaction(storeName, "readonly");
      const done = transactionDone(tx);
      const value = await requestResult(tx.objectStore(storeName).get(datasetId));
      await done;
      return value || null;
    },
    async put(datasetId, state) {
      if (!state?.dataKey || state.dataKey.algorithm?.name !== "HKDF" || state.dataKey.extractable !== false) {
        throw new TypeError("Only a non-extractable HKDF CryptoKey can be stored");
      }
      if (!state.keyEnvelope || typeof state.keyEnvelope.wrappedKey !== "string") {
        throw new TypeError("A wrapped key envelope is required");
      }
      const db = await database();
      const tx = db.transaction(storeName, "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(storeName).put({
        datasetId,
        dataKey: state.dataKey,
        keyEnvelope: state.keyEnvelope,
        lastSnapshot: state.lastSnapshot ?? null,
        lastBackupId: state.lastBackupId ?? null,
        updatedAt: new Date().toISOString(),
      });
      await done;
    },
    async delete(datasetId) {
      const db = await database();
      const tx = db.transaction(storeName, "readwrite");
      const done = transactionDone(tx);
      tx.objectStore(storeName).delete(datasetId);
      await done;
    },
    async close() {
      if (!databasePromise) return;
      const db = await databasePromise;
      db.close();
      databasePromise = null;
    },
  });
}
