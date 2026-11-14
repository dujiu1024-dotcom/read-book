# 知行核心数据字典

> 版本：0.1.0-draft  
> 状态：设计契约草案，待评审与 PoC 验证；不是已执行的数据库 DDL。  
> 权威范围：定义核心实体、字段语义、约束、枚举、关系和删除规则。API 路径与请求/响应以 [API 契约](api-contract.yaml) 为准。  
> 设计基线：用户私人阅读数据以本地数据库为主存储；服务器只保存端侧加密备份及必要索引。公共书籍与知识库由服务端管理。

## 1. 通用约定

### 1.1 标识符与时间

| 规则 | 约定 |
|---|---|
| 本地实体 ID | 客户端生成 UUID，建议 UUIDv4；创建后不可变 |
| 服务端实体 ID | 服务端生成 UUID；不得与客户端本地 ID 混用 |
| 跨端关联 | 明确使用 `local_*` 或 `server_*` 字段，不隐式转换 |
| 时间 | RFC 3339 UTC 时间戳，统一存储 UTC；展示时按用户本地时区转换 |
| 排序 | 同一 Thread 的 Message 使用严格递增 sequence；不可依赖时间戳排序 |
| 版本 | 数据库 schema_version、备份包 schema_version、书籍 processing_version、API version 独立管理 |
| 空值 | NULL 表示未知/尚未产生；空字符串不是 NULL 的替代 |
| 删除 | 默认软删除或状态迁移；不得级联删除有审计/来源价值的历史数据 |

### 1.2 字段类型约定

- `UUID`：规范 UUID 字符串；数据库可存 TEXT。
- `TEXT`：UTF-8 字符串；正文不设置隐式截断。
- `INTEGER`：整数；布尔值使用 0/1。
- `REAL`：有限数值；禁止 NaN/Infinity。
- `JSON`：通过版本化 Schema 校验的 JSON 文本，不作为任意对象容器。
- `BLOB`：二进制内容；大文件优先文件/对象存储，不直接塞入业务表。
- `TIMESTAMP`：UTC RFC 3339 字符串。
- 所有主键 NOT NULL；所有外键在本地数据库启用并验证；关键唯一性必须由数据库约束保证。

### 1.3 数据域

| 数据域 | 权威位置 | 服务端可读性 |
|---|---|---|
| 公共书籍、版本、目录、知识库、原文切片 | 服务端 | 可读 |
| Account、ExternalIdentity、公共权益签发记录 | 服务端 | 可读 |
| Thread、Message、PresentedSource、ReadingRound、Citation、Note、Memory | 当前设备本地数据库 | 仅以加密备份形式保存 |
| BackupManifest、上传会话、清除墓碑、恢复授权索引 | 服务端 | 仅最小元数据；不包含私人正文 |
| GenerationJob | 服务端短暂任务存储 | 处理请求期间可读；短 TTL，不作为历史主库 |
| GenerationReceipt | 本地数据库 | 本地可读 |

## 2. 公共书籍域（服务端）

### 2.1 Book

| 字段 | 类型 | 必填 | 约束/说明 |
|---|---|---:|---|
| id | UUID | 是 | PK |
| title | TEXT | 是 | trim 后非空 |
| author | TEXT | 是 | 可包含多位作者的展示文本 |
| description | TEXT | 否 | 简介 |
| cover_asset_id | UUID | 否 | 关联公共资源 |
| category_id | UUID | 否 | 分类引用 |
| status | TEXT | 是 | draft / published / withdrawn |
| created_at | TIMESTAMP | 是 | 创建时间 |
| updated_at | TIMESTAMP | 是 | 最近更新时间 |

索引：status；(status, updated_at)。Book 是书目聚合，不代表具体可阅读版本。

### 2.2 BookRevision

| 字段 | 类型 | 必填 | 约束/说明 |
|---|---|---:|---|
| id | UUID | 是 | PK；独立书籍版本身份 |
| book_id | UUID | 是 | FK → Book.id |
| edition | TEXT | 否 | 版次/版本说明 |
| translator | TEXT | 否 | 译者 |
| publisher | TEXT | 否 | 出版方 |
| language | TEXT | 是 | BCP 47 语言标签 |
| source_hash | TEXT | 是 | 原始来源文件 SHA-256 |
| processing_version | TEXT | 是 | 加工流水线版本 |
| status | TEXT | 是 | draft / processing / quality_check / published / withdrawn |
| published_at | TIMESTAMP | 否 | published 时必填 |
| created_at | TIMESTAMP | 是 | 创建时间 |

