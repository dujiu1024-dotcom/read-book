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
- id、book_id、edition、translator、publisher、language、source_hash、processing_version、status、published_at。
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
### Memory
- id、local_dataset_id、book_revision_id、memory_type、content、status、source_message_ids、citation_ids、reading_round_id、evolution_relation、previous_memory_id。
- 认知演变建立新记录并关联旧记录，不覆盖旧观点。

## 4. 服务端账号与备份实体
### Account / ExternalIdentity
- Account 代表身份和认证关系，不是用户私人数据容器。
- ExternalIdentity：id、account_id、provider、provider_subject、created_at、status；(provider, provider_subject) 唯一。
### BackupManifest
- backup_id、local_dataset_id、schema_version、cipher_suite、key_version、ciphertext_hash、ciphertext_size、created_at、backup_sequence、parent_backup_id、backup_type（full/incremental）。
- 本地记录 last_backup_at、last_backup_id、last_backup_status、pending_change_marker；应用每次打开时检查是否存在待备份变更。
- 只保存密文和最小必要元数据，不保存可读私人内容。
### BackupAuthorization
- backup_id、authorization_method、created_at、expires_at、used_at。
- 账号注销后仍可通过独立恢复凭证授权下载。

## 5. 备份与恢复 API 草案

启动流程：应用打开 → 检查本地数据集与最近成功备份 → 有变更则生成全量/增量密文备份并上传 → 更新本地备份状态。离线或失败时保留待备份标记，不阻断本地使用。新设备无本地数据时提示用户是否恢复；第一版不提供多设备实时同步。
| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /backups | 上传加密备份并创建记录 |
| GET | /backups | 获取当前授权可访问的备份清单 |
| POST | /backups/{id}/download-ticket | 创建短时下载授权 |
| GET | /backups/{id}/download | 下载密文备份 |
| POST | /recovery/authorize | 使用独立恢复凭证授权恢复 |
| GET | /recovery/backups | 查询恢复凭证可访问的备份 |
| POST | /account/deletion | 注销账号，不删除备份数据 |

## 6. 一致性与生命周期约束
1. 书架权益绑定 BookRevision，而不是可变的 Book 当前版本。
2. 同一 LocalDataSet + BookRevision 只有一个 Thread。
3. 一个 Thread 下可以有多个顺序递增的 ReadingRound。
4. 全书主线所有章节/论述单元完成展示和讨论后，ReadingRound 才可标记 completed。
5. 临时展示、复习不改变 ReadingRoundState。
6. Message、PresentedSource、Citation、Note、Memory 保留来源关系。
7. 认知演变创建新记录并关联旧记录，不覆盖旧记录。
8. 账号注销不得级联删除 LocalDataSet 或 BackupManifest。
9. 切换账号不自动迁移、合并或同步；恢复必须经显式备份下载流程。
10. 新 BookRevision 不继承旧版本 Thread、Citation 或访问权益。

## 7. 待验证
- 小程序本地数据库容量、事务、后台任务和加密能力。
- 本地密钥安全存储、恢复凭证格式和密钥轮换。
- 启动时备份检查、备份包全量/增量格式、版本兼容和历史保留。
- 账号注销后备份恢复授权与反滥用机制。
- 不同设备恢复同一备份后的分叉处理。
- 本地书架权益凭证的签发、离线校验与长期可用性。
