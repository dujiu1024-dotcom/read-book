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
    "INSERT OR IGNORE INTO local_dataset(id,schema_version,created_at,updated_at,dirty_sequence,last_acked_sequence,lifecycle_status) VALUES(?,2,?,?,0,0,'active')",
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
  if (storedVersion > 2) throw new Error("数据库版本高于当前客户端，已阻止降级写入");
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
      execute("INSERT INTO memory_version(id,dataset_id,memory_id,version,previous_version_id,change_kind,content,source_message_ids,source_references,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
        [v.id,datasetId,v.memoryId,v.version,v.previousVersionId,v.changeKind,v.content,JSON.stringify(v.sourceMessageIds),JSON.stringify(v.sourceReferences),v.createdAt]);
      transactionDirty=true;
      return v;
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
        memoryVersions:execute("SELECT * FROM memory_version WHERE dataset_id=? ORDER BY memory_id,version", [datasetId]).map(v=>({id:v.id,memoryId:v.memory_id,version:v.version,previousVersionId:v.previous_version_id,changeKind:v.change_kind,content:v.content,sourceMessageIds:parseJson(v.source_message_ids),sourceReferences:parseJson(v.source_references),createdAt:v.created_at})),
        memoryRelations:execute("SELECT * FROM memory_relation WHERE dataset_id=? ORDER BY created_at,id", [datasetId]).map(r=>({id:r.id,fromVersionId:r.from_version_id,toVersionId:r.to_version_id,relationType:r.relation_type,sourceMessageIds:parseJson(r.source_message_ids),sourceReferences:parseJson(r.source_references),createdAt:r.created_at})),
      };
    }
    default: throw new Error("未知 Repository 事务操作：" + operation);
  }
}
function classifyRepositoryError(error) {
  const message = error?.message || String(error);
  if (/SQLITE_FULL|database or disk is full|quota exceeded|storage quota/i.test(message)) return "QUOTA_EXCEEDED";
  if (/SQLITE_CORRUPT|SQLITE_NOTADB|database disk image is malformed|file is not a database/i.test(message)) return "INTEGRITY_FAILED";
  if (/Schema v\\d+ 迁移失败|数据库版本高于当前客户端/i.test(message)) return "MIGRATION_FAILED";
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
  if (type === "getDataSet") {
    const r=first("SELECT * FROM local_dataset WHERE id=?", [message.datasetId]);
    return r ? {id:r.id,schemaVersion:r.schema_version,createdAt:r.created_at,updatedAt:r.updated_at,dirtySequence:r.dirty_sequence,lastAckedSequence:r.last_acked_sequence,lastBackupId:r.last_backup_id,lastBackupAt:r.last_backup_at,lifecycleStatus:r.lifecycle_status} : null;
  }
  if (type === "getMessages") {
    return execute("SELECT * FROM message WHERE dataset_id=? AND thread_id=? AND sequence>? ORDER BY sequence", [message.datasetId,message.threadId,message.afterSequence||0]).map(rowToMessage);
  }
  if (type === "getMemoryVersions") {
    return execute("SELECT * FROM memory_version WHERE dataset_id=? AND memory_id=? ORDER BY version", [message.datasetId,message.memoryId]).map(v=>({...v,sourceMessageIds:parseJson(v.source_message_ids),sourceReferences:parseJson(v.source_references)}));
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