约束：FK book_id；索引 (book_id, status)、source_hash。版本发布后原文、结构、知识库和引用定位不可原位覆盖；内容变更创建新 BookRevision。

### 2.3 BookKnowledgeBase

字段：id UUID PK；book_revision_id UUID NOT NULL FK UNIQUE；processing_version TEXT NOT NULL；status TEXT NOT NULL（pending/processing/quality_check/accepted/rejected/published）；quality_report_id UUID NULL；created_at TIMESTAMP NOT NULL；published_at TIMESTAMP NULL。

约束：每个 BookRevision 同一时刻只有一个当前知识库版本；重加工应保留历史加工批次记录，不覆盖已发布批次的审计结果。

### 2.4 BookStructureNode

字段：id UUID PK；book_revision_id UUID NOT NULL FK；parent_id UUID NULL FK → BookStructureNode.id；node_type TEXT NOT NULL；title TEXT NOT NULL；order_index INTEGER NOT NULL；source_locator JSON NOT NULL；content_hash TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

node_type 枚举：part / chapter / section / subsection / argument_unit。  
约束：order_index 在同一 parent 下唯一；禁止自引用和循环父子关系；节点必须属于同一 BookRevision。主线推进顺序由作者结构与显式顺序共同决定，不能只依赖标题排序。

### 2.5 BookKnowledgeItem

字段：id UUID PK；book_revision_id UUID NOT NULL FK；structure_node_id UUID NOT NULL FK；item_type TEXT NOT NULL；content TEXT NOT NULL；source_chunk_ids JSON NOT NULL；confidence REAL NULL；created_at TIMESTAMP NOT NULL。

item_type：key_point / concept / author_claim / argument / evidence / case / cross_chapter_relation。  
约束：source_chunk_ids 至少包含一个同版本 chunk；confidence 范围 0–1，仅表示加工置信度，不是用户理解评分。

### 2.6 BookChunk

字段：id UUID PK；book_revision_id UUID NOT NULL FK；structure_node_id UUID NOT NULL FK；chunk_index INTEGER NOT NULL；content TEXT NOT NULL；source_locator JSON NOT NULL；content_hash TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

约束：(book_revision_id, chunk_index) UNIQUE；引用必须绑定 chunk 与 BookRevision；Embedding 是可重建索引，不作为原文事实来源。

## 3. 用户本地数据域

### 3.1 LocalDataSet

| 字段 | 类型 | 必填 | 约束/说明 |
|---|---|---:|---|
| id | UUID | 是 | PK；随机生成，不含账号信息 |
| schema_version | INTEGER | 是 | 本地数据库结构版本 |
| created_at | TIMESTAMP | 是 | 创建时间 |
| updated_at | TIMESTAMP | 是 | 最近数据变更时间 |
| dirty_sequence | INTEGER | 是 | 单调递增，初始 0 |
| last_acked_sequence | INTEGER | 是 | 最近已确认备份序号，初始 0 |
| last_backup_id | UUID | 否 | 最近成功备份 ID |
| last_backup_at | TIMESTAMP | 否 | 最近成功备份时间 |
| lifecycle_status | TEXT | 是 | active / locally_locked / restore_pending |

约束：dirty_sequence >= last_acked_sequence >= 0。LocalDataSet 不以 account_id 作为主键；账号绑定另表记录。单数据集同一时刻只允许一个活动写入者。

### 3.2 AccountDataSetBinding（本地绑定上下文）

字段：id UUID PK；account_id TEXT NOT NULL；local_dataset_id UUID NOT NULL FK；binding_status TEXT NOT NULL（active / inactive / revoked）；bound_at TIMESTAMP NOT NULL；last_selected_at TIMESTAMP NULL。

约束：同一数据集最多一个 active account binding；同一账号可有多个历史绑定，但用户必须显式选择。切换账号不得自动选择其他账号的数据集。该表只表达当前设备上的显式关联，不授予跨账号云端恢复权。

### 3.3 ShelfEntry

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；added_at TIMESTAMP NOT NULL；removed_at TIMESTAMP NULL；shelf_status TEXT NOT NULL（active / removed）；entitlement_proof JSON NOT NULL；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：(local_dataset_id, book_revision_id) UNIQUE。移出书架只改变 shelf_status/removed_at，不删除权益凭证及相关 Thread、Message、Note、Memory、Citation。永久访问权绑定具体 BookRevision；新版必须单独加入。

