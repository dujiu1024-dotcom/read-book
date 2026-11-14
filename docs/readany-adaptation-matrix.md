# ReadAny → 知行阅读引擎与移动端适配参考清单

> **历史路线参考，已失效。** 第一阶段用户端已由 D-049 确定为 PC Web；本文的移动端 Fork 适配结论不再作为当前任务依据，仅保留阅读引擎与数据结构参考价值。
>
> 状态：源码级适配方案，尚未修改 ReadAny 业务代码。
> 上游仓库：`codedogQBY/ReadAny`
> 固定审查版本：`fce44689e1377df1ae99a35e8e71d5e8b3a639d1`（2026-10-07）
> 本文目的：把“保留、改造、替换、删除”的决策落实到具体模块，作为 Fork 后的开发任务依据。
> 证据边界：本文基于固定 Commit 的目录、配置和关键源码审查；尚未完成真机端到端验证。标注“待验证”的模块不得视为已通过运行测试。

## 1. 总体结论

**建议继续以 ReadAny 的 Expo 移动端为 Fork 起点，但只复用客户端框架、阅读器和部分交互组件；不继承它的本地优先业务架构。**

ReadAny 当前形态与知行的关键差异：

| 维度 | ReadAny 当前实现 | 知行目标 | 结论 |
|---|---|---|---|
| 数据权威 | SQLite 本地数据库 + 同步适配器 | 保留本地为用户数据主存储；服务器仅加密备份 | 需重新评估 |
| Thread | 一书可有多个 Thread，用户可新建/切换/删除 | 一个 user + 一本 book 唯一 Thread | 必须改造 |
| Message | 直接写本地 SQLite，按本地线程读取 | 本地正式持久化；服务器仅接收模型请求所需上下文和加密备份 | 需重新评估 |
| 模型调用 | App 配置模型供应商、客户端发起调用 | 云端统一调用模型，密钥不下发客户端 | 必须替换调用边界 |
| RAG | 本地切片、Embedding、SQLite/向量库检索 | 云端正式解析、向量化、检索；客户端不承担权威处理 | 核心能力迁移到云端 |
| 记忆 | Thread 内摘要压缩，写回 Thread | 用户认知记忆独立实体、来源可追溯、观点可演进 | 必须改造 |
| 阅读器 | EPUB 等阅读与 CFI 定位 | 保留阅读器，阅读行为不驱动对话流程 | 优先保留 |
| 书架/书城 | 本地书库和文件导入管理 | 云端书城/书架，用户不负责文件上传 | UI 和数据来源需改造 |
| 同步 | WebDAV/S3/LAN 等数据库文件/数据同步 | 明确 API 级同步，服务端为唯一权威 | 替换 |
| 笔记 | 本地笔记与同步 | 云端正式笔记 + 版本控制 + 本地缓存 | 改造 |

不建议直接在 ReadAny 原有代码上做大面积删改。应先建立知行 API Adapter 和本地缓存边界，再逐个迁移页面与 Store，保留可回滚路径。

## 2. 模块决策总表

