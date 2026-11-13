# 核心数据模型与 API 契约草案

> 状态：方案草案，供评审；尚未进入业务代码开发。
> 设计基准：用户通过与 Agent 对话来读书；一本书对应一个用户唯一的长期对话。云端是正式数据权威端，客户端本地存储只做缓存、草稿和待同步队列；具体使用小程序本地存储、IndexedDB、SQLite 或其他机制由入口平台决定。

## 1. 设计边界

第一版核心闭环：用户登录、浏览书城、加入书架、打开书籍并获取唯一 Thread、发送消息、云端检索原文并调用模型、保存消息与引用、整理笔记和认知记忆、手机缓存与同步。

不建模：阅读进度、打卡、计划、提醒、章节会话、话题分支、社交关系、复杂知识图谱。

## 2. 核心实体

### User
- id：UUID 主键
- 登录标识：email / phone，按最终登录方案选用
- display_name：显示名称
- status：active / disabled
- created_at、updated_at

认证凭证和第三方登录密钥不放入用户公共资料字段。

### Book 与 BookRevision

Book 表示书目；BookRevision 表示具体版本。不同译本、出版社或文件版本不能混成同一份正文。

**Book**
- id、title、author、description、cover_asset_id、category_id
- status：draft / available / unavailable
- created_at、updated_at

**BookRevision**
- id、book_id、edition、translator、publisher、language
- source_hash：原始文件哈希
- processing_version：处理引擎版本
- status：uploaded / processing / review / published / rejected
- published_at

书架和 Thread 关联 Book，不直接绑定文件路径。检索时由服务端确定可用的已发布版本；每条 Citation 固定 revision_id，保证历史引用可追溯。

### UserBook（书架）
- user_id、book_id
- personal_tags：可选的轻量个人标签
- added_at
- 唯一约束：(user_id, book_id)

不增加 progress、last_read_position、daily_goal 等字段。

### Thread（唯一长期对话）
- id、user_id、book_id
- status：active / archived
- created_at、updated_at
- version：并发控制版本

**关键约束：数据库唯一索引 (user_id, book_id)。**

获取或创建 Thread 必须由服务端原子完成（事务 + 唯一约束冲突后重新读取），禁止客户端自行生成多个 Thread。章节、日期、主题和退出/重新进入均不得创建新 Thread。

### Message
- id、thread_id、sequence
- role：user / assistant / system / tool
- content：正文
- status：pending / streaming / completed / failed / cancelled
- model、token_usage
- created_at、completed_at
- 可选 supersedes_message_id：重新生成时关联被替代的回答

约束：
- (thread_id, sequence) 唯一。
- 客户端发送携带 idempotency_key，防止网络重试产生重复消息。
- 用户消息先持久化，再开始模型生成。
- Assistant 消息可分块流式返回，但最终必须形成可恢复的完整记录。
- 重新生成建立新的 assistant 消息，不覆盖旧消息。
- 工具调用和推理中间态默认不作为普通用户消息展示。

### Citation（原文引用）
- id、message_id、book_revision_id、chunk_id
- chapter_id、chapter_title、page_number
- locator：格式专属定位，如 EPUB CFI
- quote：实际引用片段
- source_hash：引用内容哈希

引用必须指向实际书籍版本和原文片段。模型生成的概括不能伪装成逐字引文；作者原文、思想推演和 AI 模拟回答应有明确类型标记。

### Note（读书笔记）
- id、user_id、book_id
- type：summary / insight / question / practice / other
- title、content
- source：ai_generated / user_edited
- version：乐观锁版本
- source_message_ids、citation_ids
- created_at、updated_at

AI 自动整理和用户主动编辑必须区分。用户编辑后，AI 不能静默覆盖；新生成结果应形成建议版本或差异，交由用户决定是否采纳。笔记属于私人数据，管理员默认不可见。

### Memory（认知记忆）

Note 是用户可查看的整理结果；Memory 是 Agent 组织后续对话时使用的结构化上下文。

- id、user_id、book_id（可为空，表示跨书）
- type：author_claim / user_understanding / user_opinion / hypothesis / open_question / practice
- content
- stance：agree / disagree / uncertain / neutral
- source_message_ids、citation_ids
- status：active / superseded / resolved
- supersedes_id：被哪条新记忆替代
- created_at、updated_at

规则：
- 不把 AI 的观点记为用户观点。
- 不把用户推测升级成客观事实。
- 观点变化通过新记录和 supersedes 关系保留演进，不覆盖旧记录。
- 每条记忆必须能追溯到消息；作者观点还应尽量关联原文引用。
- 按 user_id 强隔离，跨书记忆也不能跨用户共享。

## 3. 书籍处理数据

书籍处理独立于聊天业务，建议包括：
- ingestion_batch：一次上传/导入任务。
- book_revision：不可变的书籍内容版本。
- processing_stage：解析、OCR、清洗、章节识别、切片、向量化、验收等阶段状态。
- book_chunk：正式原文切片及章节/页码/定位。
- chunk_embedding：向量及模型、版本、维度、预处理元数据。
- source_asset：原始文件与派生产物对象存储引用。

每次重处理创建新 revision，不直接覆盖已发布版本。聊天引用固定到 revision，确保书籍更新后旧引用仍可回溯。

## 4. 第一版 API 契约

