# 知行 V1 云端核心数据模型与 API 契约（草案）

> 状态：设计草案，尚未进入业务代码实现。  
> 目标：把“用户通过与 Agent 对话来读书；Agent 不管理阅读过程”落实为最小可实现的云端数据与接口边界。  
> 适用范围：手机端 App、FastAPI 云端服务、管理员工作台。  
> 原则：云端保存正式数据；手机 SQLite 仅缓存和暂存；一个用户对一本书只有一个长期 Thread。

## 1. 设计约束

1. 一本书对应一个长期 Thread。不得按章节、话题、日期或重新打开书籍创建新 Thread。
2. 打开书籍时获取既有 Thread；仅在不存在时创建。数据库唯一约束是最终防线。
3. Message 是原始对话记录，长期保存；摘要和记忆不能替代、覆盖或删除 Message。
4. 书籍原文、切片和向量与聊天记录分开存储；消息引用只保存可追溯定位信息。
5. 用户私人数据必须按 user_id 隔离。管理员默认无权读取 Thread、Message、私人 Note 和用户认知记忆。
6. AI 自动整理与用户主动编辑必须区分来源和版本；用户编辑优先，不允许 AI 静默覆盖。
7. 写接口支持幂等键；消息发送、笔记同步和离线补传不能因重试产生重复记录。
8. 不把阅读进度、打卡、提醒、计划作为核心业务实体。

## 2. 核心实体

| 实体 | 作用 | 归属与约束 |
|---|---|---|
| User | 登录身份与账号状态 | 身份由认证模块确认 |
| Book | 书城展示的书籍逻辑实体 | 公共元数据 |
| BookRevision | 书籍的具体版本和处理版本 | 每次正式入库形成独立版本 |
| BookChunk | 可检索原文切片 | 关联 revision、章节和原文定位 |
| ShelfItem | 用户主动加入书架 | UNIQUE(user_id, book_id) |
| Thread | 用户与一本书之间的唯一长期对话 | UNIQUE(user_id, book_id) |
| Message | Thread 内一条原始消息 | 不因摘要或记忆生成而删除 |
| Citation | 回答引用的原文依据 | 关联 revision/chunk/定位信息 |
| Memory | 从对话中沉淀的结构化认知 | 必须关联来源消息，可修订、可失效 |
| Note | 用户的读书笔记 | 私有数据，区分 AI 生成与用户编辑 |
| NoteRevision | 笔记版本 | 保留用户修改和冲突版本 |

### 2.1 Thread

建议字段：

- id
- user_id
- book_id
- created_at
- updated_at
- last_message_at
- status

数据库约束：

- UNIQUE(user_id, book_id)
- user_id、book_id 建立外键
- 删除书架条目不级联删除 Thread 和 Message

获取或创建逻辑：

1. 用户请求打开某本书。
2. 服务端先按 user_id + book_id 查询 Thread。
3. 已存在则返回原 Thread。
4. 不存在则尝试创建。
5. 并发创建发生唯一键冲突时，重新查询并返回已存在 Thread。

### 2.2 Message

建议字段：

- id
- thread_id
- role：user / assistant / system
- content：原始正文
- status：pending / streaming / completed / failed / cancelled
- client_message_id：客户端生成的幂等标识
- reply_to_message_id：可选
- created_at
- completed_at
- error_code：失败时记录结构化错误码

约束：

- UNIQUE(thread_id, client_message_id)
- 原始消息不可被摘要覆盖。
- 用户消息与助手消息均保留；失败消息可保留状态和错误信息。
- 模型请求、Token 用量、耗时等运行信息可放独立 MessageRun 表，避免污染消息正文。

### 2.3 Citation

建议字段：

- id
- message_id
- book_id
- book_revision_id
- chunk_id
- chapter_id
- chapter_title
- page_number：可空
- start_offset / end_offset：可空
- locator_type：epub_cfi / page_range / paragraph / text_anchor
- quote_text
- created_at

引用必须指向具体书籍版本。书籍更新后，历史回答仍能追溯当时使用的版本和切片。

### 2.4 Memory

第一版采用结构化记录，不做复杂知识图谱。

