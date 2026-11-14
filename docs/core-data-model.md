# 核心数据模型与 API 契约草案
> 状态：设计草案，尚未进入知行业务代码开发。用户个人阅读数据以本地为主存储，服务器只保存加密备份；公共书籍与全书知识库由服务器管理。

## 1. 设计边界
- 公共内容数据：Book、BookRevision、BookKnowledgeBase、BookStructureNode、BookKnowledgeItem、BookChunk，由服务器管理。
- 用户私人数据：书架权益、Thread、Message、原文展示记录、ReadingRound、Note、Memory，以用户设备本地数据库为主存储，服务器只保存加密备份。
- 服务端账号、认证关系和备份索引是平台数据，不构成用户私人阅读数据在线主库。

## 2. 公共书籍实体
### Book
- id、title、author、description、cover_asset_id、category_id、status、created_at、updated_at。
### BookRevision
- id、book_id、edition、translator、publisher、language、source_hash、processing_version、processing_status（加工尝试）、status（发布状态）、published_at。
- 每个版本拥有独立原文、结构、知识库和引用定位。
### BookKnowledgeBase
- id、book_revision_id、processing_version、status、quality_report_id、created_at、published_at。
- 必须绑定具体 BookRevision，不覆盖旧版本知识库。
### BookStructureNode
- id、book_revision_id、parent_id、node_type、title、order_index、source_locator、content_hash。
- 表示作者原书结构和语义完整的论述单元。
### BookKnowledgeItem
- id、book_revision_id、structure_node_id、item_type、content、source_chunk_ids、confidence。
- 每条知识项必须能追溯到原文切片。
### BookChunk / Embedding
- chunk_id、book_revision_id、structure_node_id、content、source_locator、content_hash。
- Embedding 仅用于检索，不能替代原文引用依据。

## 3. 用户本地数据实体
以下实体首先存在于本地数据库；服务端不维护其可读明文副本。
### LocalDataSet
- local_dataset_id、schema_version、created_at、updated_at、last_backup_id、last_backup_at、local_key_metadata。
### ShelfEntry
- local_dataset_id、book_revision_id、added_at、removed_at、shelf_status、entitlement_proof。
- 加入某 BookRevision 即获得该版本永久访问权；新版需单独加入。
- 移出书架只隐藏条目，不删除权益或历史数据。
### Thread
- id、local_dataset_id、book_revision_id、status、created_at、updated_at、version。
- 本地唯一约束：(local_dataset_id, book_revision_id)。
- 同一用户数据集对同一具体版本只有一个长期 Thread；不同版本可有不同 Thread。
### Message
- id、thread_id、sequence、role、content、content_format_version、status、model、token_usage、created_at、completed_at、idempotency_key、supersedes_message_id。
- 追加写；重新生成创建新 Assistant Message，不覆盖旧消息。
### PresentedSource
- id、thread_id、book_revision_id、structure_node_id、chunk_id、presentation_type、reading_round_id、presented_at、source_locator。
- presentation_type 区分 mainline、review、temporary。
### ReadingRound / ReadingRoundState
- ReadingRound：id、thread_id、round_number、status、started_at、completed_at、start_reason。
- ReadingRoundState：reading_round_id、current_structure_node_id、current_order_index、last_presented_source_id、updated_at。
- 复习和临时查看不得修改主线状态。
### Citation
- id、message_id、book_revision_id、chunk_id、structure_node_id、source_locator、quote、source_hash。
- 每条引用固定到具体 BookRevision。
### Note
- id、local_dataset_id、book_revision_id、type、title、content、source_type、version、source_message_ids、citation_ids、reading_round_id。
- 用户可编辑或删除；AI 不得静默覆盖用户编辑。
### Memory / MemoryVersion
- Memory：id、local_dataset_id、thread_id、current_version_id、created_at、updated_at。只是不可变版本链的聚合根，不保存可变正文。
- MemoryVersion：id、memory_id、version、previous_version_id、change_kind（new/supplement/correction/conflict/rejection/extension）、title、viewpoint（user/author/assistant_inference）、content、confidence、ambiguity、evaluation_score、source_message_ids、source_references、created_at。
- 认知演变只追加版本并关联前驱，不覆盖旧观点；跨认知关系由 MemoryRelation 单独记录。

