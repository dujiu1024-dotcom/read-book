import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

let sqlite3;
let db;
let activeDatasetId = null;
let transactionDirty = false;

function execute(sql, bind = []) {
  const rows = [];
  db.exec({ sql, bind, rowMode: "object", resultRows: rows });
  return rows;
}
function first(sql, bind = []) { return execute(sql, bind)[0] ?? null; }
function parseJson(value, fallback = []) {
  if (value == null) return fallback;
  try { return JSON.parse(value); } catch { throw new Error("数据库 JSON 字段损坏"); }
}
function ensureDataset(datasetId) {
  if (typeof datasetId !== "string" || !datasetId.trim()) throw new Error("datasetId 非法");
  execute(
    "INSERT OR IGNORE INTO local_dataset(id,schema_version,created_at,updated_at,dirty_sequence,last_acked_sequence,lifecycle_status) VALUES(?,6,?,?,0,0,'active')",
    [datasetId, new Date().toISOString(), new Date().toISOString()],
  );
  const dataset = first("SELECT * FROM local_dataset WHERE id=?", [datasetId]);
  if (!dataset || dataset.lifecycle_status !== "active") throw new Error("数据集不存在或当前不可写");
}
async function initialize() {
  if (db) return;
  sqlite3 = await sqlite3InitModule();
  if (!sqlite3.oo1?.OpfsDb) {
    throw new Error("当前浏览器 Worker 不支持 SQLite OPFS VFS；为避免双主库，不降级到内存数据库。");
  }
  db = new sqlite3.oo1.OpfsDb("/read-book-user-data-v1.sqlite3");
  db.exec({ sql: `
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS local_dataset (
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
    CREATE TABLE IF NOT EXISTS account_dataset_binding (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      account_id TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','inactive','revoked')),
      bound_at TEXT NOT NULL,
      last_selected_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_binding_dataset ON account_dataset_binding(dataset_id);
    CREATE INDEX IF NOT EXISTS idx_binding_account ON account_dataset_binding(account_id);
    CREATE TABLE IF NOT EXISTS binding_authorization (
      id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL REFERENCES account_dataset_binding(id),
      authorization_payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS thread (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      book_revision_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(dataset_id, book_revision_id)
    );
    CREATE TABLE IF NOT EXISTS message (
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
    CREATE INDEX IF NOT EXISTS idx_message_dataset_thread ON message(dataset_id,thread_id,sequence);
    CREATE TABLE IF NOT EXISTS reading_round (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      round_number INTEGER NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','completed','abandoned')),
      started_at TEXT NOT NULL,
      completed_at TEXT,
      UNIQUE(thread_id, round_number)
    );
    CREATE TABLE IF NOT EXISTS reading_position (
      thread_id TEXT PRIMARY KEY REFERENCES thread(id),
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      mainline_node_id TEXT NOT NULL,
      displayed_node_id TEXT NOT NULL,
      view_mode TEXT NOT NULL CHECK(view_mode IN ('mainline','temporary','review','citation')),
      current_unit_discussed INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS presented_source (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      book_revision_id TEXT NOT NULL,
      structure_node_id TEXT NOT NULL,
      chunk_id TEXT,
      presentation_type TEXT NOT NULL CHECK(presentation_type IN ('mainline','review','temporary','citation')),
      reading_round_id TEXT REFERENCES reading_round(id),
      presented_at TEXT NOT NULL,
      source_locator TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_presented_source_thread ON presented_source(dataset_id,thread_id,presented_at);
    CREATE INDEX IF NOT EXISTS idx_presented_source_round ON presented_source(dataset_id,reading_round_id,structure_node_id);
    CREATE TABLE IF NOT EXISTS reading_unit_progress (
      reading_round_id TEXT NOT NULL REFERENCES reading_round(id),
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      structure_node_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('not_presented','presented','awaiting_user','discussion_active','discussed','skipped')),
      first_presented_source_id TEXT REFERENCES presented_source(id),
      last_activity_message_id TEXT REFERENCES message(id),
      completed_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(reading_round_id,structure_node_id)
    );
    CREATE INDEX IF NOT EXISTS idx_reading_unit_progress_thread ON reading_unit_progress(dataset_id,thread_id,reading_round_id,status);
    CREATE TABLE IF NOT EXISTS citation (
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
    CREATE TABLE IF NOT EXISTS note (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      reading_round_id TEXT REFERENCES reading_round(id),
      content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      source_references TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision >= 1)
    );
    CREATE TABLE IF NOT EXISTS memory (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      thread_id TEXT NOT NULL REFERENCES thread(id),
      current_version_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_version (
      id TEXT PRIMARY KEY,
      dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
      memory_id TEXT NOT NULL REFERENCES memory(id),
      version INTEGER NOT NULL,
      previous_version_id TEXT,
      change_kind TEXT NOT NULL CHECK(change_kind IN ('new','supplement','correction','conflict','rejection','extension')),
      content TEXT NOT NULL,
      source_message_ids TEXT NOT NULL,
      source_references TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(memory_id, version)
    );
  ` });

  // Existing installations have the v1 schema and no PRAGMA user_version marker.
  // Treat version 0 as the shipped v1 baseline, then migrate atomically to v2.
  const storedVersion = Number(first("PRAGMA user_version")?.user_version ?? 0);
  if (storedVersion > 6) throw new Error("数据库版本高于当前客户端，已阻止降级写入");
  if (storedVersion < 2) {
    db.exec({ sql: "BEGIN IMMEDIATE" });
    try {
      db.exec({ sql: `
        CREATE TABLE IF NOT EXISTS memory_relation (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
          from_version_id TEXT NOT NULL REFERENCES memory_version(id),
          to_version_id TEXT NOT NULL REFERENCES memory_version(id),
          relation_type TEXT NOT NULL CHECK(relation_type IN ('supports','contradicts','extends','supersedes','retracts','duplicate_of')),
          source_message_ids TEXT NOT NULL,
          source_references TEXT NOT NULL,
          created_at TEXT NOT NULL,
          CHECK(from_version_id <> to_version_id)
        );
        CREATE INDEX IF NOT EXISTS idx_memory_relation_from ON memory_relation(dataset_id,from_version_id);
        CREATE INDEX IF NOT EXISTS idx_memory_relation_to ON memory_relation(dataset_id,to_version_id);
        UPDATE local_dataset SET schema_version=2;
        PRAGMA user_version=2;
      ` });
      db.exec({ sql: "COMMIT" });
    } catch (error) {
      db.exec({ sql: "ROLLBACK" });
      throw new Error("数据库 Schema v2 迁移失败，已回滚", { cause: error });
    }
  }
  if (storedVersion < 3) {
    db.exec({ sql: "BEGIN IMMEDIATE" });
    try {
      db.exec({ sql: `
        CREATE TABLE IF NOT EXISTS generation_delivery (
          client_generation_id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
          generation_id TEXT UNIQUE,
          thread_id TEXT NOT NULL REFERENCES thread(id),
          user_message_id TEXT NOT NULL REFERENCES message(id),
          assistant_message_id TEXT NOT NULL REFERENCES message(id),
          idempotency_key TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed','cancelled','expired')),
          last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
          last_event_id TEXT,
          expires_at TEXT,
          updated_at TEXT NOT NULL,
          UNIQUE(dataset_id,idempotency_key)
        );
        CREATE INDEX IF NOT EXISTS idx_generation_delivery_pending ON generation_delivery(dataset_id,thread_id,status,updated_at);
        UPDATE local_dataset SET schema_version=3;
        PRAGMA user_version=3;
      ` });
      db.exec({ sql: "COMMIT" });
    } catch (error) {
      db.exec({ sql: "ROLLBACK" });
      throw new Error("数据库 Schema v3 迁移失败，已回滚", { cause: error });
    }
  }
  if (storedVersion < 4) {
    db.exec({ sql: "BEGIN IMMEDIATE" });
    try {
      db.exec({ sql: `
        ALTER TABLE memory_version ADD COLUMN title TEXT NOT NULL DEFAULT '';
        ALTER TABLE memory_version ADD COLUMN viewpoint TEXT NOT NULL DEFAULT 'user' CHECK(viewpoint IN ('user','author','assistant_inference'));
        ALTER TABLE memory_version ADD COLUMN confidence REAL NOT NULL DEFAULT 1 CHECK(confidence >= 0 AND confidence <= 1);
        ALTER TABLE memory_version ADD COLUMN ambiguity REAL NOT NULL DEFAULT 0 CHECK(ambiguity >= 0 AND ambiguity <= 1);
        ALTER TABLE memory_version ADD COLUMN evaluation_score REAL NOT NULL DEFAULT 0 CHECK(evaluation_score >= 0 AND evaluation_score <= 1);
        UPDATE local_dataset SET schema_version=4;
        PRAGMA user_version=4;
      ` });
      db.exec({ sql: "COMMIT" });
    } catch (error) {
      db.exec({ sql: "ROLLBACK" });
      throw new Error("数据库 Schema v4 迁移失败，已回滚", { cause: error });
    }
  }
  if (storedVersion < 5) {
    db.exec({ sql: "BEGIN IMMEDIATE" });
    try {
      db.exec({ sql: "CREATE TABLE IF NOT EXISTS memory_candidate (id TEXT PRIMARY KEY,dataset_id TEXT NOT NULL REFERENCES local_dataset(id),thread_id TEXT NOT NULL REFERENCES thread(id),candidate_json TEXT NOT NULL,evaluation_score REAL NOT NULL CHECK(evaluation_score >= 0 AND evaluation_score <= 1),status TEXT NOT NULL CHECK(status IN ('needs_confirmation','accepted','rejected')),created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(dataset_id,thread_id,id)); CREATE INDEX IF NOT EXISTS idx_memory_candidate_pending ON memory_candidate(dataset_id,thread_id,status,created_at); UPDATE local_dataset SET schema_version=5; PRAGMA user_version=5;" });
      db.exec({ sql: "COMMIT" });
    } catch (error) {
      db.exec({ sql: "ROLLBACK" });
      throw new Error("数据库 Schema v5 迁移失败，已回滚", { cause: error });
    }
  }
  if (storedVersion < 6) {
    db.exec({ sql: "BEGIN IMMEDIATE" });
    try {
      db.exec({ sql: `
        CREATE TABLE IF NOT EXISTS presented_source (
          id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
          thread_id TEXT NOT NULL REFERENCES thread(id),
          book_revision_id TEXT NOT NULL,
          structure_node_id TEXT NOT NULL,
          chunk_id TEXT,
          presentation_type TEXT NOT NULL CHECK(presentation_type IN ('mainline','review','temporary','citation')),
          reading_round_id TEXT REFERENCES reading_round(id),
          presented_at TEXT NOT NULL,
          source_locator TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_presented_source_thread ON presented_source(dataset_id,thread_id,presented_at);
        CREATE INDEX IF NOT EXISTS idx_presented_source_round ON presented_source(dataset_id,reading_round_id,structure_node_id);
        CREATE TABLE IF NOT EXISTS reading_unit_progress (
          reading_round_id TEXT NOT NULL REFERENCES reading_round(id),
          dataset_id TEXT NOT NULL REFERENCES local_dataset(id),
          thread_id TEXT NOT NULL REFERENCES thread(id),
          structure_node_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('not_presented','presented','awaiting_user','discussion_active','discussed','skipped')),
          first_presented_source_id TEXT REFERENCES presented_source(id),
          last_activity_message_id TEXT REFERENCES message(id),
          completed_at TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY(reading_round_id,structure_node_id)
        );
        CREATE INDEX IF NOT EXISTS idx_reading_unit_progress_thread ON reading_unit_progress(dataset_id,thread_id,reading_round_id,status);
        UPDATE local_dataset SET schema_version=6;
        PRAGMA user_version=6;
      ` });
      db.exec({ sql: "COMMIT" });
    } catch (error) {
      db.exec({ sql: "ROLLBACK" });
      throw new Error("数据库 Schema v6 迁移失败，已回滚", { cause: error });
    }
  }
}
function assertDataset(datasetId) {
  if (!activeDatasetId || datasetId !== activeDatasetId) throw new Error("事务 datasetId 不匹配");
}
function assertSourceReferences(datasetId, threadId, references = []) {
  const thread = first("SELECT book_revision_id FROM thread WHERE id=? AND dataset_id=?", [threadId,datasetId]);
  if (!thread) throw new Error("来源 Thread 不属于当前数据集");
  for (const reference of references) {
    if (
      !reference.bookRevisionId ||
      reference.bookRevisionId !== thread.book_revision_id ||
      !reference.structureNodeId ||
      !reference.locator
    ) throw new Error("原文来源必须绑定当前 BookRevision 并包含结构节点和定位");
  }
  return thread;
}
function rowToMessage(row) {
  return {
    message: {
      id: row.id, threadId: row.thread_id, role: row.role, content: row.content,
      status: row.status, createdAt: row.created_at,
      sourceReferences: parseJson(row.source_references),
    },
    sequence: row.sequence,
    idempotencyKey: row.idempotency_key,
  };
}
function nextSequence(threadId) {
  const row = first("SELECT COALESCE(MAX(sequence),0)+1 AS next FROM message WHERE thread_id=?", [threadId]);
  return Number(row.next);
}
function txOperation(datasetId, operation, input) {
  assertDataset(datasetId);
  const now = new Date().toISOString();
  switch (operation) {
    case "getThreadByRevision":
      return first("SELECT id,dataset_id AS datasetId,book_revision_id AS bookRevisionId,created_at AS createdAt FROM thread WHERE dataset_id=? AND book_revision_id=?", [datasetId,input.bookRevisionId]);
    case "createThread": {
      if (input.thread.datasetId !== datasetId) throw new Error("Thread datasetId 与事务不一致");
      execute("INSERT INTO thread(id,dataset_id,book_revision_id,created_at) VALUES(?,?,?,?)", [input.thread.id,datasetId,input.thread.bookRevisionId,input.thread.createdAt]);
      transactionDirty = true;
      return input.thread;
    }
    case "appendUserMessage": {
      const m=input.message;
      if (!m.content?.trim()) throw new Error("用户消息不能为空");
      assertSourceReferences(datasetId,m.threadId,m.sourceReferences);
      if (m.idempotencyKey) {
        const old=first("SELECT * FROM message WHERE thread_id=? AND idempotency_key=?", [m.threadId,m.idempotencyKey]);
        if (old) {
          if (old.id !== m.id || old.content !== m.content) throw new Error("幂等键已用于不同的用户消息");
          return rowToMessage(old);
        }
      }
      const sequence=nextSequence(m.threadId);
      execute("INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,status,created_at,source_references,idempotency_key) VALUES(?,?,?,?,'user',?,'saved',?,?,?)",
        [m.id,datasetId,m.threadId,sequence,m.content,m.createdAt,JSON.stringify(m.sourceReferences||[]),m.idempotencyKey||null]);
      transactionDirty=true;
      return rowToMessage(first("SELECT * FROM message WHERE id=?", [m.id]));
    }
    case "appendAssistantMessage": {
      const m=input.message;
      assertSourceReferences(datasetId,m.threadId,m.sourceReferences);
      const sequence=nextSequence(m.threadId);
      execute("INSERT INTO message(id,dataset_id,thread_id,sequence,role,content,status,created_at,source_references,idempotency_key) VALUES(?,?,?,?,'assistant',?,?,?,?,?)",
        [m.id,datasetId,m.threadId,sequence,m.content,m.status,m.createdAt,JSON.stringify(m.sourceReferences||[]),m.idempotencyKey||null]);
      transactionDirty=true;
      return rowToMessage(first("SELECT * FROM message WHERE id=?", [m.id]));
    }
    case "transitionAssistantMessage": {
      const old=first("SELECT * FROM message WHERE id=? AND dataset_id=? AND role='assistant'", [input.messageId,datasetId]);
      if (!old || old.status !== "generating") throw new Error("只有生成中的 Assistant Message 可以变更状态");
      if (input.status === "generating") throw new Error("Assistant Message 不允许回退到 generating");
      execute("UPDATE message SET status=?,content=? WHERE id=?", [input.status,input.content ?? old.content,input.messageId]);
      transactionDirty=true;
      const row=first("SELECT * FROM message WHERE id=?", [input.messageId]);
      return rowToMessage(row).message;
    }
    case "createReadingRound": {
      const r=input.round;
      if (!first("SELECT id FROM thread WHERE id=? AND dataset_id=?", [r.threadId,datasetId])) throw new Error("ReadingRound Thread 不属于当前数据集");
      execute("INSERT INTO reading_round(id,dataset_id,thread_id,round_number,status,started_at,completed_at) VALUES(?,?,?,?,?,?,?)",
        [r.id,datasetId,r.threadId,r.roundNumber,r.status,r.startedAt,r.completedAt||null]);
      transactionDirty=true;
      return r;
    }
    case "saveReadingPosition": {
      const p=input.position;
      if (!first("SELECT id FROM thread WHERE id=? AND dataset_id=?", [p.threadId,datasetId])) throw new Error("ReadingPosition Thread 不属于当前数据集");
      execute("INSERT INTO reading_position(thread_id,dataset_id,mainline_node_id,displayed_node_id,view_mode,current_unit_discussed,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(thread_id) DO UPDATE SET mainline_node_id=excluded.mainline_node_id,displayed_node_id=excluded.displayed_node_id,view_mode=excluded.view_mode,current_unit_discussed=excluded.current_unit_discussed,updated_at=excluded.updated_at",
        [p.threadId,datasetId,p.mainlineNodeId,p.displayedNodeId,p.viewMode,p.currentUnitDiscussed?1:0,p.updatedAt]);
      transactionDirty=true;
      return undefined;
    }
    case "saveCitation": {
      const c=input.citation;
      const citationThread = assertSourceReferences(datasetId,c.threadId,[{bookRevisionId:c.bookRevisionId,structureNodeId:c.structureNodeId,locator:c.locator}]);
      const sourceMessage = first("SELECT thread_id FROM message WHERE id=? AND dataset_id=?", [c.messageId,datasetId]);
      if (!sourceMessage || sourceMessage.thread_id !== c.threadId) throw new Error("Citation Message 必须属于同一 Thread");
      execute("INSERT INTO citation(id,dataset_id,thread_id,message_id,book_revision_id,structure_node_id,locator,excerpt,excerpt_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [c.id,datasetId,c.threadId,c.messageId,c.bookRevisionId,c.structureNodeId,c.locator,c.excerpt,c.excerptHash,c.createdAt]);
      transactionDirty=true;
      return undefined;
    }
    case "saveNote": {
      const n=input.note;
      if (!first("SELECT id FROM thread WHERE id=? AND dataset_id=?", [n.threadId,datasetId])) throw new Error("Note Thread 不属于当前数据集");
      if (n.readingRoundId && !first("SELECT id FROM reading_round WHERE id=? AND dataset_id=?", [n.readingRoundId,datasetId])) throw new Error("Note ReadingRound 不属于当前数据集");
      const noteThread = assertSourceReferences(datasetId,n.threadId,n.sourceReferences);
      for (const messageId of n.sourceMessageIds || []) {
        const source = first("SELECT thread_id FROM message WHERE id=? AND dataset_id=?", [messageId,datasetId]);
        if (!source || source.thread_id !== n.threadId) throw new Error("Note 来源消息必须属于同一 Thread");
      }
      for (const reference of n.sourceReferences || []) {
        if (!reference.bookRevisionId || reference.bookRevisionId !== noteThread.book_revision_id || !reference.structureNodeId || !reference.locator) {
          throw new Error("Note 原文来源必须绑定当前 BookRevision 和有效定位");
        }
      }
      execute("INSERT INTO note(id,dataset_id,thread_id,reading_round_id,content,source_message_ids,source_references,created_at,updated_at,revision) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET content=excluded.content,source_message_ids=excluded.source_message_ids,source_references=excluded.source_references,updated_at=excluded.updated_at,revision=excluded.revision",
        [n.id,datasetId,n.threadId,n.readingRoundId,n.content,JSON.stringify(n.sourceMessageIds),JSON.stringify(n.sourceReferences),n.createdAt,n.updatedAt,n.revision]);
      transactionDirty=true;
      return undefined;
    }
    case "appendMemoryVersion": {
      const v=input.version;
      const memory=first("SELECT * FROM memory WHERE id=? AND dataset_id=?", [v.memoryId,datasetId]);
      if (!memory) {
        if (v.version!==1 || v.previousVersionId!==null || v.changeKind!=="new") throw new Error("首个 MemoryVersion 必须是 version 1 / new");
        if (!Array.isArray(v.sourceMessageIds) || v.sourceMessageIds.length === 0 || new Set(v.sourceMessageIds).size !== v.sourceMessageIds.length) {
          throw new Error("MemoryVersion 必须包含唯一来源消息 ID");
        }
        const sourceMessages = v.sourceMessageIds.map((messageId) => first(
          "SELECT thread_id FROM message WHERE id=? AND dataset_id=?", [messageId,datasetId]
        ));
        if (sourceMessages.some((row) => !row) || new Set(sourceMessages.map((row) => row.thread_id)).size !== 1) {
          throw new Error("MemoryVersion 来源消息必须存在且属于同一 Thread");
        }
        const sourceMessage = sourceMessages[0];
        assertSourceReferences(datasetId,sourceMessage.thread_id,v.sourceReferences);
        execute("INSERT INTO memory(id,dataset_id,thread_id,current_version_id,created_at,updated_at) VALUES(?,?,?,?,?,?)",
          [v.memoryId,datasetId,sourceMessage.thread_id,v.id,v.createdAt,v.createdAt]);
      } else {
        const current=first("SELECT * FROM memory_version WHERE id=? AND dataset_id=?", [memory.current_version_id,datasetId]);
        if (!current || v.version!==current.version+1 || v.previousVersionId!==current.id || v.changeKind==="new") throw new Error("MemoryVersion 必须追加到当前版本");
        if (!Array.isArray(v.sourceMessageIds) || v.sourceMessageIds.length === 0 || new Set(v.sourceMessageIds).size !== v.sourceMessageIds.length) {
          throw new Error("MemoryVersion 必须包含唯一来源消息 ID");
        }
        const sourceMessages = v.sourceMessageIds.map((messageId) => first(
          "SELECT thread_id FROM message WHERE id=? AND dataset_id=?", [messageId,datasetId]
        ));
        if (sourceMessages.some((row) => !row || row.thread_id !== memory.thread_id)) {
          throw new Error("MemoryVersion 来源消息必须属于该 Memory 的 Thread");
        }
        assertSourceReferences(datasetId,memory.thread_id,v.sourceReferences);
        execute("UPDATE memory SET current_version_id=?,updated_at=? WHERE id=?", [v.id,v.createdAt,v.memoryId]);
      }
      execute("INSERT INTO memory_version(id,dataset_id,memory_id,version,previous_version_id,change_kind,content,source_message_ids,source_references,created_at,title,viewpoint,confidence,ambiguity,evaluation_score) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [v.id,datasetId,v.memoryId,v.version,v.previousVersionId,v.changeKind,v.content,JSON.stringify(v.sourceMessageIds),JSON.stringify(v.sourceReferences),v.createdAt,v.title || "",v.viewpoint || "user",v.confidence ?? 1,v.ambiguity ?? 0,v.evaluationScore ?? 0]);
      transactionDirty=true;
      return v;
    }

    case "saveMemoryCandidate": {
      const record=input.candidate;
      const candidate=record?.candidate;
      const viewpoints=["user","author","assistant_inference"];
      if (!record || typeof record.id!=="string" || !record.id.trim() || record.id!==candidate?.id ||
          record.datasetId!==datasetId || typeof record.threadId!=="string" || !record.threadId.trim() ||
          !["needs_confirmation","accepted","rejected"].includes(record.status) || !Number.isFinite(record.evaluationScore) || record.evaluationScore<0 || record.evaluationScore>1 ||
          !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt)) ||
          typeof candidate.title!=="string" || !candidate.title.trim() || typeof candidate.content!=="string" || !candidate.content.trim() ||
          !viewpoints.includes(candidate.viewpoint) || !Number.isFinite(candidate.confidence) || candidate.confidence<0 || candidate.confidence>1 ||
          !Number.isFinite(candidate.ambiguity) || candidate.ambiguity<0 || candidate.ambiguity>1 ||
          !Array.isArray(candidate.sourceMessageIds) || candidate.sourceMessageIds.length===0 || new Set(candidate.sourceMessageIds).size!==candidate.sourceMessageIds.length ||
          !Array.isArray(candidate.sourceReferences)) throw new Error("MemoryCandidate 字段非法");
      const thread=first("SELECT id FROM thread WHERE id=? AND dataset_id=?",[record.threadId,datasetId]);
      if (!thread) throw new Error("MemoryCandidate Thread 不属于当前数据集");
      const sourceRows=candidate.sourceMessageIds.map((messageId)=>first("SELECT thread_id,role FROM message WHERE id=? AND dataset_id=?",[messageId,datasetId]));
      if (sourceRows.some((row)=>!row || row.thread_id!==record.threadId) || !sourceRows.some((row)=>row.role==="user")) {
        throw new Error("MemoryCandidate 必须引用当前 Thread 的消息且至少包含一条用户消息");
      }
      assertSourceReferences(datasetId,record.threadId,candidate.sourceReferences);
      const serialized=JSON.stringify(candidate);
      const old=first("SELECT candidate_json,evaluation_score,thread_id FROM memory_candidate WHERE id=? AND dataset_id=?",[record.id,datasetId]);
      if (old) {
        if (old.candidate_json!==serialized || old.evaluation_score!==record.evaluationScore || old.thread_id!==record.threadId) throw new Error("MemoryCandidate ID 已用于不同候选内容或 Thread");
        return record;
      }
      execute("INSERT INTO memory_candidate(id,dataset_id,thread_id,candidate_json,evaluation_score,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
        [record.id,datasetId,record.threadId,serialized,record.evaluationScore,record.status,record.createdAt,record.updatedAt]);
      transactionDirty=true;
      return record;
    }
    case "resolveMemoryCandidate": {
      const status=input.status;
      const updatedAt=input.updatedAt;
      if (!["accepted","rejected"].includes(status) || !Number.isFinite(Date.parse(updatedAt))) {
        throw new Error("MemoryCandidate resolution is invalid");
      }
      const old=first("SELECT status FROM memory_candidate WHERE id=? AND dataset_id=?",[input.candidateId,datasetId]);
      if (!old) return false;
      if (old.status===status) return true;
      if (old.status!=="needs_confirmation") throw new Error("MemoryCandidate has already been resolved");
      execute("UPDATE memory_candidate SET status=?,updated_at=? WHERE id=? AND dataset_id=?",[status,updatedAt,input.candidateId,datasetId]);
      transactionDirty=true;
      return true;
    }
    case "appendMemoryRelation": {
      const r=input.relation;
      const allowed = ["supports","contradicts","extends","supersedes","retracts","duplicate_of"];
      if (!r || typeof r.id !== "string" || !r.id.trim() ||
          typeof r.fromVersionId !== "string" || !r.fromVersionId.trim() ||
          typeof r.toVersionId !== "string" || !r.toVersionId.trim() ||
          r.fromVersionId === r.toVersionId || !allowed.includes(r.relationType)) {
        throw new Error("MemoryRelation 字段或关系类型非法");
      }
      if (!Array.isArray(r.sourceMessageIds) || r.sourceMessageIds.length === 0 ||
          new Set(r.sourceMessageIds).size !== r.sourceMessageIds.length) {
        throw new Error("MemoryRelation 必须包含唯一来源消息 ID");
      }
      const from = first(
        "SELECT mv.id,m.thread_id,mv.source_message_ids FROM memory_version mv JOIN memory m ON m.id=mv.memory_id WHERE mv.id=? AND mv.dataset_id=?",
        [r.fromVersionId,datasetId],
      );
      const to = first("SELECT id FROM memory_version WHERE id=? AND dataset_id=?", [r.toVersionId,datasetId]);
      if (!from || !to) throw new Error("MemoryRelation 两端版本必须存在于当前数据集");
      const sourceMessages = r.sourceMessageIds.map((messageId) => first(
        "SELECT thread_id FROM message WHERE id=? AND dataset_id=?", [messageId,datasetId]
      ));
      if (sourceMessages.some((row) => !row || row.thread_id !== from.thread_id)) {
        throw new Error("MemoryRelation 来源消息必须属于 fromVersion 所在 Thread");
      }
      const fromSources = parseJson(from.source_message_ids);
      if (!r.sourceMessageIds.some((id) => fromSources.includes(id))) {
        throw new Error("MemoryRelation 来源必须与 fromVersion 的来源消息有交集");
      }
      assertSourceReferences(datasetId,from.thread_id,r.sourceReferences);
      if (typeof r.createdAt !== "string" || !Number.isFinite(Date.parse(r.createdAt))) {
        throw new Error("MemoryRelation createdAt 必须是有效时间");
      }
      execute("INSERT INTO memory_relation(id,dataset_id,from_version_id,to_version_id,relation_type,source_message_ids,source_references,created_at) VALUES(?,?,?,?,?,?,?,?)",
        [r.id,datasetId,r.fromVersionId,r.toVersionId,r.relationType,JSON.stringify(r.sourceMessageIds),JSON.stringify(r.sourceReferences),r.createdAt]);
      transactionDirty=true;
      return r;
    }
    case "createAccountDataSetBinding": {
      const b=input.binding;
      if (b.localDataSetId !== datasetId || !b.accountId || b.status === "revoked" || b.revokedAt !== null) {
        throw new Error("AccountDataSetBinding 必须绑定当前数据集且处于 active/inactive 状态");
      }
      execute("INSERT INTO account_dataset_binding(id,dataset_id,account_id,status,bound_at,last_selected_at,revoked_at) VALUES(?,?,?,?,?,?,NULL)",
        [b.id,datasetId,b.accountId,b.status,b.boundAt,b.lastSelectedAt]);
      transactionDirty=true;
      return b;
    }
    case "getAccountDataSetBinding": {
      const row=first("SELECT * FROM account_dataset_binding WHERE id=? AND dataset_id=?", [input.bindingId,datasetId]);
      return row ? { id:row.id,accountId:row.account_id,localDataSetId:row.dataset_id,status:row.status,boundAt:row.bound_at,lastSelectedAt:row.last_selected_at,revokedAt:row.revoked_at } : null;
    }
    case "softRevokeAccountDataSetBinding": {
      execute("UPDATE account_dataset_binding SET account_id=NULL,status='revoked',revoked_at=? WHERE id=? AND dataset_id=? AND status!='revoked'", [input.revokedAt,input.bindingId,datasetId]);
      const changed = db.changes() > 0;
      execute("DELETE FROM binding_authorization WHERE binding_id=? AND EXISTS(SELECT 1 FROM account_dataset_binding b WHERE b.id=? AND b.dataset_id=?)", [input.bindingId,input.bindingId,datasetId]);
      if (changed) transactionDirty=true;
      return changed;
    }
    case "saveGenerationDelivery": {
      const d=input.delivery;
      const statuses=["queued","running","completed","failed","cancelled","expired"];
      if (!d || typeof d.clientGenerationId!=="string" || d.clientGenerationId.length<16 || d.clientGenerationId.length>128 ||
          typeof d.idempotencyKey!=="string" || d.idempotencyKey.length<16 || d.idempotencyKey.length>128 ||
          !statuses.includes(d.status) || !Number.isSafeInteger(d.lastSequence) || d.lastSequence<0 ||
          typeof d.updatedAt!=="string" || !Number.isFinite(Date.parse(d.updatedAt)) ||
          (d.generationId!==null && (typeof d.generationId!=="string" || !d.generationId.trim())) ||
          (d.lastEventId!==null && typeof d.lastEventId!=="string") ||
          (d.expiresAt!==null && !Number.isFinite(Date.parse(d.expiresAt)))) throw new Error("GenerationDelivery 字段非法");
      const thread=first("SELECT id FROM thread WHERE id=? AND dataset_id=?",[d.threadId,datasetId]);
      const user=first("SELECT id,thread_id,role FROM message WHERE id=? AND dataset_id=?",[d.userMessageId,datasetId]);
      const assistant=first("SELECT id,thread_id,role FROM message WHERE id=? AND dataset_id=?",[d.assistantMessageId,datasetId]);
      if (!thread || !user || user.role!=="user" || user.thread_id!==d.threadId || !assistant || assistant.role!=="assistant" || assistant.thread_id!==d.threadId) throw new Error("GenerationDelivery 必须引用当前数据集同一 Thread 的用户和助手消息");
      const old=first("SELECT * FROM generation_delivery WHERE client_generation_id=? AND dataset_id=?",[d.clientGenerationId,datasetId]);
      if (old && (old.thread_id!==d.threadId || old.user_message_id!==d.userMessageId || old.assistant_message_id!==d.assistantMessageId || old.idempotency_key!==d.idempotencyKey)) throw new Error("GenerationDelivery 不允许更换原始消息或幂等键");
      if (old && d.lastSequence<old.last_sequence) throw new Error("GenerationDelivery 事件游标不允许回退");
      if (old && d.lastSequence===old.last_sequence && old.last_event_id && d.lastEventId && old.last_event_id!==d.lastEventId) throw new Error("GenerationDelivery 相同序号不能对应不同事件");
      if (old && old.generation_id && d.generationId && old.generation_id!==d.generationId) throw new Error("GenerationDelivery generation_id 不允许变更");
      const terminalStatuses=["completed","failed","cancelled","expired"];
      if (old && terminalStatuses.includes(old.status) && d.status!==old.status) throw new Error("GenerationDelivery 终态不可回退或变更");
      if (old && old.status==="running" && d.status==="queued") throw new Error("GenerationDelivery running 状态不可回退为 queued");
      execute("INSERT INTO generation_delivery(client_generation_id,dataset_id,generation_id,thread_id,user_message_id,assistant_message_id,idempotency_key,status,last_sequence,last_event_id,expires_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(client_generation_id) DO UPDATE SET generation_id=COALESCE(excluded.generation_id,generation_delivery.generation_id),status=excluded.status,last_sequence=excluded.last_sequence,last_event_id=excluded.last_event_id,expires_at=COALESCE(excluded.expires_at,generation_delivery.expires_at),updated_at=excluded.updated_at",
        [d.clientGenerationId,datasetId,d.generationId,d.threadId,d.userMessageId,d.assistantMessageId,d.idempotencyKey,d.status,d.lastSequence,d.lastEventId,d.expiresAt,d.updatedAt]);
      transactionDirty=true;
      return d;
    }
    case "acknowledgeBackup": {
      const sequence = input.snapshotSequence;
      const backupId = input.backupId;
      const backedUpAt = input.backedUpAt;
      if (!Number.isSafeInteger(sequence) || sequence < 0) {
        throw new Error("备份快照序号必须是非负安全整数");
      }
      if (typeof backupId !== "string" || !backupId.trim() || backupId.length > 256) {
        throw new Error("backupId 必须是 1 到 256 字符的非空字符串");
      }
      if (typeof backedUpAt !== "string" || !Number.isFinite(Date.parse(backedUpAt))) {
        throw new Error("backedUpAt 必须是有效时间");
      }
      const dataset = first("SELECT dirty_sequence,last_acked_sequence FROM local_dataset WHERE id=?", [datasetId]);
      if (!dataset) throw new Error("数据集不存在");
      if (sequence < dataset.last_acked_sequence) {
        throw new Error("不能将备份确认序号回退到已确认位置之前");
      }
      if (sequence > dataset.dirty_sequence) {
        throw new Error("不能确认尚未生成的备份快照序号");
      }
      execute("UPDATE local_dataset SET last_acked_sequence=?,last_backup_id=?,last_backup_at=? WHERE id=?",
        [sequence,backupId,backedUpAt,datasetId]);
      // Backup metadata is not user content and must not advance dirty_sequence.
      return undefined;
    }
    case "createConsistentSnapshot": {
      const ds=first("SELECT * FROM local_dataset WHERE id=?", [datasetId]);
      return {
        datasetId:datasetId,schemaVersion:ds.schema_version,dirtySequence:ds.dirty_sequence + (transactionDirty ? 1 : 0),
        threads:execute("SELECT id,dataset_id AS datasetId,book_revision_id AS bookRevisionId,created_at AS createdAt FROM thread WHERE dataset_id=?", [datasetId]),
        messages:execute("SELECT * FROM message WHERE dataset_id=? ORDER BY thread_id,sequence", [datasetId]).map(rowToMessage),
        readingRounds:execute("SELECT id,thread_id AS threadId,started_at AS startedAt,completed_at AS completedAt,round_number AS roundNumber,status FROM reading_round WHERE dataset_id=?", [datasetId]),
        readingPositions:execute("SELECT thread_id AS threadId,mainline_node_id AS mainlineNodeId,displayed_node_id AS displayedNodeId,view_mode AS viewMode,current_unit_discussed AS currentUnitDiscussed,updated_at AS updatedAt FROM reading_position WHERE dataset_id=?", [datasetId]),
        citations:execute("SELECT * FROM citation WHERE dataset_id=?", [datasetId]).map(c=>({id:c.id,threadId:c.thread_id,messageId:c.message_id,bookRevisionId:c.book_revision_id,structureNodeId:c.structure_node_id,locator:c.locator,excerpt:c.excerpt,excerptHash:c.excerpt_hash,createdAt:c.created_at})),
        notes:execute("SELECT * FROM note WHERE dataset_id=?", [datasetId]).map(n=>({id:n.id,datasetId:n.dataset_id,threadId:n.thread_id,readingRoundId:n.reading_round_id,content:n.content,sourceMessageIds:parseJson(n.source_message_ids),sourceReferences:parseJson(n.source_references),createdAt:n.created_at,updatedAt:n.updated_at,revision:n.revision})),
        memories:execute("SELECT * FROM memory WHERE dataset_id=?", [datasetId]).map(m=>({id:m.id,datasetId:m.dataset_id,threadId:m.thread_id,currentVersionId:m.current_version_id,createdAt:m.created_at,updatedAt:m.updated_at})),
        memoryVersions:execute("SELECT * FROM memory_version WHERE dataset_id=? ORDER BY memory_id,version", [datasetId]).map(v=>({id:v.id,memoryId:v.memory_id,version:v.version,previousVersionId:v.previous_version_id,changeKind:v.change_kind,content:v.content,title:v.title,viewpoint:v.viewpoint,confidence:v.confidence,ambiguity:v.ambiguity,evaluationScore:v.evaluation_score,sourceMessageIds:parseJson(v.source_message_ids),sourceReferences:parseJson(v.source_references),createdAt:v.created_at})),
        memoryRelations:execute("SELECT * FROM memory_relation WHERE dataset_id=? ORDER BY created_at,id", [datasetId]).map(r=>({id:r.id,fromVersionId:r.from_version_id,toVersionId:r.to_version_id,relationType:r.relation_type,sourceMessageIds:parseJson(r.source_message_ids),sourceReferences:parseJson(r.source_references),createdAt:r.created_at})),
        memoryCandidates:execute("SELECT * FROM memory_candidate WHERE dataset_id=? ORDER BY created_at,id", [datasetId]).map(c=>({id:c.id,datasetId:c.dataset_id,threadId:c.thread_id,candidate:parseJson(c.candidate_json,{}),evaluationScore:c.evaluation_score,status:c.status,createdAt:c.created_at,updatedAt:c.updated_at})),
        generationDeliveries:execute("SELECT * FROM generation_delivery WHERE dataset_id=? ORDER BY updated_at,client_generation_id", [datasetId]).map(r=>({clientGenerationId:r.client_generation_id,generationId:r.generation_id,threadId:r.thread_id,userMessageId:r.user_message_id,assistantMessageId:r.assistant_message_id,idempotencyKey:r.idempotency_key,status:r.status,lastSequence:r.last_sequence,lastEventId:r.last_event_id,expiresAt:r.expires_at,updatedAt:r.updated_at})),
      };
    }
    default: throw new Error("未知 Repository 事务操作：" + operation);
  }
}
function classifyRepositoryError(error) {
  const message = error?.message || String(error);
  if (/SQLITE_FULL|database or disk is full|quota.*exceed|exceed.*quota|storage quota|no space left/i.test(message)) return "QUOTA_EXCEEDED";
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(message)) return "INTEGRITY_FAILED";
  if (/Schema v\d+ 迁移失败|数据库版本高于当前客户端/i.test(message)) return "MIGRATION_FAILED";
  return null;
}

