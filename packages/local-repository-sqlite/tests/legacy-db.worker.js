import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const DB_PATH = "/read-book-user-data-v1.sqlite3";

async function open() {
  const sqlite3 = await sqlite3InitModule();
  return new sqlite3.oo1.OpfsDb(DB_PATH);
}

export function seedV1(db) {
  db.exec({ sql: `
    CREATE TABLE local_dataset (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty_sequence INTEGER NOT NULL DEFAULT 0,
      last_acked_sequence INTEGER NOT NULL DEFAULT 0,
      last_backup_id TEXT,
      last_backup_at TEXT,
      lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active','locally_locked','restore_pending')),
      CHECK(dirty_sequence >= last_acked_sequence AND last_acked_sequence >= 0)
    );
    INSERT INTO local_dataset(
      id,schema_version,created_at,updated_at,dirty_sequence,last_acked_sequence,lifecycle_status
    ) VALUES(
      'legacy-v1-dataset',1,'2026-11-13T00:00:00.000Z','2026-11-13T00:01:00.000Z',7,2,'active'
    );
  ` });
}

// A v5 installation already carries chunk-less citations: the v6 migration must not silently drop them.
export function seedV5Citations(db) {
  db.exec({ sql: `
    PRAGMA foreign_keys = ON;
    CREATE TABLE local_dataset (
      id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      dirty_sequence INTEGER NOT NULL DEFAULT 0,
      last_acked_sequence INTEGER NOT NULL DEFAULT 0,
      last_backup_id TEXT,
      last_backup_at TEXT,
      lifecycle_status TEXT NOT NULL CHECK(lifecycle_status IN ('active','locally_locked','restore_pending')),
      CHECK(dirty_sequence >= last_acked_sequence AND last_acked_sequence >= 0)
    );
    CREATE TABLE thread (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      book_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(dataset_id, book_revision_id)
    );
    CREATE TABLE message (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','assistant')),
      content TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('saved','generating','completed','failed','cancelled')),
      created_at TEXT NOT NULL,
      source_references TEXT NOT NULL DEFAULT '[]',
      idempotency_key TEXT,
      UNIQUE(thread_id, sequence),
      UNIQUE(thread_id, idempotency_key)
    );
    CREATE TABLE citation (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      message_id TEXT NOT NULL REFERENCES message(id),
      book_revision_id TEXT NOT NULL,
      structure_node_id TEXT NOT NULL,
      locator TEXT NOT NULL,
      excerpt TEXT NOT NULL,
      excerpt_hash TEXT,
      created_at TEXT NOT NULL
    );
    INSERT INTO local_dataset(
      id,schema_version,created_at,updated_at,dirty_sequence,last_acked_sequence,lifecycle_status
    ) VALUES(
      'legacy-v5-dataset',5,'2026-11-13T00:00:00.000Z','2026-11-13T00:01:00.000Z',3,0,'active'
    );
    INSERT INTO thread(id,dataset_id,book_revision_id,created_at) VALUES(
      'legacy-v5-thread','legacy-v5-dataset','legacy-v5-book-revision','2026-11-13T00:00:00.000Z'
    );
    INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,status,created_at) VALUES(
      'legacy-v5-user','legacy-v5-dataset','legacy-v5-thread',1,'user','这句话的出处是哪？','saved','2026-11-13T00:00:01.000Z'
    );
    INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,status,created_at) VALUES(
      'legacy-v5-assistant','legacy-v5-dataset','legacy-v5-thread',2,'assistant','出自第一章。','completed','2026-11-13T00:00:02.000Z'
    );
    INSERT INTO citation(id,dataset_id,thread_id,message_id,book_revision_id,structure_node_id,locator,excerpt,excerpt_hash,created_at) VALUES(
      'legacy-citation-1','legacy-v5-dataset','legacy-v5-thread','legacy-v5-assistant','legacy-v5-book-revision','legacy-node-1','epubcfi(/6/4!/4/2)','旧版无切片引文一',NULL,'2026-11-13T00:00:03.000Z'
    );
    INSERT INTO citation(id,dataset_id,thread_id,message_id,book_revision_id,structure_node_id,locator,excerpt,excerpt_hash,created_at) VALUES(
      'legacy-citation-2','legacy-v5-dataset','legacy-v5-thread','legacy-v5-assistant','legacy-v5-book-revision','legacy-node-2','epubcfi(/6/4!/4/6)','旧版无切片引文二','hash-legacy-2','2026-11-13T00:00:04.000Z'
    );
    INSERT INTO citation(id,dataset_id,thread_id,message_id,book_revision_id,structure_node_id,locator,excerpt,excerpt_hash,created_at) VALUES(
      'legacy-citation-3','legacy-v5-dataset','legacy-v5-thread','legacy-v5-user','legacy-v5-book-revision','legacy-node-3','epubcfi(/6/4!/4/8)','旧版无切片引文三',NULL,'2026-11-13T00:00:05.000Z'
    );
    PRAGMA user_version=5;
  ` });
}

export function inspectCitations(db) {
  const tables = db.exec({ sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", rowMode: "object", returnValue: "resultRows" });
  const tableNames = tables.map((row) => row.name);
  const hasLegacy = tableNames.includes("citation_legacy_v5");
  const legacyRows = hasLegacy
    ? db.exec({ sql: "SELECT id,excerpt,excerpt_hash FROM citation_legacy_v5 ORDER BY id", rowMode: "object", returnValue: "resultRows" })
    : [];
  const newCitationColumns = tableNames.includes("citation")
    ? db.exec({ sql: "PRAGMA table_info(citation)", rowMode: "object", returnValue: "resultRows" }).map((row) => row.name)
    : [];
  const newCitationCount = tableNames.includes("citation")
    ? db.exec({ sql: "SELECT COUNT(*) AS count FROM citation", rowMode: "object", returnValue: "resultRows" })[0].count
    : null;
  return {
    userVersion: db.exec({ sql: "PRAGMA user_version", rowMode: "object", returnValue: "resultRows" })[0].user_version,
    legacyRows,
    newCitationColumns,
    newCitationCount,
  };
}

self.onmessage = async ({ data }) => {
  let db;
  try {
    db = await open();
    switch (data?.type) {
      case "seed-v1":
        seedV1(db);
        break;
      case "seed-v5-citations":
        seedV5Citations(db);
        break;
      case "inspect-citations":
        self.postMessage({ ok: true, ...inspectCitations(db) });
        db.close();
        return;
      default:
        throw new Error("Unknown fixture operation");
    }
    db.close();
    self.postMessage({ ok: true });
  } catch (error) {
    db?.close();
    self.postMessage({ ok: false, error: error?.message || String(error) });
  }
};