### 3.4 Thread

字段：id UUID PK；dataset_id UUID NOT NULL FK → LocalDataSet；book_revision_id UUID NOT NULL；created_at TIMESTAMP NOT NULL。

约束：(dataset_id, book_revision_id) UNIQUE；同一数据集对同一 BookRevision 只有一个长期 Thread。阅读轮次在同一 Thread 内累积。当前 SQLite v6 尚未持久化 Thread archived 状态，不得在文档中假设已支持归档。

### 3.5 Message

字段：id UUID PK；dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK；sequence INTEGER NOT NULL；role TEXT NOT NULL（user / assistant）；content TEXT NOT NULL；status TEXT NOT NULL；created_at TIMESTAMP NOT NULL；source_references JSON NOT NULL；idempotency_key TEXT NULL。

状态按角色约束：user 只使用 saved；assistant 使用 generating / completed / failed / cancelled。system 消息不写入本地 Message 表。约束：(thread_id, sequence) UNIQUE；(thread_id, idempotency_key) UNIQUE（非 NULL 时）。用户原始消息必须先本地持久化，再请求生成；失败不删除用户消息。重新生成创建新 Assistant Message，不覆盖历史结果。

### 3.6 PresentedSource

字段：id UUID PK；dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；structure_node_id UUID NOT NULL；chunk_id UUID NULL；presentation_type TEXT NOT NULL（mainline / review / temporary / citation）；reading_round_id UUID NULL FK → ReadingRound.id；presented_at TIMESTAMP NOT NULL；source_locator JSON NOT NULL。

约束：必须绑定同一 Thread 的 BookRevision；mainline 必须绑定 ReadingRound；review / temporary / citation 只记录呈现历史，不推进主线进度。每次重新展示创建新记录。

### 3.7 ReadingRound

字段：id UUID PK；dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK；round_number INTEGER NOT NULL；status TEXT NOT NULL（active / completed / abandoned）；started_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL。

约束：(thread_id, round_number) UNIQUE；同一 Thread 最多一个 active 轮次。completed 时 completed_at 必填；completed 只能在本轮所有 ReadingUnitProgress 都进入 discussed / skipped 后提交。

### 3.8 ReadingPosition（SQLite v6）

字段：thread_id UUID PK FK；dataset_id UUID NOT NULL FK；mainline_node_id UUID NOT NULL；displayed_node_id UUID NOT NULL；view_mode TEXT NOT NULL（mainline / temporary / review / citation）；current_unit_discussed BOOLEAN NOT NULL；updated_at TIMESTAMP NOT NULL。

这是 Thread 级别的阅读位置，不是 ReadingRoundState。它保存当前主线位置与当前展示位置；每轮每个单元的完成状态由 ReadingUnitProgress 保存。临时查看、复习和引用展示不得改变 mainline_node_id。

### 3.9 ReadingUnitProgress（SQLite v6）

字段：reading_round_id UUID NOT NULL FK；dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK；structure_node_id UUID NOT NULL；status TEXT NOT NULL（not_presented / presented / awaiting_user / discussion_active / discussed / skipped）；first_presented_source_id UUID NULL FK → PresentedSource.id；last_activity_message_id UUID NULL FK → Message.id；completed_at TIMESTAMP NULL；updated_at TIMESTAMP NOT NULL。

主键：(reading_round_id, structure_node_id)。每轮创建时，所有主线单元初始化为 not_presented。状态转换以 state-machines.md 为准；review / temporary / citation 不得修改本表。discussed / skipped 为单元终态；全部单元进入终态后，ReadingRound 才能 completed。

### 3.9 Citation

字段：id UUID PK；message_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；chunk_id UUID NOT NULL；structure_node_id UUID NOT NULL；source_locator JSON NOT NULL；quote TEXT NOT NULL；source_hash TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

约束：引用必须绑定具体 BookRevision、chunk、结构节点和来源哈希；原文版本变更不得静默迁移旧引用。