function handle(message) {
  const { type, id } = message;
  if (type === "init") return initialize();
  if (type === "begin") {
    if (activeDatasetId) throw new Error("SQLite Worker 已有活动事务");
    db.exec({sql:"BEGIN IMMEDIATE"});
    activeDatasetId=message.datasetId;
    transactionDirty=false;
    try {
      ensureDataset(message.datasetId);
      return true;
    } catch (error) {
      db.exec({sql:"ROLLBACK"});
      activeDatasetId=null;
      throw error;
    }
  }
  if (type === "tx") return txOperation(message.datasetId,message.operation,message.input||{});
  if (type === "commit") {
    assertDataset(message.datasetId);
    if (transactionDirty) execute("UPDATE local_dataset SET dirty_sequence=dirty_sequence+1,updated_at=? WHERE id=?", [new Date().toISOString(),activeDatasetId]);
    db.exec({sql:"COMMIT"});
    activeDatasetId=null;
    transactionDirty=false;
    return true;
  }
  if (type === "rollback") {
    if (activeDatasetId) db.exec({sql:"ROLLBACK"});
    activeDatasetId=null;
    transactionDirty=false;
    return true;
  }
  if (type === "restoreSnapshot") {
    if (activeDatasetId) throw new Error("SQLite Worker 已有活动事务");
    const datasetId=message.datasetId;
    const snapshot=message.snapshot;
    if (!snapshot || snapshot.datasetId!==datasetId || !Number.isSafeInteger(snapshot.schemaVersion) ||
        snapshot.schemaVersion<1 || snapshot.schemaVersion>6 || !Number.isSafeInteger(snapshot.dirtySequence) ||
        snapshot.dirtySequence<1 || typeof message.backupId!=="string" || !message.backupId.trim() ||
        !Number.isFinite(Date.parse(message.restoredAt))) {
      throw new Error("Backup snapshot metadata is invalid");
    }
    db.exec({sql:"BEGIN IMMEDIATE"});
    activeDatasetId=datasetId;
    transactionDirty=false;
    try {
      ensureDataset(datasetId);
      const dataset=first("SELECT dirty_sequence FROM local_dataset WHERE id=?",[datasetId]);
      const existingThreads=first("SELECT COUNT(*) AS count FROM thread WHERE dataset_id=?",[datasetId]).count;
      if (existingThreads!==0 || dataset.dirty_sequence!==0) {
        throw new Error("Backup restore is allowed only into an empty local dataset");
      }
      for (const thread of snapshot.threads || []) {
        if (thread.datasetId!==datasetId) throw new Error("Restored Thread belongs to a different dataset");
        txOperation(datasetId,"createThread",{thread});
      }
      const messages=[...(snapshot.messages || [])].sort((a,b)=>a.sequence-b.sequence);
      for (const persisted of messages) {
        const m=persisted.message;
        const input={message:{
          id:m.id,threadId:m.threadId,content:m.content,createdAt:m.createdAt,
          sourceReferences:m.sourceReferences || [],idempotencyKey:persisted.idempotencyKey ?? null,
          ...(m.role==="assistant" ? {status:m.status} : {}),
        }};
        if (m.role==="user") txOperation(datasetId,"appendUserMessage",input);
        else if (m.role==="assistant") txOperation(datasetId,"appendAssistantMessage",input);
        else throw new Error("Restored Message role is invalid");
      }
      for (const round of snapshot.readingRounds || []) txOperation(datasetId,"createReadingRound",{round});
      for (const position of snapshot.readingPositions || []) txOperation(datasetId,"saveReadingPosition",{position});
      for (const citation of snapshot.citations || []) txOperation(datasetId,"saveCitation",{citation});
      for (const note of snapshot.notes || []) txOperation(datasetId,"saveNote",{note});
      const versions=[...(snapshot.memoryVersions || [])].sort((a,b)=>a.memoryId.localeCompare(b.memoryId) || a.version-b.version);
      for (const version of versions) txOperation(datasetId,"appendMemoryVersion",{version});
      for (const relation of snapshot.memoryRelations || []) txOperation(datasetId,"appendMemoryRelation",{relation});
      for (const candidate of snapshot.memoryCandidates || []) txOperation(datasetId,"saveMemoryCandidate",{candidate});
      for (const delivery of snapshot.generationDeliveries || []) txOperation(datasetId,"saveGenerationDelivery",{delivery});
      transactionDirty=false;
      execute("UPDATE local_dataset SET schema_version=5,dirty_sequence=?,last_acked_sequence=?,last_backup_id=?,last_backup_at=?,updated_at=?,lifecycle_status='active' WHERE id=?",
        [snapshot.dirtySequence,snapshot.dirtySequence,message.backupId,message.restoredAt,message.restoredAt,datasetId]);
      db.exec({sql:"COMMIT"});
      activeDatasetId=null;
      transactionDirty=false;
      return true;
    } catch (error) {
      db.exec({sql:"ROLLBACK"});
      activeDatasetId=null;
      transactionDirty=false;
      throw error;
    }
  }
  if (type === "getDataSet") {
    const r=first("SELECT * FROM local_dataset WHERE id=?", [message.datasetId]);
    return r ? {id:r.id,schemaVersion:r.schema_version,createdAt:r.created_at,updatedAt:r.updated_at,dirtySequence:r.dirty_sequence,lastAckedSequence:r.last_acked_sequence,lastBackupId:r.last_backup_id,lastBackupAt:r.last_backup_at,lifecycleStatus:r.lifecycle_status} : null;
  }
  if (type === "getMessages") {
    return execute("SELECT * FROM message WHERE dataset_id=? AND thread_id=? AND sequence>? ORDER BY sequence", [message.datasetId,message.threadId,message.afterSequence||0]).map(rowToMessage);
  }
  if (type === "getGenerationDelivery") {
    const r=first("SELECT * FROM generation_delivery WHERE dataset_id=? AND client_generation_id=?",[message.datasetId,message.clientGenerationId]);
    return r ? {clientGenerationId:r.client_generation_id,generationId:r.generation_id,threadId:r.thread_id,userMessageId:r.user_message_id,assistantMessageId:r.assistant_message_id,idempotencyKey:r.idempotency_key,status:r.status,lastSequence:r.last_sequence,lastEventId:r.last_event_id,expiresAt:r.expires_at,updatedAt:r.updated_at} : null;
  }
  if (type === "listPendingGenerationDeliveries") {
    return execute("SELECT * FROM generation_delivery WHERE dataset_id=? AND status IN ('queued','running') ORDER BY updated_at,client_generation_id",[message.datasetId]).map(r=>({clientGenerationId:r.client_generation_id,generationId:r.generation_id,threadId:r.thread_id,userMessageId:r.user_message_id,assistantMessageId:r.assistant_message_id,idempotencyKey:r.idempotency_key,status:r.status,lastSequence:r.last_sequence,lastEventId:r.last_event_id,expiresAt:r.expires_at,updatedAt:r.updated_at}));
  }

  if (type === "getMemoryVersions") {
    return execute("SELECT * FROM memory_version WHERE dataset_id=? AND memory_id=? ORDER BY version", [message.datasetId,message.memoryId]).map(v=>({
      id:v.id,memoryId:v.memory_id,version:v.version,previousVersionId:v.previous_version_id,changeKind:v.change_kind,
      content:v.content,title:v.title,viewpoint:v.viewpoint,confidence:v.confidence,ambiguity:v.ambiguity,evaluationScore:v.evaluation_score,
      sourceMessageIds:parseJson(v.source_message_ids),sourceReferences:parseJson(v.source_references),createdAt:v.created_at,
    }));
  }
  if (type === "getMemoryCandidates") {
    return execute("SELECT * FROM memory_candidate WHERE dataset_id=? AND thread_id=? AND status=? ORDER BY created_at,id", [message.datasetId,message.threadId,"needs_confirmation"]).map(c=>({
      id:c.id,datasetId:c.dataset_id,threadId:c.thread_id,candidate:parseJson(c.candidate_json,{}),evaluationScore:c.evaluation_score,status:c.status,createdAt:c.created_at,updatedAt:c.updated_at,
    }));
  }
  if (type === "getMemoryRelations") {
    return execute("SELECT * FROM memory_relation WHERE dataset_id=? AND (from_version_id=? OR to_version_id=?) ORDER BY created_at,id", [message.datasetId,message.versionId,message.versionId]).map(r=>({
      id:r.id,fromVersionId:r.from_version_id,toVersionId:r.to_version_id,relationType:r.relation_type,
      sourceMessageIds:parseJson(r.source_message_ids),sourceReferences:parseJson(r.source_references),createdAt:r.created_at,
    }));
  }
  if (type === "close") {
    if (activeDatasetId) db.exec({sql:"ROLLBACK"});
    db?.close();
    db=undefined; sqlite3=undefined; activeDatasetId=null;
    return true;
  }
  throw new Error("未知 Worker 请求：" + type);
}
self.onmessage = async ({data}) => {
  try {
    const result=await handle(data);
    self.postMessage({id:data.id,result});
  } catch(error) {
    const message = error?.message || String(error);
    const code = classifyRepositoryError(error);
    self.postMessage({id:data.id,error:{message,...(code ? {code} : {})}});
  }
};
