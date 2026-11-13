import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

let db;
let sqlite3;
const RUNS = 5;

async function initialize() {
  sqlite3 = await sqlite3InitModule();
  if (!('opfs' in sqlite3)) throw new Error('当前浏览器/上下文不支持 SQLite OPFS VFS；为避免双主库，不降级到内存库');
  db = new sqlite3.oo1.OpfsDb('/read-book-poc-a-v2.sqlite3');
  db.exec({ sql: `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS source (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL, title TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reading_round (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES thread(id),
      sequence INTEGER NOT NULL, UNIQUE(thread_id, sequence)
    );
    CREATE TABLE IF NOT EXISTS note (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES thread(id),
      reading_round_id TEXT NOT NULL REFERENCES reading_round(id),
      source_id TEXT NOT NULL REFERENCES source(id), content TEXT NOT NULL,
      UNIQUE(reading_round_id)
    );
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
      thread_id TEXT NOT NULL REFERENCES thread(id),
      note_id TEXT NOT NULL REFERENCES note(id),
      source_id TEXT NOT NULL REFERENCES source(id), content TEXT NOT NULL,
      UNIQUE(note_id)
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
    CREATE INDEX IF NOT EXISTS idx_source_dataset ON source(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_thread_dataset ON thread(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_round_dataset ON reading_round(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_round_thread ON reading_round(thread_id);
    CREATE INDEX IF NOT EXISTS idx_note_dataset ON note(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_note_source ON note(source_id);
    CREATE INDEX IF NOT EXISTS idx_memory_dataset ON memory(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_memory_thread ON memory(thread_id);
    CREATE INDEX IF NOT EXISTS idx_message_dataset ON message(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_message_thread_sequence ON message(thread_id, sequence);
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
    execute('DELETE FROM memory WHERE dataset_id = ?', [datasetId]);
    execute('DELETE FROM note WHERE dataset_id = ?', [datasetId]);
    execute('DELETE FROM reading_round WHERE dataset_id = ?', [datasetId]);
    execute('DELETE FROM thread WHERE dataset_id = ?', [datasetId]);
    execute('DELETE FROM source WHERE dataset_id = ?', [datasetId]);
    const sourceId = datasetId + ':source:book';
    execute('INSERT INTO source(id,dataset_id,title) VALUES (?,?,?)', [sourceId, datasetId, 'PoC 测试书籍']);
    for (let thread = 0; thread < 10; thread++) {
      const threadId = datasetId + ':thread:' + thread;
      const roundId = datasetId + ':round:' + thread;
      const noteId = datasetId + ':note:' + thread;
      const memoryId = datasetId + ':memory:' + thread;
      execute('INSERT INTO thread(id,dataset_id,title) VALUES (?,?,?)', [threadId, datasetId, 'Thread ' + thread]);
      execute('INSERT INTO reading_round(id,dataset_id,thread_id,sequence) VALUES (?,?,?,?)', [roundId, datasetId, threadId, 1]);
      execute('INSERT INTO note(id,dataset_id,thread_id,reading_round_id,source_id,content) VALUES (?,?,?,?,?,?)', [noteId, datasetId, threadId, roundId, sourceId, '测试笔记 ' + thread]);
      execute('INSERT INTO memory(id,dataset_id,thread_id,note_id,source_id,content) VALUES (?,?,?,?,?,?)', [memoryId, datasetId, threadId, noteId, sourceId, '测试记忆 ' + thread]);
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
    `SELECT COUNT(*) AS count
     FROM message m
     INNER JOIN thread t ON t.id = m.thread_id AND t.dataset_id = m.dataset_id
     INNER JOIN reading_round rr ON rr.thread_id = t.id AND rr.dataset_id = t.dataset_id
     INNER JOIN note n ON n.reading_round_id = rr.id AND n.dataset_id = rr.dataset_id AND n.thread_id = t.id AND n.thread_id = t.id
     INNER JOIN memory mm ON mm.note_id = n.id AND mm.dataset_id = n.dataset_id AND mm.thread_id = t.id AND mm.source_id = n.source_id AND mm.thread_id = t.id AND mm.source_id = n.source_id
     INNER JOIN source s ON s.id = n.source_id AND s.dataset_id = n.dataset_id
     WHERE m.dataset_id = ? AND t.id = ?`,
    [datasetId, datasetId + ':thread:0']
  );
  const relationQueryMs = performance.now() - relationStart;
  const graph = execute(`
    SELECT COUNT(*) AS count FROM thread t
    JOIN reading_round rr ON rr.thread_id = t.id AND rr.dataset_id = t.dataset_id
    JOIN note n ON n.reading_round_id = rr.id AND n.dataset_id = rr.dataset_id AND n.thread_id = t.id
    JOIN memory mm ON mm.note_id = n.id AND mm.dataset_id = n.dataset_id AND mm.thread_id = t.id AND mm.source_id = n.source_id
    JOIN source s ON s.id = n.source_id AND s.dataset_id = n.dataset_id
    WHERE t.dataset_id = ?
  `, [datasetId]);
  return {
    count: Number(rows[0].count), relationCount: Number(relation[0].count),
    relatedThreadCount: Number(graph[0].count), queryMs, relationQueryMs
  };
}
async function run(count, datasetId) {
  const writeSamples = [], querySamples = [], relationSamples = [];
  let finalCount = 0, relationCount = 0, relatedThreadCount = 0;
  for (let run = 0; run < RUNS; run++) {
    writeSamples.push(writeBatch(count, datasetId));
    const result = queryBatch(count, datasetId);
    querySamples.push(result.queryMs);
    relationSamples.push(result.relationQueryMs);
    finalCount = result.count;
    relationCount = result.relationCount;
    relatedThreadCount = result.relatedThreadCount;
  }
  return {
    adapter: 'SQLite WASM + OPFS', datasetId, count: finalCount, relationCount,
    runs: RUNS, integrity: finalCount === count && relationCount === Math.ceil(count / 10) && relatedThreadCount === 10, relatedThreadCount,
    writeMs: { p50: percentile(writeSamples, 0.5), p95: percentile(writeSamples, 0.95), samples: writeSamples },
    queryMs: { p50: percentile(querySamples, 0.5), p95: percentile(querySamples, 0.95), samples: querySamples },
    relationQueryMs: { p50: percentile(relationSamples, 0.5), p95: percentile(relationSamples, 0.95), samples: relationSamples }
  };
}

function check(datasetId) {
  const integrity = execute('PRAGMA integrity_check');
  const count = execute('SELECT COUNT(*) AS count FROM message WHERE dataset_id = ?', [datasetId]);
  const relations = execute(`
    SELECT COUNT(*) AS count FROM message m
    JOIN thread t ON t.id = m.thread_id
    JOIN reading_round rr ON rr.thread_id = t.id AND rr.dataset_id = t.dataset_id
    JOIN note n ON n.reading_round_id = rr.id AND n.dataset_id = rr.dataset_id AND n.thread_id = t.id
    JOIN memory mm ON mm.note_id = n.id AND mm.dataset_id = n.dataset_id AND mm.thread_id = t.id AND mm.source_id = n.source_id
    JOIN source s ON s.id = n.source_id AND s.dataset_id = n.dataset_id
    WHERE m.dataset_id = ?
  `, [datasetId]);
  return {
    adapter: 'SQLite WASM + OPFS', datasetId, count: Number(count[0].count),
    relationCount: Number(relations[0].count),
    integrity: integrity[0]?.integrity_check === 'ok' && Number(relations[0].count) === Number(count[0].count),
    integrityDetail: integrity[0]?.integrity_check
  };
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