## 4. 服务端账号与备份实体
### Account / ExternalIdentity
- Account 代表身份和认证关系，不是用户私人数据容器。
- ExternalIdentity：id、account_id、provider、provider_subject、created_at、status；(provider, provider_subject) 唯一。
### BackupManifest
- backup_id、local_dataset_id、device_id、lineage_id、fork_id、schema_version、cipher_suite、key_version、ciphertext_hash、ciphertext_size、created_at、backup_sequence、parent_backup_id、backup_type（full/incremental）。
- backup_sequence 在每个 fork 内独立递增，不复用 dirty_sequence；跨设备恢复生成新 fork_id，lineage_id 保持稳定。
- 本地记录 last_backup_at、last_backup_id、last_backup_status、pending_change_marker；应用每次打开时检查是否存在待备份变更。
- 只保存密文和最小必要元数据，不保存可读私人内容。
### BackupAuthorization
- backup_id、authorization_method、created_at、expires_at、used_at、status、deleted_at。
- 账号注销后仍可通过独立恢复凭证授权下载；数据集被清除后，所有相关授权必须失效化，不能再签发新授权。

### DataSetLifecycle / DataSetTombstone
- local_dataset_id、status（active/cleared/inactive）、cleared_at、clear_reason、audit_ref。
- 服务端仅保留最小必要的生命周期状态和审计信息，用于阻断已清除数据集的访问；不保存可读私人内容。
- 清除个人数据时，原始加密备份密文、解密密钥材料及其他原始数据不做物理删除或改写；用户关联索引和可用授权信息软删除/失效化。
- `cleared` 状态不可由普通账号登录、恢复或数据修复流程自动逆转。

## 5. API 路径历史草案（已废止）

> 本节路径仅作为早期讨论记录，不得用于实现或新增接口。第一阶段 API 的唯一权威来源为 [OpenAPI 3.1 契约](api-contract.yaml)。

早期路径（全部废止）：
- `POST /backups`
- `GET /backups`
- `POST /backups/{id}/download-ticket`
- `GET /backups/{id}/download`
- `POST /recovery/authorize`
- `GET /recovery/backups`
- `POST /account/deletion`
- `POST /data-set/{id}/clear`

当前启动与备份业务原则不变：应用打开时检查本地数据集与最近成功备份；存在未备份变更时生成全量/增量密文备份并上传。离线或失败时保留待备份标记，不阻断本地使用。第一版不提供多设备实时同步。

## 6. 一致性与生命周期约束
1. 书架权益绑定 BookRevision，而不是可变的 Book 当前版本。
2. 同一 LocalDataSet + BookRevision 只有一个 Thread。
3. 一个 Thread 下可以有多个顺序递增的 ReadingRound。
4. 全书主线所有章节/论述单元完成展示和讨论后，ReadingRound 才可标记 completed。
5. 临时展示、复习不改变 ReadingRoundState。
6. Message、PresentedSource、Citation、Note、Memory 保留来源关系。
7. 认知演变创建新记录并关联旧记录，不覆盖旧记录。
8. 账号注销不得级联删除 LocalDataSet 或 BackupManifest.
9. 用户清除个人数据时，服务器保留 BackupManifest 对应的原始密文和密钥材料；仅软删除用户关联索引和可用授权，并将数据集标记为不可用。
10. 已清除数据集不得通过常规业务流程重新关联、读取、下载或恢复。
11. 切换账号不自动迁移、合并或同步；恢复必须经显式备份下载流程。同设备数据集必须按账号上下文隔离。
12. 离线可查看已缓存内容；AI 对话、跨章节检索和未缓存内容获取需要联网，离线编辑先写入本地。
13. 新 BookRevision 不继承旧版本 Thread、Citation 或访问权益。

## 7. 历史待验证项（小程序路线，已不属于第一阶段）

> 本节原有小程序平台相关验证项保留为历史记录；第一阶段 PC Web 的有效验证范围见第 8 节及 docs/pc-web-poc-plan.md。
- 小程序本地数据库容量、事务、后台任务和加密能力。
- 本地密钥安全存储、恢复凭证格式和密钥轮换。
- 启动时备份检查、备份包全量/增量格式、版本兼容和历史保留。
- 账号注销后备份恢复授权与反滥用机制。
- 不同设备恢复同一备份后的分叉处理。
- 本地书架权益凭证的签发、离线校验与长期可用性。