统一前缀：/api/v1。所有接口从认证上下文获取 user_id，不允许客户端通过请求体指定或覆盖 user_id。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /books | 书城分页、搜索、筛选 |
| GET | /books/{book_id} | 书籍详情及可用版本 |
| GET | /me/shelf | 当前用户书架 |
| PUT | /me/shelf/{book_id} | 加入书架（幂等） |
| DELETE | /me/shelf/{book_id} | 移出书架 |
| POST | /books/{book_id}/thread | 获取或创建唯一 Thread |
| GET | /threads/{thread_id}/messages | 分页获取历史消息 |
| POST | /threads/{thread_id}/messages | 创建用户消息并启动 Agent |
| POST | /messages/{message_id}/regenerate | 基于指定回答重新生成 |
| GET | /me/notes | 当前用户笔记列表 |
| PATCH | /notes/{note_id} | 编辑笔记，要求 If-Match/version |
| GET | /me/memories | 当前用户记忆（第一版可仅内部接口） |

### 获取或创建 Thread

POST /books/{book_id}/thread

1. 校验用户身份、书籍状态和访问权限。
2. 校验用户已将书籍加入书架（如产品规则要求）。
3. 查询 (user_id, book_id) 唯一 Thread。
4. 不存在则创建；若并发创建触发唯一约束冲突，则重新读取已有 Thread。
5. 返回同一个 thread_id 和必要的最新消息摘要。

响应不表达“上次阅读位置”，不自动触发续读。

### 发送消息

POST /threads/{thread_id}/messages

请求字段：
- client_message_id：客户端生成 UUID
- idempotency_key：本次发送唯一键
- content：用户消息正文

服务端必须：
1. 从认证信息取得 user_id，并校验 Thread 所属关系。
2. 持久化用户消息并处理幂等。
3. 加载最近对话、相关历史、相关原文、用户认知记忆和 Agent 规范。
4. 执行检索、模型调用和流式输出。
5. 持久化完整 assistant 消息、引用、模型用量和状态。
6. 异步触发笔记/记忆沉淀；沉淀失败不能导致聊天消息丢失。

流式协议第一版可采用 SSE；需支持断线后按 message_id 查询最终状态和完整内容。模型流式连接不能成为消息持久化的唯一通道。

## 5. 客户端本地缓存与同步

客户端只缓存必要数据，具体存储实现由平台适配层决定：
- book / shelf 元数据。
- thread / message 最近历史。
- note 缓存。
- pending_message 待发送队列。
- sync_cursor / server_version。

同步规则：
1. 云端 ID 是正式 ID；客户端临时记录使用 client_message_id。
2. 每次写请求都支持幂等键。
3. 消息采用追加写，不做静默覆盖。
4. 笔记采用 version / ETag 乐观锁；版本不匹配返回 409 Conflict。
5. 冲突时保留本地草稿和云端正式版，交给用户确认；不自动丢弃任一方。
6. 退出账号时清理或加密隔离本地私人缓存。
7. 管理端 API 不提供读取用户 Thread、Message、Note、Memory 的能力。

## 6. 权限与数据隔离

- 所有用户私有表均包含 user_id，或通过 Thread 等父实体校验归属。
- API 每次读取/修改都在服务端做归属校验；不能信任客户端传入的 owner ID。
- 数据库层使用外键、唯一约束；是否启用 Row-Level Security 需结合连接池与服务端角色设计。
- 管理端书籍运营权限与用户私人数据权限分离。
- 运维排障采用受控审计和最小化访问，不默认开放聊天内容。
- 模型 API Key 仅服务端持有，客户端不接触平台密钥。

## 7. 实施顺序与验收

### A. 数据库与领域服务
建立 User、Book、BookRevision、UserBook、Thread、Message。
验收：同一用户对同一本书并发请求 20 次，最终只存在一个 Thread；不同用户互不共享 Thread。

### B. 对话 API
建立消息持久化、幂等、流式响应和历史查询。
验收：断网重试不重复写入；生成中断后可查到失败/取消状态；重新生成不覆盖旧回答。

### C. RAG 与引用
建立 book_chunk、embedding、检索和 citation。
验收：每条引用都能定位到固定书籍版本的原文；不存在引用时不得编造页码或原文。

### D. 笔记与认知记忆
建立 Note、Memory 的来源追溯和版本演进。
验收：用户观点、AI 观点、作者观点不混淆；用户修改笔记不会被后台自动覆盖。

### E. 移动端同步
接入云端 API 和本地缓存。
验收：同账号换设备可恢复书架、Thread、消息和笔记；离线草稿联网后可安全同步。

## 8. 尚待决策

1. 登录方式：手机号、邮箱、Apple/Google 登录，还是先采用单一登录方式。
2. Message 正文格式：纯文本 + 独立 citations，还是支持结构化 parts；第一版建议正文与引用元数据分开。
3. SSE 断线恢复：按 message_id 查询最终结果，还是支持事件 ID 回放；第一版先保证最终消息可恢复。
4. 书籍版本切换：同一 Thread 继续，但每条 Citation 固定旧 revision。
5. 笔记编辑冲突 UI：自动展示差异，用户选择保留本地、云端或手工合并。
6. 记忆抽取频率：第一版建议异步批量，避免增加每轮聊天延迟。

以上决策不影响先行开展 ReadAny 运行验证和 CI 修复。
