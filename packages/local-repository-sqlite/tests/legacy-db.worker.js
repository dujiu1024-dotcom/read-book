import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

self.onmessage = async ({ data }) => {
  try {
    if (data?.type !== "seed-v1") throw new Error("Unknown fixture operation");
    const sqlite3 = await sqlite3InitModule();
    const db = new sqlite3.oo1.OpfsDb("/read-book-user-data-v1.sqlite3");
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
    db.close();
    self.postMessage({ ok: true });
  } catch (error) {
    self.postMessage({ ok: false, error: error?.message || String(error) });
  }
};
