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
| processing_status | TEXT | 是 | 加工尝试状态：not_started / processing / quality_check / accepted / rejected |
| status | TEXT | 是 | 发布状态：draft / published / withdrawn |
| published_at | TIMESTAMP | 否 | status=published 时必填 |
| created_at | TIMESTAMP | 是 | 创建时间 |

约束：FK book_id；索引 (book_id, status)、(book_id, processing_status)、source_hash。两个字段表达不同生命周期，不得互相推导：processing_status 只描述本次加工尝试是否通过质量检查，status 只描述版本是否对读者发布。允许 processing_status=accepted 且 status=draft（已验收未发布），也允许 status=withdrawn 且 processing_status 保持 accepted（已发布后撤回，不重跑加工）。rejected 的加工尝试必须保留记录，重加工创建新 BookKnowledgeBase 批次，不得把 rejected 原位改成 accepted。processing_status 为内部字段，不进入面向读者的公开 API；管理员侧后续通过独立内部通道读取和操作，不得复用公开 `/v1/books` 契约。版本发布后原文、结构、知识库和引用定位不可原位覆盖；内容变更创建新 BookRevision。

| 旧 status 值 | 迁移后 processing_status | 迁移后 status | 说明 |
|---|---|---|---|
| draft | not_started | draft | 尚未开始加工 |
| processing | processing | draft | 加工中，未发布 |
| quality_check | quality_check | draft | 质量检查中，未发布 |
| published | accepted | published | 已验收并发布 |
| withdrawn | accepted | withdrawn | 曾发布后撤回；加工结果保持已验收 |
| （无对应旧值） | rejected | draft | 加工或质量检查失败，新建 BookKnowledgeBase 批次重试 |

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

字段：id UUID PK；account_id TEXT NOT NULL；local_dataset_id UUID NOT NULL FK；binding_status TEXT NOT NULL（active / inactive / revoked）；bound_at TIMESTAMP NOT NULL；last_selected_at TIMESTAMP NULL。\n\naccount_id 使用 TEXT 保存外部身份映射键，不直接假设各登录 Provider 的 subject 都是 UUID；服务端 Account 主键仍为 UUID，两者通过 ExternalIdentity 关联。

约束：同一数据集最多一个 active account binding；同一账号可有多个历史绑定，但用户必须显式选择。切换账号不得自动选择其他账号的数据集。该表只表达当前设备上的显式关联，不授予跨账号云端恢复权。

### 3.3 ShelfEntry

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；added_at TIMESTAMP NOT NULL；removed_at TIMESTAMP NULL；shelf_status TEXT NOT NULL（active / removed）；entitlement_proof JSON NOT NULL；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：(local_dataset_id, book_revision_id) UNIQUE。移出书架只改变 shelf_status/removed_at，不删除权益凭证及相关 Thread、Message、Note、Memory、Citation。永久访问权绑定具体 BookRevision；新版必须单独加入。

### 3.4 Thread

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；status TEXT NOT NULL（active / archived）；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL；version INTEGER NOT NULL。

约束：(local_dataset_id, book_revision_id) UNIQUE；一个数据集对一个具体书籍版本只有一个长期 Thread。不同阅读轮次在同一 Thread 内累积，不创建第二条主线 Thread。

### 3.5 Message

字段：id UUID PK；thread_id UUID NOT NULL FK；sequence INTEGER NOT NULL；role TEXT NOT NULL（user / assistant）；content TEXT NOT NULL；content_format_version INTEGER NOT NULL；status TEXT NOT NULL（saved / generating / completed / failed / cancelled）；model TEXT NULL；token_usage JSON NULL；created_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；idempotency_key TEXT NULL；supersedes_message_id UUID NULL FK → Message.id。

约束：(thread_id, sequence) UNIQUE；(thread_id, idempotency_key) UNIQUE（idempotency_key 非 NULL 时）；role 只能是 user/assistant，与 SQLite CHECK 一致；用户消息以 saved 先本地持久化再发起生成，Assistant 消息以 generating 创建并只能由 generating 转为 completed/failed/cancelled。重新生成创建新的 Assistant Message，并通过 supersedes_message_id 关联旧结果，不覆盖历史消息。失败的用户消息仍保留。