### 3.10 Note

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；note_type TEXT NOT NULL（author_view / user_view / ai_organization / ai_explanation / question / discussion_conclusion）；title TEXT NOT NULL；content TEXT NOT NULL；source_type TEXT NOT NULL（message / citation / structure_node / mixed）；version INTEGER NOT NULL；edit_origin TEXT NOT NULL（ai / user）；user_edited_at TIMESTAMP NULL；reading_round_id UUID NULL FK → ReadingRound.id；status TEXT NOT NULL（active / deleted）；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：AI 不得静默覆盖 edit_origin=user 的内容；AI 后续更新必须创建新版本或候选记录并保留历史。删除采用软删除并保留来源审计。

### 3.11 NoteSource

字段：id UUID PK；note_id UUID NOT NULL FK；source_message_id UUID NULL FK → Message.id；citation_id UUID NULL FK → Citation.id；structure_node_id UUID NULL FK → BookStructureNode.id；source_role TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

source_role：author / user / assistant。每条 NoteSource 至少绑定一个来源对象；Note 至少有一个 NoteSource。

### 3.12 Memory

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；memory_type TEXT NOT NULL；content TEXT NOT NULL；status TEXT NOT NULL（active / superseded / retracted / deleted）；reading_round_id UUID NULL FK → ReadingRound.id；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：认知演变不得原位覆盖旧 Memory；通过 MemoryRelation 建立关系。删除后不应被检索为当前有效认知，但审计与来源链按用户删除规则处理。

### 3.13 MemorySource

字段：id UUID PK；memory_id UUID NOT NULL FK；source_message_id UUID NULL FK → Message.id；citation_id UUID NULL FK → Citation.id；structure_node_id UUID NULL FK → BookStructureNode.id；source_role TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

约束：每条 Memory 至少有一个来源；来源角色区分 author / user / assistant。

### 3.14 MemoryRelation

字段：id UUID PK；from_memory_id UUID NOT NULL FK → Memory.id；to_memory_id UUID NOT NULL FK → Memory.id；relation_type TEXT NOT NULL（supplements / corrects / conflicts / overturns / extends）；created_at TIMESTAMP NOT NULL。

约束：(from_memory_id, to_memory_id, relation_type) UNIQUE；from 与 to 不得相同；关系方向表示新认知指向被关联的既有认知，具体展示顺序由应用层解释。

### 3.15 GenerationDelivery（SQLite v3）

字段：client_generation_id UUID PK；dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK；user_message_id UUID NOT NULL FK；assistant_message_id UUID NOT NULL FK；idempotency_key TEXT NOT NULL；generation_id TEXT NULL；status TEXT NOT NULL（queued / running / completed / failed / cancelled / expired）；last_sequence INTEGER NOT NULL；last_event_id TEXT NULL；expires_at TIMESTAMP NULL；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：客户端生成身份与幂等键稳定；重复提交复用同一 delivery；事件游标不回退；终态不可回退；最终 Assistant Message 以服务端权威快照落库。此表是本地可恢复任务交付记录，不是服务端 GenerationJob 的替代品。

### 3.16 BackupJournal（未实现为独立表）

SQLite v6 不创建逐行 BackupJournal。增量边界由 LocalDataSet.dirty_sequence 与 last_acked_sequence 表达；Repository 事务提交时推进 dirty_sequence，远端 committed 后只确认本次一致性快照对应的序号。不得将其描述为跨设备同步日志或逐实体变更历史。

### 3.17 MigrationLog（未实现为独立表）

SQLite v6 不创建 MigrationLog 表。当前迁移由 PRAGMA user_version 与 LocalDataSet.schema_version 表达，并在单个 SQLite 事务中执行；迁移失败回滚，不推进目标版本。迁移审计表属于后续可选增强，不是当前已实现能力。

## 4. 服务端账号与备份域

### 4.1 Account / ExternalIdentity

Account：id UUID PK；status TEXT NOT NULL（active / suspended / deleted）；created_at TIMESTAMP NOT NULL；deleted_at TIMESTAMP NULL。  
ExternalIdentity：id UUID PK；account_id UUID NOT NULL FK；provider TEXT NOT NULL；provider_subject TEXT NOT NULL；status TEXT NOT NULL（active / revoked）；created_at TIMESTAMP NOT NULL。  
约束：(provider, provider_subject) UNIQUE。Account 只代表身份，不是私人数据容器。注销不得级联删除备份密文。

### 4.2 BackupManifest