建议 memory_type：

- user_understanding：用户对内容的理解
- user_opinion：用户明确表达的观点
- author_view：作者在原文中表达的观点
- hypothesis：用户或 Agent 提出的待验证假设
- open_question：尚未解决的问题
- practice：用户提到的实践、经历或应用

建议字段：

- id
- user_id
- book_id
- thread_id
- memory_type
- content
- source_message_ids：来源消息 ID 列表
- source_chunk_ids：相关原文切片 ID 列表，可空
- confidence
- status：active / disputed / superseded / archived
- supersedes_memory_id：可空
- created_at
- updated_at

约束：

- 不得把 AI 推测写成用户事实。
- 不得把作者观点写成用户观点。
- 观点变化时新增或修订关联记录，保留演进关系。
- 记忆检索结果只作为上下文，不替代原始消息。

### 2.5 Note 与 NoteRevision

Note 建议字段：

- id
- user_id
- book_id
- title
- current_revision_id
- created_at
- updated_at

NoteRevision 建议字段：

- id
- note_id
- revision_no
- content
- source_type：ai_generated / user_edited / merged
- source_message_ids
- source_citation_ids
- base_revision_id
- created_at

同步规则：

- 每次修改生成新 revision，不直接覆盖历史版本。
- 客户端提交 base_revision_id。
- 若服务端当前版本已变化，返回 409 Conflict 和当前版本摘要/标识。
- 保留双方内容，由用户决定如何合并；AI 可以提出合并建议，但不能自动覆盖用户编辑。

## 3. V1 API 契约

统一前缀：`/api/v1`。  
认证：Bearer Token；所有私人资源均从认证身份推导 user_id，不接受客户端指定其他 user_id。

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /me | 当前用户信息与账号状态 |
| GET | /books | 书城列表、搜索与筛选 |
| GET | /books/{book_id} | 书籍详情与当前可用版本信息 |
| GET | /shelf | 当前用户书架 |
| POST | /shelf/{book_id} | 加入书架 |
| DELETE | /shelf/{book_id} | 从书架移除，不删除对话 |
| GET | /books/{book_id}/thread | 获取该书唯一 Thread；不存在返回 404 |
| POST | /books/{book_id}/thread | 获取或创建该书唯一 Thread |
| GET | /threads/{thread_id}/messages | 分页读取历史消息 |
| POST | /threads/{thread_id}/messages | 发送消息并以 SSE 流式返回 |
| GET | /books/{book_id}/notes | 获取该用户该书的笔记 |
| POST | /books/{book_id}/notes | 创建笔记 |
| PATCH | /notes/{note_id} | 基于 base_revision_id 提交新版本 |
| GET | /books/{book_id}/memories | 获取该用户该书的认知记忆（内部上下文/受控调试） |

说明：

- `GET /books/{book_id}/thread` 不产生副作用；`POST` 负责幂等获取或创建。
- Message 接口必须校验 Thread 所有权。
- 管理端书籍管理接口独立放在 admin 路由域，不提供读取私人聊天的默认能力。
- 书籍处理、版本发布、索引构建属于后台任务 API，不与用户聊天 API 混在一起。

## 4. 发送消息与流式响应

客户端请求示例：

```json
{
  "client_message_id": "客户端生成的 UUID",
  "content": "我不太认同作者这里的观点，原因是……"
}
```

服务端处理顺序：

1. 校验用户身份、Thread 所有权和书籍可用状态。
2. 按 client_message_id 幂等写入 user Message。
3. 创建 assistant Message，状态为 streaming。
4. 动态组织上下文：最近消息、相关原文、相关历史讨论、认知记忆和 Agent 规范。
5. 调用模型并通过 SSE 返回增量内容。
6. 将最终正文、引用和运行信息持久化。
7. 将 assistant Message 标记 completed；异常时标记 failed。

SSE 事件建议：

- message.started
- message.delta
- citation.added
- message.completed
- message.failed

断线处理：

- 断线不代表服务端生成必然停止。
- 客户端重新连接后通过 GET 历史消息查询最终状态。
- 是否支持按 message_id 恢复流式连接，列为后续增强项。
- 用户主动停止生成时调用独立取消接口；不得把网络断开直接等同于用户取消。