### 3.6 PresentedSource

字段：id UUID PK；thread_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；structure_node_id UUID NOT NULL；chunk_id UUID NULL；presentation_type TEXT NOT NULL（mainline / review / temporary）；reading_round_id UUID NULL FK → ReadingRound.id；presented_at TIMESTAMP NOT NULL；source_locator JSON NOT NULL。

约束：必须绑定同一版本的结构节点；mainline 必须绑定 reading_round_id；review / temporary 不推进主线状态。每次重新展示可创建新的 PresentedSource，以保留展示历史。

### 3.7 ReadingRound

字段：id UUID PK；thread_id UUID NOT NULL FK；round_number INTEGER NOT NULL；status TEXT NOT NULL（active / completed / abandoned）；started_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；start_reason TEXT NOT NULL（first_read / reread）。

约束：(thread_id, round_number) UNIQUE；同一 Thread 最多一个 active 轮次。completed 时 completed_at 必填；abandoned 仅用于明确终止，不等同于完成。

### 3.8 ReadingRoundState

字段：reading_round_id UUID PK FK → ReadingRound.id；current_structure_node_id UUID NULL FK → BookStructureNode.id；current_order_index INTEGER NOT NULL；last_presented_source_id UUID NULL FK → PresentedSource.id；updated_at TIMESTAMP NOT NULL。

约束：状态只指向主线位置；临时查看和复习不得修改此表。当前主线单元的详细状态由后续 state-machines.md 进一步定义。

### 3.9 ReadingUnitProgress

字段：reading_round_id UUID NOT NULL FK → ReadingRound.id；structure_node_id UUID NOT NULL FK → BookStructureNode.id；status TEXT NOT NULL（not_presented / presented / awaiting_user / discussion_active / discussed / skipped）；first_presented_source_id UUID NULL FK → PresentedSource.id；last_activity_message_id UUID NULL FK → Message.id；completed_at TIMESTAMP NULL；updated_at TIMESTAMP NOT NULL。

主键：(reading_round_id, structure_node_id)。所有属于本轮主线的论述单元在轮次创建时初始化为 not_presented。status 的转换规则以 [核心状态机](state-machines.md) 为准。review / temporary 展示不得修改此表。discussed / skipped 为单元终态；轮次是否 completed 由所有主线单元是否进入终态共同决定。

### 3.9 Citation

字段：id UUID PK；message_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；chunk_id UUID NOT NULL；structure_node_id UUID NOT NULL；source_locator JSON NOT NULL；quote TEXT NOT NULL；source_hash TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

约束：引用必须绑定具体 BookRevision、chunk、结构节点和来源哈希；原文版本变更不得静默迁移旧引用。生成结果的 citations 必须返回 chunk_id 与 source_hash，NodeContent 必须返回节点下的 chunks，不得只给到 node 级。SQLite v6 起 citation 表以 NOT NULL 约束 chunk_id / source_hash；v6 之前的旧行无法在不伪造数据的前提下补齐 chunk 维度，迁移时整体保留在只读表 citation_legacy_v5。该表仅用于审计留档，不进入新 citation 查询、备份快照、恢复写入或任何面向用户的引用展示；不做伪造回填，也不以空字符串或默认值降级通过 NOT NULL 约束。

### 3.10 Note

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；book_revision_id UUID NOT NULL；note_type TEXT NOT NULL（author_view / user_view / ai_organization / ai_explanation / question / discussion_conclusion）；title TEXT NOT NULL；content TEXT NOT NULL；source_type TEXT NOT NULL（message / citation / structure_node / mixed）；version INTEGER NOT NULL；edit_origin TEXT NOT NULL（ai / user）；user_edited_at TIMESTAMP NULL；reading_round_id UUID NULL FK → ReadingRound.id；status TEXT NOT NULL（active / deleted）；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：AI 不得静默覆盖 edit_origin=user 的内容；AI 后续更新必须创建新版本或候选记录并保留历史。删除采用软删除并保留来源审计。

