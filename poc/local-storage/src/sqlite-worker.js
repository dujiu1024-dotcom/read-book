import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let db;
let sqlite3;
const RUNS = 5;

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
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}
function writeBatch(count, datasetId) {
  db.exec({ sql: 'BEGIN IMMEDIATE' });
  const start = performance.now();
  try {
    execute('DELETE FROM message WHERE dataset_id = ?', [datasetId]);
    execute('DELETE FROM thread WHERE dataset_id = ?', [datasetId]);
    for (let thread = 0; thread < 10; thread++) {
      execute('INSERT OR IGNORE INTO thread(id,dataset_id) VALUES (?,?)', [datasetId + ':thread:' + thread, datasetId]);
    }
    execute(`
      WITH RECURSIVE seq(i) AS (
        SELECT 0 UNION ALL SELECT i + 1 FROM seq WHERE i < ?
      )
      INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,created_at)
      SELECT ? || ':' || i, ?, ? || ':thread:' || (i % 10), CAST(i / 10 AS INTEGER),
        CASE WHEN i % 2 = 1 THEN 'assistant' ELSE 'user' END,
        '测试消息 ' || i || ' / ' || ?, i
      FROM seq
    `, [count - 1, datasetId, datasetId, datasetId, '知行阅读与思考内容。'.repeat(8)]);
    db.exec({ sql: 'COMMIT' });
  } catch (error) {
    db.exec({ sql: 'ROLLBACK' });
    throw error;
  }
  return performance.now() - start;
}
function queryBatch(count, datasetId) {
  const queryStart = performance.now();
  const rows = execute('SELECT COUNT(*) AS count FROM message WHERE dataset_id = ?', [datasetId]);
  const queryMs = performance.now() - queryStart;
  const relationStart = performance.now();
  const relation = execute(
    'SELECT COUNT(*) AS count FROM message m INNER JOIN thread t ON t.id = m.thread_id AND t.dataset_id = m.dataset_id WHERE m.dataset_id = ? AND t.id = ?',
    [datasetId, datasetId + ':thread:0']
  );
  const relationQueryMs = performance.now() - relationStart;
  return { count: Number(rows[0].count), relationCount: Number(relation[0].count), queryMs, relationQueryMs };
}
async function run(count, datasetId) {
  const writeSamples = [], querySamples = [], relationSamples = [];
  let finalCount = 0, relationCount = 0;
  for (let run = 0; run < RUNS; run++) {
    writeSamples.push(writeBatch(count, datasetId));
    const result = queryBatch(count, datasetId);
    querySamples.push(result.queryMs);
    relationSamples.push(result.relationQueryMs);
    finalCount = result.count;
    relationCount = result.relationCount;
  }
  return {
    adapter: 'SQLite WASM + OPFS', datasetId, count: finalCount, relationCount,
    runs: RUNS, integrity: finalCount === count && relationCount === Math.ceil(count / 10),
    writeMs: { p50: percentile(writeSamples, 0.5), p95: percentile(writeSamples, 0.95), samples: writeSamples },
    queryMs: { p50: percentile(querySamples, 0.5), p95: percentile(querySamples, 0.95), samples: querySamples },
    relationQueryMs: { p50: percentile(relationSamples, 0.5), p95: percentile(relationSamples, 0.95), samples: relationSamples }
  };
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