| 模块/路径 | 决策 | 改造要点 | 优先级 |
|---|---|---|---|
| `packages/app-expo` | 保留 | Expo/RN 工程底座、导航和原生模块；移除不需要的桌面/本地管理功能 | P0 |
| `packages/app-expo/src/screens/BookChatScreen.tsx` | 大幅改造 | 去掉 Thread 列表、切换、新建、删除；打开书即加载唯一 Thread | P0 |
| `packages/app-expo/src/screens/ChatScreen.tsx` | 评估复用 | 检查是否为通用聊天入口；知行 V1 不需要独立的通用聊天入口 | P1 |
| `packages/app-expo/src/components/chat/*` | 选择性保留 | 保留输入框、消息列表、Markdown、引用展示；删除/隐藏复杂工具和多线程入口 | P0 |
| `packages/app-expo/src/stores/chat-store.ts` | 替换数据实现 | 保留 UI 状态接口思路；数据读写改为 API Repository | P0 |
| `packages/core/src/stores/chat-store.ts` | 不直接沿用 | 多 Thread 状态模型改为按 bookId 获取唯一 Thread；流式 UI 状态可复用 | P0 |
| `packages/core/src/db/thread-queries.ts` | 替换 | 不再本地创建正式 Thread；改成本地缓存表和云端 ID 映射 | P0 |
| `packages/core/src/db/message-queries.ts` | 替换 | 云端分页历史 + 本地缓存/待发送消息；幂等键和服务端状态 | P0 |
| `packages/core/src/types/chat.ts` | 拆分重构 | Thread/Message DTO 与 UI 类型分离；增加服务端 ID、同步状态和版本 | P0 |
| `packages/core/src/types/message.ts` | 有条件保留 | Part/流式事件结构有复用价值；与后端 Message DTO 建立显式映射 | P1 |
| `packages/core/src/ai/agents/reading-agent.ts` | 迁移/重写服务端 | ReAct/LangGraph 可参考；不得在移动端直接执行 Agent | P0 |
| `packages/core/src/ai/message-pipeline.ts` | 迁移/重写服务端 | 动态上下文组织迁移至后端，按知行记忆和云端 RAG 取数 | P0 |
| `packages/core/src/ai/chat-memory.ts` | 替换 | 从摘要覆盖式记忆改为可追溯 Memory 实体 | P1 |
| `packages/core/src/rag/search.ts` | 迁移服务端 | BM25 + 向量混合检索思路保留，正式索引与查询移至云端 | P0 |
| `packages/core/src/rag/chunker.ts` | 参考后重写/抽象 | CFI 分段思路可复用；需统一 EPUB/PDF/TXT 标准切片定位 | P1 |
| `packages/core/src/rag/embedding-provenance.ts` | 参考保留 | 模型、版本、维度、端点等向量溯源必须保留 | P1 |
| `packages/app-expo/src/lib/sync/sync-adapter-mobile.ts` | 仅保留基础文件能力 | SQLite VACUUM/文件操作可保留；不再用于数据库文件级云同步 | P1 |
| `packages/core/src/sync/*` | 删除/停用产品级同步入口 | WebDAV/S3/LAN 数据库同步不适合知行正式数据架构 | P1 |
| `packages/app-expo/src/lib/library/open-mobile-book.ts` | 改造 | 打开书籍先解析云端书目/版本与本地阅读资源；不再要求用户重新导入正式书籍 | P1 |
| `packages/app-expo/src/lib/rag/*` | 默认停用 | 手机不做正式切片、向量化与索引构建 | P1 |
| `packages/core/src/db/*` | 保留本地缓存子集 | 迁移为缓存/草稿/队列表；正式业务表由后端 PostgreSQL 管理 | P0 |
| `packages/app-expo/src/screens/settings/SyncSettingsScreen.tsx` | 删除/重做 | 去掉 WebDAV/S3/LAN 同步设置，改为账号、缓存和同步状态 | P2 |
| `packages/app-expo/src/screens/BookDetailsScreen.tsx` | 改造 | 云端书籍详情、加入书架、版本信息；不展示本地文件导入作为主流程 | P1 |
| `packages/app-expo/src/stores/library-store.ts` | 改造 | 书城/书架从 API 获取；本地只缓存元数据和下载状态 | P1 |
| `packages/app-expo/src/stores/reader-store.ts` | 优先保留 | 阅读器 UI 状态与 CFI 导航；禁止将阅读位置作为 Agent 自动续读指令 | P1 |
| `packages/app-expo/src/stores/reading-session-store.ts` | 删除或降为纯 UI 状态 | 不形成阅读任务、进度目标或对话触发条件 | P2 |
| `packages/app-expo/src/stores/notebook-store.ts` / Note 相关 | 改造 | 本地正式笔记与版本记录；服务器只保存加密备份 | 需重新评估 |

## 3. 移动端工程与页面

### 3.1 工程底座

路径：`packages/app-expo/package.json`

保留：
- Expo SDK、React Native、React Navigation。
- expo-sqlite（用于缓存、草稿和待同步队列）。
- expo-secure-store（保存登录凭据/刷新令牌，不保存平台模型密钥）。
- expo-file-system、expo-document-picker（若阅读器需要本地临时书籍文件）。
- WebView、Reader 相关原生模块、字体、Markdown 渲染组件。