### 3.11 NoteSource

字段：id UUID PK；note_id UUID NOT NULL FK；source_message_id UUID NULL FK → Message.id；citation_id UUID NULL FK → Citation.id；structure_node_id UUID NULL FK → BookStructureNode.id；source_role TEXT NOT NULL；created_at TIMESTAMP NOT NULL。

source_role：author / user / assistant。每条 NoteSource 至少绑定一个来源对象；Note 至少有一个 NoteSource。

### 3.12 Memory

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；thread_id UUID NOT NULL FK → Thread.id；current_version_id UUID NOT NULL FK → MemoryVersion.id；created_at TIMESTAMP NOT NULL；updated_at TIMESTAMP NOT NULL。

约束：Memory 只是不可变版本链的聚合根，不保存可变的 content、status、memory_type 等正文语义字段；所属 BookRevision 通过 Thread.book_revision_id 唯一确定。current_version_id 指向当前有效版本；写入首个版本的事务提交后必须非 NULL。认知演变一律追加新的 MemoryVersion，不得原位覆盖历史版本。

### 3.13 MemoryVersion

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；memory_id UUID NOT NULL FK → Memory.id；version INTEGER NOT NULL；previous_version_id UUID NULL FK → MemoryVersion.id；change_kind TEXT NOT NULL（new / supplement / correction / conflict / rejection / extension）；title TEXT NOT NULL；viewpoint TEXT NOT NULL（user / author / assistant_inference）；content TEXT NOT NULL；confidence REAL NOT NULL（0–1）；ambiguity REAL NOT NULL（0–1）；evaluation_score REAL NOT NULL（0–1）；source_message_ids JSON NOT NULL；source_references JSON NOT NULL；created_at TIMESTAMP NOT NULL。

约束：(memory_id, version) UNIQUE。版本不可变、追加写：首个版本必须 version=1、previous_version_id=NULL、change_kind=new；后续版本必须 version=前驱 version+1、previous_version_id=前驱 id，且 change_kind≠new。source_message_ids 必须非空、去重，且全部属于 Memory 所属 Thread；source_references 必须绑定当前 BookRevision 的结构节点和 locator，不允许引用其他版本或未提供的节点。confidence / ambiguity / evaluation_score 范围 0–1。MemoryVersion 是认知正文的唯一权威，不再单独维护 MemorySource 表。

### 3.14 MemoryRelation

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；from_version_id UUID NOT NULL FK → MemoryVersion.id；to_version_id UUID NOT NULL FK → MemoryVersion.id；relation_type TEXT NOT NULL（supports / contradicts / extends / supersedes / retracts / duplicate_of）；source_message_ids JSON NOT NULL；source_references JSON NOT NULL；created_at TIMESTAMP NOT NULL。