字段：backup_id UUID PK；dataset_id UUID NOT NULL；schema_version INTEGER NOT NULL；cipher_suite TEXT NOT NULL；key_version INTEGER NOT NULL；ciphertext_hash TEXT NOT NULL；ciphertext_size INTEGER NOT NULL；created_at TIMESTAMP NOT NULL；backup_sequence INTEGER NOT NULL；parent_backup_id UUID NULL；backup_type TEXT NOT NULL（full / incremental）；status TEXT NOT NULL（uploading / committed / rejected / inaccessible）。

约束：(dataset_id, backup_sequence) UNIQUE；incremental 必须有已提交 parent_backup_id；full 不得依赖父备份恢复。Manifest 仅允许最小必要元数据，不含私人正文、标题或可推断敏感内容的字段。

### 4.3 BackupUploadSession

字段：id UUID PK；dataset_id UUID NOT NULL；backup_id UUID NOT NULL FK；idempotency_key TEXT NOT NULL；expected_parts INTEGER NOT NULL；received_parts INTEGER NOT NULL DEFAULT 0；expires_at TIMESTAMP NOT NULL；status TEXT NOT NULL（open / completing / completed / expired / rejected）；created_at TIMESTAMP NOT NULL。

约束：(dataset_id, idempotency_key) UNIQUE；分块按 part_no 唯一并记录密文哈希；会话完成前不得出现在可恢复清单。

### 4.4 BackupAuthorization

字段：id UUID PK；dataset_id UUID NOT NULL；backup_id UUID NULL；authorization_method TEXT NOT NULL（recovery_credential）；created_at TIMESTAMP NOT NULL；expires_at TIMESTAMP NOT NULL；used_at TIMESTAMP NULL；status TEXT NOT NULL（active / used / expired / revoked）；revoked_at TIMESTAMP NULL。

约束：所有授权在下载和恢复时都必须重新检查 DataSetLifecycle；清除墓碑优先于授权状态；授权短时、单用途或受严格重放保护。不得将恢复凭证明文存储在服务端。

### 4.5 DataSetLifecycle

字段：dataset_id UUID PK；status TEXT NOT NULL（active / cleared / inactive）；cleared_at TIMESTAMP NULL；clear_reason TEXT NULL；audit_ref TEXT NULL；updated_at TIMESTAMP NOT NULL。

约束：cleared 为不可逆状态；普通账号登录、数据修复、备份上传或授权流程不得恢复 active。所有下载、恢复、重新关联、上传完成和授权签发路径都必须先检查该状态。

### 4.6 GenerationJob

字段：id UUID PK；client_generation_id TEXT NOT NULL；request_id TEXT NOT NULL；account_id UUID NOT NULL FK；status TEXT NOT NULL（queued / running / completed / failed / cancelled / expired）；created_at TIMESTAMP NOT NULL；expires_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；result_payload_ciphertext TEXT NULL；result_hash TEXT NULL；error_code TEXT NULL。

约束：(account_id, client_generation_id) UNIQUE；短 TTL；服务端只暂存生成任务必需的输入输出，不成为 Thread/Message 历史主库。不得在通用日志中记录正文。

## 5. 关键唯一约束与索引

| 实体 | 约束/索引 |
|---|---|
| BookRevision | (book_id, status)，source_hash |
| BookStructureNode | (book_revision_id, parent_id, order_index) UNIQUE |
| BookChunk | (book_revision_id, chunk_index) UNIQUE；(structure_node_id) |
| ShelfEntry | (local_dataset_id, book_revision_id) UNIQUE；(local_dataset_id, shelf_status) |
| Thread | (local_dataset_id, book_revision_id) UNIQUE |
| Message | (thread_id, sequence) UNIQUE；(thread_id, idempotency_key) UNIQUE |
| ReadingRound | (thread_id, round_number) UNIQUE；活动轮次部分唯一索引 |
| PresentedSource | (reading_round_id, presentation_type, presented_at) |
| Citation | (message_id)，(book_revision_id, chunk_id) |
| Note / Memory | (local_dataset_id, status, updated_at) |
| MemoryRelation | (from_memory_id, to_memory_id, relation_type) UNIQUE |
| BackupManifest | (dataset_id, backup_sequence) UNIQUE；(dataset_id, status, created_at) |
| BackupUploadSession | (dataset_id, idempotency_key) UNIQUE |
| ExternalIdentity | (provider, provider_subject) UNIQUE |
| GenerationJob | (account_id, client_generation_id) UNIQUE |

部分唯一索引、外键延迟策略和 JSON 校验方式须在目标 SQLite / 服务端数据库 PoC 中确认，不能只依赖 ORM 层校验。