评估移除：
- 本地 ONNX Embedding 依赖 `onnxruntime-react-native`。
- 本地向量化专属依赖和模型下载资源。
- 不需要的 TTS、统计、目标管理、复杂分组等产品模块。
- 多供应商模型 SDK；客户端不再直接调用模型供应商。

注意：不能只凭依赖名就立即删包。先用模块引用扫描确认依赖边界，避免 Reader/原生构建受影响。第一轮只建立移除候选清单。

### 3.2 对话页面

路径：`packages/app-expo/src/screens/BookChatScreen.tsx`

源码已确认的现状：
- 页面加载某本书的所有 Thread。
- 通过 activeThreadId 选择当前 Thread。
- 侧边栏按时间分组展示多个历史 Thread。
- 支持新建、切换、删除 Thread。
- 发送消息前解析本地 AI 配置，然后调用流式聊天 Hook。
- Citation 点击时通过 CFI 导航回阅读器。

知行改造：
1. 页面初始化调用 `POST /api/v1/books/{book_id}/thread` 获取或创建唯一 Thread。
2. 返回的 thread_id 是云端正式 ID。
3. 加载该 Thread 的分页消息历史。
4. 页面不展示 Thread 历史列表、切换、新建和删除入口。
5. 移除“空对话时创建新 Thread”的行为。
6. 发送消息调用云端接口，客户端只负责展示流式事件。
7. Citation 仍然通过阅读器定位能力打开原文，但定位信息改为后端返回的统一 Citation DTO。
8. 从书籍页面进入时，不自动携带“上次阅读位置”或触发续读；用户选中文本主动发起讨论时，可作为当前消息的引用上下文。

### 3.3 对话组件

路径：`packages/app-expo/src/components/chat/*`

优先保留：
- `ChatInput.tsx`：文本输入、发送、停止；删去模型选择、深度思考等非 V1 必需选项。
- `MessageList.tsx`：消息列表、滚动、流式状态。
- `MarkdownRenderer.tsx`：基础 Markdown。
- `PartRenderer.tsx`：在确认 Part 类型与服务端协议兼容后复用。
- `StreamingIndicator.tsx`：流式状态提示。
- 引用展示组件：保留交互，改为 Citation DTO。

评估删除或隐藏：
- `ModelSelector.tsx`：模型由平台统一配置，不由普通用户在聊天页选择。
- `ThreadList.tsx`：一书一 Thread 后不需要。
- `ContextPopover.tsx`：如果它暴露当前章节/阅读位置上下文，需确认知行是否仍有用户主动选择的入口；默认不向 Agent 自动注入阅读进度。
- `MindmapPartView.tsx`：非 V1 核心能力，先不接入。

## 4. Thread 与 Message 数据层

### 4.1 类型定义

路径：`packages/core/src/types/chat.ts`

当前 Thread 含有：
- id、bookId、title、messages
- memorySummary、memoryUpdatedAt、memoryMessageCount
- createdAt、updatedAt

当前 Thread 没有 userId，且本地 Store 可为同一本书创建多个 Thread。该模型不能直接作为云端正式模型。

知行处理：
- 新建独立 API DTO：Book、BookRevision、Thread、Message、Citation、Memory、Note。
- Thread DTO 至少包含 id、book_id、created_at、updated_at、last_message_at、version。
- Message DTO 至少包含 id、thread_id、client_message_id、role、content/parts、status、created_at、completed_at。
- 客户端缓存模型可额外包含 sync_state、local_id、server_version。
- 不把完整 messages 数组嵌入 Thread API 响应；消息分页独立查询。
- memorySummary 从 Thread 正式字段迁出，变成 Memory 查询和上下文组装结果。

路径：`packages/core/src/types/message.ts`

可复用：
- Part 结构用于文本、引用、工具状态等 UI 表达。
- StreamEvent 的 part:created / part:delta / part:completed 思路。

