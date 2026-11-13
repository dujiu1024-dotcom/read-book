import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let db;
let sqlite3;

async function initialize() {
  sqlite3 = await sqlite3InitModule();
  if (!('opfs' in sqlite3)) throw new Error('当前浏览器/上下文不支持 SQLite OPFS VFS；为避免双主库，不降级到内存库');
  db = new sqlite3.oo1.OpfsDb('/read-book-poc-a.sqlite3');
  db.exec({ sql: `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS thread (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS message (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES thread(id),
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(thread_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS idx_message_dataset ON message(dataset_id);
  ` });
}

function execute(sql, bind = []) {
  const rows = [];
  db.exec({ sql, bind, rowMode: 'object', resultRows: rows });
  return rows;
}

async function run(count, datasetId) {
  const writeStart = performance.now();
  db.exec({ sql: 'BEGIN IMMEDIATE' });
  try {
    for (let i = 0; i < count; i++) {
      const threadId = datasetId + ':thread:' + (i % 10);
      execute('INSERT OR IGNORE INTO thread(id,dataset_id) VALUES (?,?)', [threadId, datasetId]);
      execute(
        'INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,created_at) VALUES (?,?,?,?,?,?,?)',
        [datasetId + ':' + i, datasetId, threadId, Math.floor(i / 10), i % 2 ? 'assistant' : 'user', '测试消息 ' + i + ' / ' + '知行阅读与思考内容。'.repeat(8), i]
      );
    }
    db.exec({ sql: 'COMMIT' });
  } catch (error) {
    db.exec({ sql: 'ROLLBACK' });
    throw error;
  }
  const writeMs = performance.now() - writeStart;
  const queryStart = performance.now();
  const rows = execute('SELECT COUNT(*) AS count FROM message WHERE dataset_id = ?', [datasetId]);
  const queryMs = performance.now() - queryStart;
  return { adapter: 'SQLite WASM + OPFS', datasetId, count: Number(rows[0].count), writeMs, queryMs, integrity: Number(rows[0].count) === count };
}

function check(datasetId) {
  const integrity = execute('PRAGMA integrity_check');
  const count = execute('SELECT COUNT(*) AS count FROM message WHERE dataset_id = ?', [datasetId]);
  return { adapter: 'SQLite WASM + OPFS', datasetId, count: Number(count[0].count), integrity: integrity[0]?.integrity_check === 'ok', integrityDetail: integrity[0]?.integrity_check };
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      await initialize();
      self.postMessage({ id: data.id, result: { ready: true, sqliteVersion: sqlite3.version.libVersion } });
    } else if (data.type === 'run') {
      self.postMessage({ id: data.id, result: await run(data.count, data.datasetId) });
    } else if (data.type === 'check') {
      self.postMessage({ id: data.id, result: check(data.datasetId) });
    }
  } catch (error) {
    self.postMessage({ id: data.id, error: { name: error.name, message: error.message } });
  }
};