## 6. 删除、归档与级联规则

1. 移出书架：ShelfEntry 软删除；不得级联删除 Thread、Message、ReadingRound、Citation、Note、Memory。
2. 删除 Note / Memory：状态改为 deleted；不得静默覆盖或重写来源历史。
3. 归档 Thread：仅改变 Thread.status；不删除消息和阅读轮次。
4. 账号注销：删除/停用 Account 身份和 ExternalIdentity；不得删除本地数据或 BackupManifest 密文。
5. 清除个人数据：本地删除当前设备数据；服务端写入不可逆 cleared 墓碑、失效化关联索引和授权；原始密文、密钥材料及其他原始数据保持不动且不再参与业务使用。
6. BookRevision 撤回：阻止新访问/新权益签发；已获得的永久权益如何受法律或安全撤回约束，仍需单独明确；不得擅自物理删除历史引用所需版本数据。
7. 任何外键级联删除必须经过单独评审；默认 RESTRICT 或应用层显式状态迁移。

## 7. 状态机权威来源

以下字段枚举的转换条件、事件和非法转换以 [核心状态机](state-machines.md) 为权威定义：
- ReadingRound.status
- ReadingUnitProgress.status 与 ReadingRoundState.current_structure_node_id 的协同规则
- Message.status 与 GenerationJob.status 的竞态处理
- Note.status / edit_origin
- Memory.status 与 MemoryRelation 的演变方向
- BackupManifest.status / DataSetLifecycle.status

## 8. 设计决策与未决事项

### 本版先固定的基线
- 本地私人数据实体使用 UUIDv4 客户端 ID；服务端实体使用独立 UUID。
- 时间统一 UTC；Message 顺序以 sequence 为准。
- 书籍版本是权益、Thread、Citation、知识库绑定的稳定边界。
- Thread 是一版本一条长期主线；ReadingRound 在 Thread 内递增。
- Note/Memory 保留来源与演变关系；不覆盖旧观点。
- 清除墓碑优先于备份上传、授权和恢复流程。

### 仍需评审/PoC，不视为已确认产品决策
1. BookRevision 撤回与永久访问权益之间的例外处理及用户通知。
2. AccountDataSetBinding 的服务端对应关系、同设备多账号上下文的安全实现。
3. 本地数据库物理删除与加密擦除策略；本地应用级加密尚未冻结。
4. Note/Memory 删除后，历史备份中的副本如何随下一次增量/全量备份表达删除。
5. ReadingRound 主线单元状态与 Message / PresentedSource 的精确状态机。
6. 活动轮次部分唯一索引在目标数据库中的实现细节。

## 9. 验收要求

- 每个实体均有字段类型、必填性、主键/外键、唯一约束和删除语义。
- 本地 SQLite DDL 能按本字典创建并通过约束测试。
- 所有 JSON 字段有独立 Schema；不得接受任意未校验 JSON。
- 迁移测试覆盖旧版本升级、迁移失败、回滚和快照恢复。
- 备份导出/恢复往返后实体关系、来源关系和唯一约束一致。
- API 字段与本字典一致；契约测试不得出现重复定义或旧路径。
- 状态转换测试以 `docs/state-machines.md` 为准。


## MemoryCandidate（SQLite Schema v5）

- `memory_candidate` 只保存需要用户确认的低置信度/高歧义候选，不等同于正式 Memory。
- 候选保留原始结构化内容、观点来源、置信度、歧义度、来源消息 ID 和原文 Citation；关联当前数据集与 Thread。
- 候选 ID 由 Thread、BookRevision、候选语义和来源消息确定性生成，避免模型每次返回不同临时 ID 导致重复记录。
- `needs_confirmation` 不进入正式 MemoryVersion；只有通过价值评估且获得明确演变计划的 accepted 候选才追加正式版本。
- 候选不覆盖已有认知，正式版本仍按追加式演变记录。


## 10. SQLite v6 实现对齐（2026-11-14）

本字典中标注“SQLite v6”的表已在本地 Repository 持久化，并纳入一致性快照、加密备份和空数据集恢复。标注“未实现为独立表”的概念不得被应用层当作已持久化实体。服务端 Account、ExternalIdentity、BackupUploadSession、BackupAuthorization、DataSetLifecycle 和 GenerationJob 仍以 API 契约为准，尚不代表已存在正式服务端实现。