必须处理：
- 后端持久化消息与 UI Part 不要强耦合。
- V1 不向用户暴露 reasoning 内容、工具调用过程或隐藏推理。
- Citation 必须增加 revision_id、chunk_id、locator_type 和稳定定位信息，不能只依赖 ReadAny 的 bookId + CFI。
- 对于 PDF/TXT，不能假设 CFI 一定存在。
- 服务端流式协议以稳定的 message_id 和事件 ID 为核心，断线后可查询最终消息。

### 4.2 SQLite 查询与 Store

路径：
- `packages/core/src/db/thread-queries.ts`
- `packages/core/src/db/message-queries.ts`
- `packages/core/src/stores/chat-store.ts`
- `packages/app-expo/src/stores/chat-store.ts`

源码已确认：Thread 和 Message 直接从 SQLite 查询/插入；createThread 会生成本地 ID 并插入本地表；Store 维护 bookActiveThreadIds，支持多个 Thread 的切换和删除。

替换为 Repository 分层：

- `ThreadRemoteRepository`：调用云端获取或创建唯一 Thread。
- `MessageRemoteRepository`：分页历史、发送、停止、重新生成。
- `ThreadCacheRepository`：SQLite 缓存 Thread 元数据。
- `MessageCacheRepository`：SQLite 缓存历史消息、未发送草稿和待同步队列。
- `ChatFacade`：页面唯一入口，屏蔽远端和本地缓存细节。

关键规则：
- 不再在客户端创建正式 Thread ID。
- 本地临时消息必须有 client_message_id / idempotency_key。
- 服务端确认后将 local_id 映射到 server_id。
- Message 正式历史采用追加写，不允许客户端覆盖云端正文。
- 离线发送进入 pending 队列；联网后幂等补传。
- 删除书架条目不能删除云端 Thread 和 Message。
- 同一用户两台设备同时打开同一本书，服务端唯一约束保证只返回同一个 Thread。

## 5. Agent、模型调用与上下文

### 5.1 Agent 执行位置

路径：`packages/core/src/ai/agents/reading-agent.ts`

当前实现使用 LangGraph ReAct Agent、模型供应商客户端和工具集，包含阅读器当前章节、选区、阅读位置、RAG、书库管理等工具。

知行策略：
- Agent 运行全部迁移到 FastAPI 后端。
- LangGraph/ReAct 可以作为实现参考，但不是必须照搬。
- 客户端只发送用户输入和用户主动附加的选区引用，不提交模型密钥或任意工具调用指令。
- 后端根据当前书籍和对话意图选择工具。
- 删除或禁用以阅读进度、当前位置、当前章节为默认上下文的工具。
- 保留原文检索、引用、解释、比较、论证分析等与书籍讨论直接相关能力。
- 工具权限由服务端控制，客户端不能自行调用管理工具。

### 5.2 上下文组装

路径：`packages/core/src/ai/message-pipeline.ts`

当前实现采用固定滑动窗口，并把 Citation 文本拼接回历史消息。

知行后端每轮上下文由以下部分动态组成：
1. Agent 系统规范。
2. 最近若干轮原始消息。
3. 当前问题召回的书籍原文切片。
4. 相关历史讨论（按需检索）。
5. 与当前问题相关的用户认知记忆。
6. 必要的作者观点/来源说明。

不要把完整书籍、全部历史消息或所有记忆一次性发给模型。窗口大小、检索 TopK、上下文长度需要通过中文书籍测试集确定。

### 5.3 记忆

路径：`packages/core/src/ai/chat-memory.ts`

当前实现将旧消息压缩为 Thread.memorySummary，并更新 memoryMessageCount；它是摘要压缩机制，不等于知行需要的认知记忆系统。

知行改造：
- 原始 Message 永久保留。
- Memory 独立表，至少区分 user_understanding、user_opinion、author_view、hypothesis、open_question、practice。
- 每条 Memory 记录 source_message_ids；作者观点尽可能关联 source_chunk_ids / Citation。
- 记忆状态支持 active、disputed、superseded、archived。
- 用户观点变化时保留演进，不把新摘要覆盖旧观点。
- 记忆抽取失败不影响对话持久化。
- V1 不做跨书知识图谱可视化。

## 6. RAG 与原文引用

### 6.1 检索

路径：`packages/core/src/rag/search.ts`