约束：(from_version_id, to_version_id, relation_type) UNIQUE；from 与 to 不得相同；方向表示新版本指向被关联的既有版本。关系是版本链之外的跨认知补充，不得替代 previous_version_id 版本链；所有关系必须携带来源证据。change_kind 与 relation_type 的必选/可选对应关系见 [用户认知记忆](user-memory.md#六类认知变化)。

### 3.14.1 记忆模型迁移映射

本表用于把早期文档中的「可变 Memory + from/to 关系」与「user-memory.md 内联演进」映射到上述唯一模型；实现以 SQLite 现有 `memory` / `memory_version` / `memory_relation` 表为准。

| 旧字段或旧模型 | 新位置 | 迁移规则 |
|---|---|---|
| Memory.content | MemoryVersion.content（version=1） | 首个版本 change_kind=new，previous_version_id=NULL |
| Memory.status=active | Memory.current_version_id | 无独立状态列；当前版本即有效认知 |
| Memory.status=superseded | MemoryVersion 版本链 | 存在后继版本即视为被取代，不写状态列 |
| Memory.status=retracted | 新 MemoryVersion（change_kind=rejection） | 追加撤回版本，并通过 MemoryRelation.retracts 指向被撤回版本 |
| Memory.status=deleted | 本地删除策略 | 不进入版本枚举；删除与备份表达见第 6 节 |
| Memory.memory_type | MemoryVersion.viewpoint + title | author_view→author；user_view→user；AI 组织/解释→assistant_inference |
| Memory.source_message_ids / citation_ids | MemoryVersion.source_message_ids / source_references | 内联到版本，不再拆 MemorySource 表 |
| Memory.reading_round_id | Thread + Message 来源链 | 阅读轮次由来源消息与会话上下文推导，不单独存储 |
| previous_memory_id | previous_version_id | 指向同一条 Memory 的前一个版本 |
| evolution_relation=supplement | change_kind=supplement + supports | 同链追加版本，可选跨认知关系 |
| evolution_relation=revise | change_kind=correction + supersedes | 同链追加版本，可选跨认知关系 |
| evolution_relation=conflict | change_kind=conflict + contradicts | 同链追加版本，必须携带 contradicts |
| evolution_relation=overturn | change_kind=rejection + retracts | 同链追加版本，必须携带 retracts |
| evolution_relation=extend | change_kind=extension + extends | 同链追加版本，必须携带 extends |
| MemoryRelation.from_memory_id / to_memory_id | from_version_id / to_version_id | 端点从认知 ID 提升为版本 ID |
| relation_type=supplements / corrects / conflicts / overturns / extends | supports / supersedes / contradicts / retracts / extends | 枚举按实现归一化；新增 duplicate_of 用于去重关系 |

SQLite schema 迁移次序：v1 建立 `memory` + `memory_version` 基线；v2 建立 `memory_relation`（from_version_id / to_version_id，含 6 类关系 CHECK）；v4 为 `memory_version` 增加 title / viewpoint / confidence / ambiguity / evaluation_score；v5 增加 `memory_candidate`。旧库 `user_version=0` 按 v1 基线处理后再逐级迁移，不得跳级写入。

### 3.15 GenerationReceipt

字段：id UUID PK；generation_id TEXT NOT NULL；thread_id UUID NOT NULL FK；local_user_message_id UUID NOT NULL FK → Message.id；status TEXT NOT NULL（submitted / streaming / completed / failed / cancelled / expired）；created_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；result_message_id UUID NULL FK → Message.id；last_event_sequence INTEGER NOT NULL DEFAULT 0；error_code TEXT NULL。

约束：generation_id UNIQUE；一个用户消息可关联多次生成尝试，但每次尝试独立 receipt；最终结果落成本地 Assistant Message 后才算本地持久化完成。

### 3.16 BackupJournal

字段：local_dataset_id UUID NOT NULL FK；dirty_sequence INTEGER NOT NULL；entity_type TEXT NOT NULL（thread / message / readingRound / readingPosition / readingRoundState / readingUnitProgress / presentedSource / citation / note / memory / memoryVersion / memoryRelation / memoryCandidate / generationDelivery）；entity_id TEXT NOT NULL；operation TEXT NOT NULL（upsert / delete）；changed_at TIMESTAMP NOT NULL。

主键与唯一约束：(local_dataset_id, dirty_sequence, entity_type, entity_id)。同一事务的多条变更共享同一 sequence；同一实体在同一事务内多次变更只保留最终操作。Journal 是增量备份的唯一变更依据：备份必须只从 journal 取 dirty_sequence > 上次已备份序号的条目，且 journal 必须完整覆盖快照差异，缺失条目时备份失败关闭，不得退回全量差分或静默生成看似成功的增量。备份确认后删除 sequence ≤ last_acked_sequence 的条目。Journal 不代表跨设备同步日志。

### 3.17 MigrationLog

字段：id UUID PK；local_dataset_id UUID NOT NULL FK；from_schema_version INTEGER NOT NULL；to_schema_version INTEGER NOT NULL；started_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；status TEXT NOT NULL（started / completed / failed / rolled_back）；snapshot_ref TEXT NULL；error_code TEXT NULL。

约束：to_schema_version 必须高于 from_schema_version；迁移前必须建立可恢复快照；失败不得标记目标版本已完成。

## 4. 服务端账号与备份域

### 4.1 Account / ExternalIdentity

Account：id UUID PK；status TEXT NOT NULL（active / suspended / deleted）；created_at TIMESTAMP NOT NULL；deleted_at TIMESTAMP NULL。  
ExternalIdentity：id UUID PK；account_id UUID NOT NULL FK；provider TEXT NOT NULL；provider_subject TEXT NOT NULL；status TEXT NOT NULL（active / revoked）；created_at TIMESTAMP NOT NULL。  
约束：(provider, provider_subject) UNIQUE。Account 只代表身份，不是私人数据容器。注销不得级联删除备份密文。

### 4.2 BackupManifest

字段：backup_id UUID PK；dataset_id UUID NOT NULL；device_id UUID NOT NULL；lineage_id UUID NOT NULL；fork_id UUID NOT NULL；schema_version INTEGER NOT NULL；cipher_suite TEXT NOT NULL；key_version INTEGER NOT NULL；ciphertext_hash TEXT NOT NULL；ciphertext_size INTEGER NOT NULL；created_at TIMESTAMP NOT NULL；backup_sequence INTEGER NOT NULL；parent_backup_id UUID NULL；backup_type TEXT NOT NULL（full / incremental）；status TEXT NOT NULL（uploading / committed / rejected / inaccessible）。

约束：(lineage_id, fork_id, backup_sequence) UNIQUE；incremental 必须有已提交 parent_backup_id；full 不得依赖父备份恢复。backup_sequence 在每个 fork 内独立从 1 递增，不与本地 dirty_sequence 复用，也不因跨设备恢复而重置冲突。device_id 标识安装实例；lineage_id 在恢复前后保持稳定，表示同一逻辑数据集；fork_id 标识恢复/分叉分支，跨设备恢复必须生成新 fork_id，不得沿用源 fork。恢复链只要求 lineage_id 一致，允许 device_id/fork_id 在链中变化。Manifest 仅允许最小必要元数据，不含私人正文、标题或可推断敏感内容的字段。

### 4.3 BackupUploadSession

字段：id UUID PK；dataset_id UUID NOT NULL；backup_id UUID NOT NULL FK；idempotency_key TEXT NOT NULL；expected_parts INTEGER NOT NULL；received_parts INTEGER NOT NULL DEFAULT 0；expires_at TIMESTAMP NOT NULL；status TEXT NOT NULL（open / completing / completed / expired / rejected）；created_at TIMESTAMP NOT NULL。

约束：(dataset_id, idempotency_key) UNIQUE；分块按 part_no 唯一并记录密文哈希；会话完成前不得出现在可恢复清单。

### 4.4 BackupAuthorization

字段：id UUID PK；dataset_id UUID NOT NULL；backup_id UUID NULL；authorization_method TEXT NOT NULL（recovery_credential）；created_at TIMESTAMP NOT NULL；expires_at TIMESTAMP NOT NULL；used_at TIMESTAMP NULL；status TEXT NOT NULL（active / used / expired / revoked）；revoked_at TIMESTAMP NULL。

约束：所有授权在下载和恢复时都必须重新检查 DataSetLifecycle；清除墓碑优先于授权状态；授权短时、单用途或受严格重放保护。不得将恢复凭证明文存储在服务端。

### 4.5 DataSetLifecycle

字段：dataset_id UUID PK；status TEXT NOT NULL（active / cleared / inactive）；cleared_at TIMESTAMP NULL；clear_reason TEXT NULL；audit_ref TEXT NULL；updated_at TIMESTAMP NOT NULL。

约束：cleared 为不可逆状态；普通账号登录、数据修复、备份上传或授权流程不得恢复 active。所有下载、恢复、重新关联、上传完成和授权签发路径都必须先检查该状态。

### 4.6 RecoveryChallenge

字段：id UUID PK；recovery_key_id_hash TEXT NOT NULL；challenge_nonce_hash TEXT NOT NULL；status TEXT NOT NULL（issued / consumed / expired）；created_at TIMESTAMP NOT NULL；expires_at TIMESTAMP NOT NULL；consumed_at TIMESTAMP NULL；failed_attempts INTEGER NOT NULL DEFAULT 0。

约束：挑战一次性消费；同一 challenge_id 不得重复签发 BackupAuthorization；过期或已消费挑战为终态。recovery_key_id_hash 与 challenge_nonce_hash 的具体算法、是否使用带密钥摘要、失败次数阈值和保留期限由安全设计冻结；不得存储恢复凭证明文或可直接重放的 challenge proof。API 的 recovery_key_id 是外部标识，不等同恢复凭证秘密。

### 4.7 GenerationJob

字段：id UUID PK；client_generation_id TEXT NOT NULL；request_id TEXT NOT NULL；account_id UUID NOT NULL FK；status TEXT NOT NULL（queued / running / cancel_requested / completed / failed / cancelled / expired）；created_at TIMESTAMP NOT NULL；expires_at TIMESTAMP NOT NULL；completed_at TIMESTAMP NULL；result_payload_ciphertext TEXT NULL；result_hash TEXT NULL；error_code TEXT NULL。

约束：(account_id, client_generation_id) UNIQUE；短 TTL；cancel_requested 为非终态；取消与自然完成/失败竞态由服务端原子提交唯一终态。服务端只暂存生成任务必需的输入输出，不成为 Thread/Message 历史主库。不得在通用日志中记录正文。

## 5. 关键唯一约束与索引

| 实体 | 约束/索引 |
|---|---|
| BookRevision | (book_id, status)，(book_id, processing_status)，source_hash |
| BookStructureNode | (book_revision_id, parent_id, order_index) UNIQUE |
| BookChunk | (book_revision_id, chunk_index) UNIQUE；(structure_node_id) |
| ShelfEntry | (local_dataset_id, book_revision_id) UNIQUE；(local_dataset_id, shelf_status) |
| Thread | (local_dataset_id, book_revision_id) UNIQUE |
| Message | (thread_id, sequence) UNIQUE；(thread_id, idempotency_key) UNIQUE |
| ReadingRound | (thread_id, round_number) UNIQUE；活动轮次部分唯一索引 |
| PresentedSource | (reading_round_id, presentation_type, presented_at) |
| Citation | (message_id)，(book_revision_id, chunk_id) |
| Note | (local_dataset_id, status, updated_at) |
| Memory | (local_dataset_id, thread_id, updated_at)；(thread_id, current_version_id) |
| MemoryVersion | (memory_id, version) UNIQUE；(memory_id, previous_version_id) |
| MemoryRelation | (from_version_id, to_version_id, relation_type) UNIQUE |
| BackupManifest | (lineage_id, fork_id, backup_sequence) UNIQUE；(dataset_id, status, created_at) |
| BackupUploadSession | (dataset_id, idempotency_key) UNIQUE |
| ExternalIdentity | (provider, provider_subject) UNIQUE |
| AccountDataSetBinding | (local_dataset_id) WHERE binding_status='active' UNIQUE；(account_id, local_dataset_id) |
| RecoveryChallenge | (status, expires_at)；(recovery_key_id_hash, created_at) |
| GenerationJob | (account_id, client_generation_id) UNIQUE |

部分唯一索引、外键延迟策略和 JSON 校验方式须在目标 SQLite / 服务端数据库 PoC 中确认，不能只依赖 ORM 层校验。

## 6. 删除、归档与级联规则

1. 移出书架：ShelfEntry 软删除；不得级联删除 Thread、Message、ReadingRound、Citation、Note、Memory。
2. 删除 Note：状态改为 deleted；删除 Memory：按本地删除策略处理，不以新增版本或状态列伪造删除，不得静默覆盖或重写来源历史。
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
- MemoryVersion.change_kind 与 MemoryRelation.relation_type 的演变方向
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