## 5. 权限边界

| 数据 | 普通用户 | 管理员 |
|---|---|---|
| 公共书籍元数据 | 按上架状态读取 | 管理 |
| 原始书籍文件与处理产物 | 不直接访问 | 按书籍管理权限访问 |
| 自己的 ShelfItem | 读写 | 默认不可代替用户操作 |
| 自己的 Thread / Message | 读写 | 默认不可读取 |
| 自己的 Memory / Note | 读写 | 默认不可读取 |
| 其他用户私人数据 | 不可访问 | 默认不可访问 |

管理员排障若确需访问私人数据，必须另设显式授权、审计记录和限时访问流程；V1 不实现默认后台查看入口。

## 6. 本地 SQLite 缓存与同步

本地建议缓存：

- Book 基础元数据
- ShelfItem
- Thread 基础信息
- 最近一段 Message 历史
- Note 当前版本和待同步 revision
- 尚未发送的消息草稿

同步原则：

- 云端 ID 为正式 ID；本地临时 ID 通过映射表关联云端 ID。
- 写操作使用幂等键。
- Message 采用追加写入，不做全文覆盖式同步。
- Note 采用 revision + base_revision_id 乐观锁。
- 同步失败保留本地待同步状态和错误原因。
- 冲突不静默覆盖；用户编辑优先保留。

## 7. 非目标（V1 不做）

- 按章节、话题或日期创建多个 Thread。
- 阅读计划、阅读进度驱动、打卡和提醒。
- 用户可见的复杂 Agent 角色切换。
- 群聊、消息分支、复杂协作编辑。
- 管理员默认查看私人聊天和笔记。
- 跨书知识图谱可视化。
- 为离线优先而设计的多主数据库冲突合并。

## 8. 实施顺序与验收

### 阶段 A：数据基础

- 建立 User、Book、BookRevision、ShelfItem、Thread、Message 的最小表结构。
- 建立唯一约束 `(user_id, book_id)`。
- 完成认证、用户隔离和基础迁移。

验收：

- 同一用户并发打开同一本书，只产生一个 Thread。
- 不同用户打开同一本书，得到不同 Thread。
- 移除书架条目不会删除历史对话。

### 阶段 B：最小对话闭环

- 完成 Thread 获取/创建。
- 完成消息历史分页。
- 完成消息发送、SSE 流式返回、停止和失败状态。
- 完成 Message 幂等写入。

验收：

- 退出 App 再打开同一本书，进入同一 Thread。
- 连续发送多轮消息，顺序和内容一致。
- 网络重试不会产生重复用户消息。
- 服务异常后历史消息仍完整可查。

### 阶段 C：原文引用与上下文

- 接入 BookChunk 检索。
- 完成 Citation 持久化和原文定位。
- 每轮按需组织上下文，不发送整本书和全部历史。

验收：

- 回答引用能定位到具体书籍版本、章节和原文片段。
- 找不到可靠依据时明确说明，不伪造引用。
- 旧版本书籍的历史引用仍可追溯。

### 阶段 D：认知记忆与笔记

- 接入 Memory 的分类、来源追溯和状态演进。
- 接入 NoteRevision 与冲突处理。

验收：

- 用户观点、作者观点、AI 推断不会混淆。
- 每条记忆能回溯来源消息。
- 用户修改笔记后，AI 自动整理不能覆盖用户内容。
- 冲突时保留双方版本。

## 9. 尚待确认

- 认证方式：自建账号密码、短信/邮箱验证码，或接入第三方身份服务。
- SSE 是否满足移动端网络环境；必要时评估 WebSocket。
- 消息正文采用 Markdown 字符串还是 parts 结构；优先保证前端渲染简单、后端可演进。
- 书籍多版本切换策略及旧版本保留期限。
- 记忆自动沉淀的触发时机、模型成本和人工纠错入口。
- 管理员紧急排障授权和审计规则。

本文件仅冻结接口与数据边界的讨论基线。进入实现前，需要结合 ReadAny 实际代码运行结果和选定的客户端 API 适配方式再做一次评审。