可复用的设计：
- BM25/倒排索引 + 向量检索的混合检索思路。
- 检索结果返回 Chunk 和分数。
- 对 Embedding 来源做兼容性校验。
- 检索失败时可降级关键词搜索，但需明确记录降级状态。

不能直接复用的部分：
- 当前检索依赖本地 getChunks(bookId)、本地缓存和本地向量数据库。
- 知行正式检索必须在云端按 book_id + revision_id + 权限范围查询。
- 不能让客户端上传 query embedding 后绕过服务端模型兼容性和访问控制。
- 查询向量由服务端同一 Embedding 配置生成。

### 6.2 切片与定位

路径：`packages/core/src/rag/chunker.ts`

当前 chunker 以 TextSegment 为输入，保留 startCfi/endCfi 和 segmentCfis，默认按 token 数量切片。这对 EPUB 阅读器定位有价值。

知行要做：
- 抽象统一 Locator，不把 CFI 当成唯一定位格式。
- EPUB：保留 CFI，并记录章节/段落锚点。
- PDF：记录物理页码、页内范围，必要时关联印刷页码。
- TXT：记录段落序号或字符偏移。
- Chunk 关联 book_revision_id、chapter_id、content_hash、parser_version、chunker_version。
- 云端保存原始文件和正式 Chunk；客户端不负责生成正式索引。
- 先使用关键词 + 向量混合检索，不为 V1 引入额外向量数据库。

### 6.3 Embedding 溯源

路径：`packages/core/src/rag/embedding-provenance.ts`

保留“模型身份必须可比较”的原则，并扩展为：
- provider、model_id、model_version
- dimensions
- normalization
- distance_metric
- preprocessing_version
- created_at

书籍向量和查询向量只有在模型、维度和预处理兼容时才能比较。升级模型时新建索引版本，不能混用。

## 7. 本地同步与缓存

### 7.1 当前移动端适配器

路径：`packages/app-expo/src/lib/sync/sync-adapter-mobile.ts`

源码显示它封装 SQLite VACUUM、完整性检查、数据库关闭/重开、文件哈希与文件读写。这些是移动端平台文件能力，不等于云端 API 同步。

处理：
- 保留文件读写、哈希和 SQLite 维护等通用平台能力。
- 不再将 readany.db 整库上传到 WebDAV/S3 作为正式同步方式。
- 新建 API 同步客户端，按实体/接口同步书架、Thread、Message、Note。
- 本地数据库只保留缓存、离线草稿、pending 操作和同步游标。

### 7.2 同步冲突

- Thread：服务端唯一，不做多主合并。
- Message：追加写 + 幂等键，不允许静默覆盖。
- Note：revision + base_revision_id 乐观锁，冲突保留双方版本。
- Book：云端版本为准，本地只缓存元数据和阅读资源。
- 登录切换：本地私人缓存必须按用户隔离，退出账号清理或加密隔离。

## 8. 书城、书架和阅读器

### 8.1 书籍打开

路径：`packages/app-expo/src/lib/library/open-mobile-book.ts`

当前函数检查本地文件、远端同步状态和重新导入提示。知行应拆成：
- `BookCatalogRepository`：获取云端书籍详情和可用版本。
- `BookAssetRepository`：按产品策略获取阅读所需文件或受控缓存。
- `ReaderNavigationService`：打开阅读器并处理 EPUB/PDF/TXT 定位。

用户不承担书籍入库、版本管理和上传；手机端是否缓存完整原文由版权策略、存储成本和阅读器实现共同决定。

### 8.2 阅读器

优先保留：
- Reader 页面和 EPUB 渲染能力。
- CFI 解析、选区和定位。
- 字体、主题、目录和基础阅读交互。

改造边界：
- 阅读位置只用于用户阅读体验，不用于自动生成 Thread 或驱动 Agent 续读。
- 用户主动选中文字并点击讨论时，可将选区作为该条消息的引用上下文。
- 书籍内容版本必须和 Citation 的 revision_id 对应，避免更新文件后定位错位。
- PDF/TXT 定位能力需另行验证，不能由 EPUB CFI 成功推断其他格式也成功。

## 9. 建议的目标代码结构

在 Fork 内逐步形成以下边界（名称可按现有目录风格调整）：