## 8. PC Web 本地数据与备份协议补充（2026-11-13）

完整协议见 [PC Web 详细技术设计](pc-web-detailed-design.md)。

### 8.1 本地数据实体补充
- LocalDataSetMeta：schema_version、dirty_sequence、last_acked_sequence、active_account_context、created_at、updated_at。
- AccountDataSetBinding：account_id、local_dataset_id、binding_status、bound_at、last_selected_at。绑定必须显式，不因登录态变化自动切换数据集。
- GenerationReceipt：generation_id、thread_id、local_user_message_id、status、created_at、completed_at、result_message_id、last_event_sequence。仅用于本地恢复生成状态。
- NoteSource：note_id、source_message_id、citation_id、source_role、source_locator。
- MemoryVersion：memory_id、version、previous_version_id、change_kind、title、viewpoint、content、confidence、ambiguity、evaluation_score、source_message_ids、source_references。来源内联在版本上，不单独拆 MemorySource 表。
- MemoryRelation：from_version_id、to_version_id、relation_type（supports/contradicts/extends/supersedes/retracts/duplicate_of）、source_message_ids、source_references、created_at。
- BackupJournal：local_dataset_id、dirty_sequence、entity_type、entity_id、operation（upsert/delete）、changed_at。用于同一数据集增量备份，不用于跨设备同步。增量备份只读取 journal，且 journal 必须覆盖快照全部变更，否则失败关闭。
- MigrationLog：from_schema_version、to_schema_version、started_at、completed_at、status、snapshot_ref。

### 8.2 关键约束
1. 一个 LocalDataSet 同时最多有一个活动写入者；多标签页通过锁与消息广播协调。
2. Message、Note、Memory 和来源关系均由本地事务保证一致性。
3. GenerationJob 在服务端是短暂计算任务；GenerationReceipt 在本地保存任务与正式 Message 的关联。
4. 服务端生成结果必须可按 generation_id 查询，客户端最终将结果写入本地。
5. dirty_sequence 单调递增；只有服务端确认备份提交后才能推进 last_acked_sequence。
6. 增量备份必须绑定 parent_backup_id，且 payload 只能由 BackupJournal 生成；父链不完整或 journal 未覆盖全部变更时不得继续增量恢复。
7. backup_sequence 在每个 fork 内独立递增，不复用 dirty_sequence；跨设备恢复生成新 fork_id，避免与源 fork 的 (lineage_id, fork_id, backup_sequence) 唯一约束冲突。
8. 清除数据集墓碑优先于普通备份索引；并发上传完成请求不得复活已清除数据集。
9. 本地数据库 schema_version 与加密备份包 schema_version 独立管理。

### 8.3 权益凭证补充
ShelfEntry.entitlement_proof 不能只作为客户端自报字段。必须定义服务端签发的签名凭证，至少绑定 account、book_revision_id、entitlement_id、issued_at、signature_version 和权益状态。离线时校验签名和缓存权限；在线获取新内容时服务端再次校验。永久权益不得因商城下架失效，新版本仍需单独加入。

### 8.4 设计状态
以上字段和约束属于详细设计草案，尚未形成数据库迁移或正式 API；须经 PoC、安全评审和接口契约评审后冻结。

## 9. 权威契约索引（2026-11-13）

为消除字段、路径和状态定义分散的问题，以下文件作为后续设计与实现的权威来源：

| 契约范围 | 权威文件 | 说明 |
|---|---|---|
| 实体字段、类型、必填、关系、唯一约束、删除语义 | [核心数据字典](data-dictionary.md) | 本文档前文保留概念模型；字段实施以数据字典为准 |
| HTTP API 路径、方法、参数、请求/响应和错误结构 | [OpenAPI 3.1 契约](api-contract.yaml) | 本项目唯一 API 路径权威来源 |
| PC Web 部署、存储与客户端架构 | [PC Web 详细技术设计](pc-web-detailed-design.md) | 需与 API 契约保持一致 |
| 阅读主线及消息状态转换 | [状态机契约](state-machines.md) | 状态转换权威来源；讨论语义边界仍有待确认项 |

禁止在其他文档中独立维护一套 API 路径表。若发现冲突，先修改权威契约，再更新引用文档；旧路径必须明确标注废止。