```text
packages/app-expo/src/
├── api/
│   ├── client.ts
│   ├── auth.ts
│   ├── books.ts
│   ├── threads.ts
│   ├── messages.ts
│   └── notes.ts
├── repositories/
│   ├── remote/
│   └── local/
├── features/
│   ├── catalog/
│   ├── shelf/
│   ├── chat/
│   └── reader/
└── stores/
    ├── auth-store.ts
    ├── catalog-store.ts
    ├── chat-ui-store.ts
    └── sync-store.ts
```

核心原则：页面不直接调用 SQLite 或 HTTP；页面通过 Facade/Repository 获取数据。远端失败时由 Repository 决定展示缓存、离线草稿或错误，不把网络状态逻辑散落在组件中。

## 10. 分阶段开发任务

### M0：基线冻结（不改业务代码）

- [ ] ReadAny 固定 Commit、依赖、目录和许可证记录。
- [ ] CI 通过 Reader 构建、Expo 配置、Android Debug APK。
- [ ] 真机安装、启动、阅读器打开和基础对话冒烟。
- [ ] 记录上游可运行能力与环境限制。

### M1：移动端云端 API 骨架

- [ ] 建立认证和 API Client。
- [ ] 建立远端/本地 Repository 接口。
- [ ] 建立 Book、Thread、Message DTO。
- [ ] 本地数据集、书籍版本和备份 manifest 的 ID 映射与恢复协议。
- [ ] 先不改 Agent/RAG 内部逻辑。

验收：登录后可从云端获取书籍和书架；无网络时能读取已缓存元数据。

### M2：一书一 Thread + 消息云端化

- [ ] 改造 BookChatScreen。
- [ ] 移除多 Thread UI 和客户端 createThread。
- [ ] 接入获取或创建唯一 Thread API。
- [ ] 接入历史消息分页、SSE、停止、重试。
- [ ] Message 幂等补传和断线恢复。

验收：同一本书反复打开始终进入同一 Thread；不同设备恢复相同消息历史。

### M3：云端 Agent 与 RAG

- [ ] Agent 执行迁移至 FastAPI。
- [ ] 移动端不再保存模型供应商密钥。
- [ ] 云端检索和 Citation API。
- [ ] Citation 统一定位模型。
- [ ] 中文 EPUB 真实书籍问答与引用评测。

验收：回答依据可追溯；无依据时不编造；客户端只负责消息呈现和原文定位。

### M4：认知记忆、笔记和书籍版本

- [ ] Memory 独立实体和来源追溯。
- [ ] Note revision 与冲突解决。
- [ ] 书籍版本与历史 Citation 绑定。
- [ ] 书架、书城和管理员入库流程打通。

验收：用户观点不被 AI 覆盖；书籍更新不破坏历史引用；管理员默认不能查看私人聊天。

## 11. 风险与待验证事项

| 风险 | 当前证据 | 处理方式 |
|---|---|---|
| ReadAny 多 Thread 结构深入 UI/DB | BookChatScreen、chat-store、thread-queries 已确认 | M2 统一重构，不仅隐藏侧边栏 |
| 本地数据库同步与云端 API 模式差异 | MobileSyncAdapter + core sync 模块 | 替换同步协议，保留文件平台能力 |
| Agent 强依赖阅读上下文工具 | reading-agent 工具路由 | 后端迁移时按知行产品原则筛选工具 |
| 本地 RAG 与云端 RAG 边界 | search/chunker 直接依赖本地 DB | 检索、向量化正式迁云端 |
| CFI 对 PDF/TXT 不通用 | Citation 类型当前包含 cfi | 统一 Locator 并分别验证格式 |
| 上游依赖体积/原生模块维护 | Expo package 含多种原生依赖 | 真机构建后做依赖瘦身，不先盲删 |
| GPL-3.0-or-later 许可证义务 | 上游根 package.json 声明 | Fork 分发/提供服务前单独做许可合规评估 |

## 12. 结论与下一步

当前建议不是立刻重写 ReadAny，也不是立即开始全部云端业务开发。

ReadAny 固定版本的 GitHub CI 已通过，但这只证明上游 Expo 工程构建能力。Android/iOS 真机验证当前暂停；ReadAny Expo App 不再作为小程序客户端的直接 Fork 起点。后续先验证宿主无关阅读引擎的可移植性，并完成平台无关数据/API 契约；只有在客户端路线和契约评审通过后，才讨论知行业务开发。

**不可妥协的产品约束：同一书籍版本只有一条长期 Thread；Agent 不管理阅读过程；用户个人数据本地优先、服务器只保存加密备份。**


## 13. 微信小程序入口下的阅读器可移植性复核（2026-11-13）

审查固定上游 commit：fce44689e1377df1ae99a35e8e71d5e8b3a639d1。此次只做源码审查，不代表已在小程序运行环境验证。

### 13.1 已确认的实现依赖

| 文件/模块 | 源码证据 | 对小程序迁移的影响 |
|---|---|---|
| ReaderScreen.tsx | 使用 react-native-webview、Expo Asset、DocumentPicker、React Native AppState、Platform 等 | 页面本身属于 React Native 页面，不能直接放进原生小程序 |
| reader.template.html | 通过 window.ReactNativeWebView.postMessage 与宿主通信 | 必须替换消息桥接；不能假设小程序 web-view 可提供同名对象 |
| local-file-server.ts | 使用原生 Lighttpd 或 react-native-tcp-socket 在本机启动 HTTP 文件服务器，支持 Range | 依赖原生本地端口和文件系统；小程序没有相同的本机服务器执行环境 |
| ExtractorWebView.tsx | 隐藏 WebView 承载书籍提取，并通过 WebView bridge 传输数据 | 需要重新设计文件读取、解析和消息回传方式 |
| packages/app-expo/package.json | 包含 react-native-webview、Expo FileSystem、原生静态服务器、TCP Socket 等依赖 | 整个 Expo 包不能直接视为小程序可复用工程 |

### 13.2 复用边界修订

**可继续研究复用：**
- Foliate / foliate-js 的阅读排版与分页引擎。
- 阅读器 HTML/CSS/JavaScript 中与宿主无关的逻辑。
- EPUB 章节结构、CFI 和文本锚点等定位算法。
- Citation、Chunk、TextSegment 等数据结构与定位思想。

**不能直接复用：**
- ReaderScreen React Native 页面。
- react-native-webview 宿主和 window.ReactNativeWebView bridge。
- 本机 Lighttpd/TCP 文件服务器。
- Expo FileSystem / DocumentPicker / Asset 等平台适配。
- 依赖原生模块的本地书籍加载、文件服务和隐藏 WebView 提取流程。

### 13.3 小程序阅读器候选路径

A. 小程序原生页面 + 共享阅读引擎：
- 将不依赖 DOM 宿主的章节、文本、定位和排版逻辑抽离。
- 用小程序原生组件承载阅读页面。
- 风险：EPUB 排版、复杂 CSS、脚注、图片、分页和选区需要较多适配。

B. 小程序 web-view + 受控 H5 阅读器：
- 将 Foliate 相关 HTML/JS 作为独立 H5 阅读器部署在已配置业务域名上。
- 小程序 web-view 打开该 H5 页面，通过受控 URL 参数或消息机制传递 book/revision/locator。
- 风险：H5 与小程序宿主的消息桥接、文件分段加载、域名白名单、登录态传递、返回导航和平台审核限制。

C. 更换轻量阅读组件：
- 以知行需要的格式和定位能力为基准，单独评估适配小程序的 EPUB/PDF 阅读组件。
- 风险：可能失去 Foliate 的部分格式兼容和排版能力，需要重新建立格式样本测试集。

当前不选择 A/B/C。先用最小技术验证比较 EPUB 加载、目录、选区、Citation 回跳、长文性能和文件访问，再决定。

### 13.4 复用评估结论修订

ReadAny 仍可作为阅读引擎、数据结构和交互设计的参考项目；但不再将其 Expo App 视为知行小程序客户端的直接 Fork 起点。客户端工程底座应在小程序/H5 方案验证后重新选择。

这项修订不影响其上游 CI 构建结果，也不表示 Foliate 阅读引擎本身不可复用。
