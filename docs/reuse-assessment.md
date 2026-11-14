# 开源项目深度复用评估：ReadAny + TextSage

> **历史路线记录，已失效。** 移动端/小程序复用路线已被 D-049（第一阶段 PC Web）替代；本文的源码评估仅作参考，不构成当前实施依据。
>
> 审查日期：2026-11-13  
> 阶段：源码抽查后的架构评估；尚未克隆运行、构建或做真实书籍质量测试。以下结论是复用路线建议，不是代码已可直接合并的承诺。

## 1. 结论摘要

### 推荐路线

- **ReadAny：作为手机端工程和阅读对话能力的 Fork 起点，优先验证。**
- **TextSage：不整体 Fork 成知行后端；提取其 PDF 处理流水线的阶段设计和局部算法，纳入知行统一的书籍处理引擎。**
- **知行自己的核心必须掌握：用户/书籍/长期对话的数据模型、云端权限隔离、对话记忆、版权来源、书籍包协议。**

原因：
- ReadAny 已有 Expo/React Native 客户端、书籍聊天、引用定位、切片和混合检索，节省移动端与阅读交互开发。
- ReadAny 的数据层是平台抽象下的 SQLite 本地数据库，向量索引也按平台适配；没有现成的知行式云端多用户 SaaS 后端。
- TextSage 的处理阶段拆分、PDF 页码对齐、可恢复处理值得借鉴；但产品目标是学校教材 PDF，流程依赖课程/学科/教材目录结构，不适合作为通用图书服务整体引入。

## 2. ReadAny 源码检查

仓库：https://github.com/codedogQBY/ReadAny

### 已检查文件
- `package.json`
- `pnpm-workspace.yaml`
- `packages/app-expo/package.json`
- `packages/core/src/types/chat.ts`
- `packages/core/src/stores/chat-store.ts`
- `packages/core/src/ai/chat-memory.ts`
- `packages/core/src/ai/agents/reading-agent.ts`
- `packages/core/src/db/db-core.ts`
- `packages/core/src/db/thread-queries.ts`
- `packages/core/src/db/message-queries.ts`
- `packages/core/src/db/chunk-queries.ts`
- `packages/core/src/rag/chunker.ts`
- `packages/core/src/rag/search.ts`
- `packages/core/src/rag/vector-db.ts`
- `packages/core/src/rag/remote-embedding.ts`
- `packages/core/src/rag/tokenizer.ts`
- `packages/core/src/rag/vectorize-trigger.ts`

### 2.1 可复用部分

**移动端工程**
- Monorepo 使用 pnpm workspace，包含独立的 Expo 应用包和共享 core 包。
- Expo 使用 React Native 0.81、Expo SDK 54、React Navigation 7、Zustand。
- 有可复用的移动端工程配置、平台服务抽象、流式消息状态和书籍对话 UI 基础。
- 可作为手机端原型与工程结构的起点，但需要先评估并删减音频、阅读统计、书籍管理等不符合知行边界的功能。

**书籍对话模型**
- Thread 通过 bookId 关联书籍。
- Message 独立保存，支持 citations、toolCalls、reasoning、partsOrder 等结构。
- Chat Store 将每本书的 active thread 单独索引。
- 流式状态、消息追加、历史加载等逻辑可参考。

**原文定位**
- Citation 保存 bookId、章节标题/索引、CFI、引用文本和可选位置。
- EPUB TextSegment 保存段落文本与 CFI。
- Chunk 保存 startCfi、endCfi、segmentCfis，便于从检索结果定位回 EPUB 原文。
- 这是很有价值的设计；知行可沿用“片段必须携带可追溯定位”的原则，但不能把 EPUB CFI 当作 PDF/TXT 通用定位格式。

**切片和检索**
- Chunker 按 TextSegment 聚合，默认目标约 300 tokens、最小 50 tokens、重叠比例 0.2。
- Search 支持 vector、BM25、hybrid 三种模式。
- Tokenizer 有中文字符/二元组，以及日文、韩文和英文处理。
- 向量索引保存 embedding provenance，检索前校验模型身份、端点和维度，避免用错误模型查询旧索引。
- Vector DB 通过 IVectorDB 接口抽象，支持按 bookId 检索和删除；具体实现由平台注入。

### 2.2 不能直接沿用的部分

**本地 SQLite，不是云端 SaaS 数据层**
- db-core 通过 PlatformService 加载 SQLite 数据库。
- Thread、Message 查询直接读写本地数据库。
- Chunk 和 vector_index_provenance 放在 local DB。
- 这适合个人设备和离线场景，不解决云端多用户、共享书城、账号权限、跨设备一致性和管理员隔离。

**会话约束不符合知行**
- Chat Store 的 createThread 每次都能创建新线程。
- bookActiveThreadIds 只是当前活动线程映射，不是数据库层“每个用户每本书唯一线程”的约束。
- 知行必须保证同一 LocalDataSet + BookRevision 只有一个长期 Thread；该唯一约束首先在本地数据层实现。

**记忆压缩不够严谨**
- chat-memory.ts 把较早消息压缩为一个 memorySummary，并更新 memoryMessageCount。
- 虽然原消息仍保存在 SQLite，但摘要提示词把用户偏好、决策、书籍事实、未完成任务放在同一个摘要中。
- 知行应将记忆拆成用户理解、用户观点、作者观点、待验证假设、未解决问题等类型，并记录来源消息 ID；原始消息不可被摘要覆盖。

**产品功能边界不一致**
- ReadAny 的 ReadingContext 包含 currentPosition、percentage、page、operationType 等阅读位置数据。
- Agent 工具包含 getReadingProgress、当前章节、选区、阅读统计等工具。
- 知行只保留对当前讨论有用的上下文定位，不向用户展示进度管理，也不让 Agent 主动询问阅读位置。

**依赖和工程复杂度**
- Expo 包含大量原生依赖，如文件系统、SQLite、WebView、音频、媒体库、ONNX Runtime 等。
- 使用 Expo Dev Client、Prebuild 和 EAS Build 脚本，不是简单的 Expo Go 项目。
- 应先做依赖瘦身和 Android/iOS 构建验证，避免继承不需要的原生模块。

### 2.3 ReadAny 复用建议

采用 Fork 起点，但分阶段验证：
1. 先跑通现有 Expo app，记录 Android/iOS 构建条件和关键页面。
2. 保留书籍对话 UI、流式消息、引用呈现、平台抽象和 EPUB 定位能力。
3. 删除或隐藏阅读统计、进度驱动、复杂书库管理、音频等非核心能力。
4. 保留本地数据库作为用户个人数据主存储；云端 API 负责公共书籍、模型调用与加密备份，不承接私人数据在线主存储。
5. 以云端 API 返回的 bookId/threadId 为准，实现每用户每书唯一长期对话。
6. 将对话记忆重构为可溯源、分类型、可演进的认知记录。

## 3. TextSage 源码检查

仓库：https://github.com/sunnyvucs/TextSage

### 已检查文件
- `README.md`
- `src/config.py`
- `src/pipeline.py`
- `src/manifest_manager.py`
- `src/resume_check.py`
- `src/text_extractor.py`
- `src/toc_extractor.py`
- `src/chapter_aligner.py`
- `src/chunker.py`
- `src/embedder.py`
- `src/pg_writer.py`
- `src/chunk_embedder.py`
- `api_server.py`

### 3.1 值得借鉴的实现

**阶段化、可恢复流水线**
- PDF 拆页、抽取、目录识别、章节对齐、切片、数据库写入、向量化分阶段执行。
- manifest 记录原始文件、页文件、文本文件、解析器和教材元数据。
- ResumeChoice 支持继续、重做和仅重跑切片等模式。
- chunk_embedder 按 qdrant_point_id 是否为空跳过已向量化数据，具备一定增量处理思想。

**章节页码对齐**
- 使用向量召回与 BM25 形成候选页。
- 加入章节结构特征重新评分。
- 仅在候选分数差距较小时调用 LLM 进行判断。
- 对教材目录印刷页码与 PDF 物理页码的偏移进行映射。
- 该思路对“目录页码与实际文件页码不一致”的 PDF 很有参考价值。

**图文关联**
- MinerU content_list 提取图片块、页码和 caption。
- 图片与文本片段通过页码/图号建立关联。
- 适合未来知行支持复杂 PDF 图表和插图检索时参考。

### 3.2 不宜整体照搬的部分

- 当前只处理 PDF，核心概念是逐页 PDF、教材目录、学科、年级、章节和 topic。
- 目录识别提示词明确假设学校教材结构，不适合小说、社科、哲学等普通图书。
- config.py 有个人 Windows 绝对路径 `D:\AI\AI Projects\PDFParserAI`，必须改为环境配置。
- 默认 Embedding 是 `BAAI/bge-base-en-v1.5`，README 流程是英文教材；不能直接用于中文书籍的生产检索，必须选择适合中文/多语言的模型并做真实评测。
- 章节对齐阶段先对全书每页做向量索引，计算与存储成本较高；知行应根据文件类型、页数和目录质量决定是否启用。
- 其 API 使用 Qdrant、PostgreSQL、Redis、Ollama；知行不应无理由继承这套依赖组合。
- API 示例的 history 由客户端传入，且有宽松 CORS 配置；不能作为知行多用户服务的安全实现。
- 当前抽查到的 API 端点偏教材 Tutor，不具备知行的用户身份、书籍授权、长期对话和私人数据隔离。

### 3.3 TextSage 复用建议

不把 TextSage 当作后端底座，不整体 Fork。按模块借鉴：
1. manifest / 处理状态 / 阶段重试的设计。
2. PDF 页级解析与页码映射。
3. 目录识别与章节页码对齐算法，按需启用。
4. MinerU content_list 的图文关联思路。
5. 分阶段产物和质量报告。

普通 EPUB/TXT 需要独立解析器，不应强行套用 PDF 的页级流水线。

## 4. 组合架构建议

建议不是让两个项目彼此直接连接，而是把它们分别放在客户端和内容处理侧：

```text
ReadAny Fork（手机端）
  ├── 书城 / 书架 / 我的（按知行重做）
  ├── 一书一长期对话
  ├── 流式聊天 / 引用呈现
  └── API Client
          │
          ▼
知行云端 FastAPI（自建）
  ├── 账号与用户隔离
  ├── 书城与书架
  ├── 一书一长期对话
  ├── 对话上下文与认知记忆
  ├── 原文检索与引用
  └── 书籍处理任务调度
          │
          ├── PostgreSQL + pgvector
          ├── Redis + Worker
          └── 对象存储
          
统一书籍处理引擎（Python，可在本地或云端运行）
  ├── EPUB 解析器
  ├── PDF 解析器（PyMuPDF / MinerU / OCR）
  ├── TXT 解析器
  ├── 文本清洗与章节结构
  ├── 质量检查
  ├── 切片与定位
  ├── Embedding
  └── 标准书籍包导入/导出
```

关键建议：本地初加工和云端完整处理尽量调用同一套版本化 Python 处理引擎。运行位置不同、处理模式不同，但解析规则、数据结构和质量检查协议一致，避免维护两套互相漂移的实现。

## 5. 现阶段技术路线调整

| 层 | 当前建议 | 依据 |
|---|---|---|
| 手机端 | ReadAny Expo 包 Fork 验证 | 已有移动端与书籍对话能力 |
| 云端 API | 自建 FastAPI | ReadAny 没有知行所需的云端多用户服务 |
| 管理端 | React + Vite + Ant Design 暂保留 | 两个候选项目都不能直接覆盖知行管理流程 |
| 主数据 | PostgreSQL | 用户、书籍、对话、记忆需要云端权威数据 |
| 向量 | 先评估 pgvector | 不继承 ReadAny 本地向量适配器或 TextSage 的 Qdrant 部署 |
| 任务 | Redis + Worker | 云端解析、OCR、向量化异步执行 |
| 处理引擎 | Python 统一模块，本地/云端复用 | 借鉴 TextSage 分阶段处理 |
| 文件 | S3 兼容对象存储 | 原始书籍与处理产物分离保存 |

## 6. 复用实施顺序（仅为建议，未开始开发）

### P0：运行可行性验证
- 克隆 ReadAny，按仓库说明安装依赖。
- 在 Android 设备/模拟器启动 Expo app。
- 完成至少一次 Android 构建；确认 iOS 构建所需环境。
- 验证打开一本 EPUB、发起书籍对话、流式输出、原文引用定位。
- 克隆 TextSage，检查依赖安装和 PDF 处理是否可运行；确认 MinerU、Groq、PostgreSQL、Qdrant、Redis 等实际依赖。

### P1：形成知行适配清单
- ReadAny：页面保留/删除清单、SQLite 到 API 的替换点、唯一长期对话改造点。
- TextSage：可独立复用模块、需要重写模块、普通图书格式缺口。
- 统一书籍包协议和云端数据模型。

### P2：再决定是否开始开发
只有 P0 验证结果与改造成本明确后，才确认 Fork 改造还是借鉴重写。开始开发前仍需用户明确确认。

## 7. 风险与待验证项

- 本次是远程源码抽查，没有本地安装、构建、端到端运行或真实书籍检索评测。
- ReadAny 代码持续变化，后续 Fork 应固定 commit/tag，避免上游变动导致分析失效。
- TextSage 的完整依赖清单和可复现部署仍需核实。
- 中文/英文/多语言 Embedding 需要使用同一套书籍样本评测，不根据模型名称直接拍板。
- PDF 解析必须验证页码、双栏、脚注、表格、图片、扫描件；EPUB 必须验证章节和 CFI；TXT 必须验证章节推断与段落边界。
- 许可证和第三方依赖义务继续记录；当前共享使用定位不把许可证当作技术选型的硬性排除项。


## 8. 用户端平台调整后的复用结论修订（2026-11-13）

本节修订前文“ReadAny 作为手机端 Fork 起点”的建议，依据用户提出的微信小程序/服务号候选入口，以及对固定 ReadAny commit 的 ReaderScreen、reader.template.html、local-file-server.ts、ExtractorWebView.tsx 和 app-expo/package.json 的进一步审查。

### 修订结论

- ReadAny Expo App 不再作为知行最终用户端的默认 Fork 起点。
- ReadAny 继续作为阅读引擎、Foliate/foliate-js、EPUB 定位、Citation/Chunk 数据结构和部分通用 HTML/JavaScript 的参考。
- React Native 页面、WebView bridge、本机 HTTP 文件服务器、Expo 文件访问和原生模块不能直接迁移到微信小程序。
- 书籍对话 UI 的交互模式可以借鉴，但需由所选客户端平台重新实现。
- 云端 FastAPI、PostgreSQL、对象存储、Agent/RAG 和书籍处理引擎仍可按平台无关方向继续评估，不受客户端路线变化影响。

### 需要重新验证的阅读器路线

1. 小程序原生页面 + 共享阅读引擎。
2. 小程序 web-view + 受控 H5 阅读器。
3. 独立小程序 EPUB/PDF 阅读组件。

在真实小程序环境验证 EPUB 加载、章节导航、选区、Citation 回跳、长书性能和文件访问前，不选定其中任何方案。

本节优先级高于本文第 1、2、4、5、6 节中将 Expo App 描述为直接客户端底座的建议。ReadAny 上游 CI 构建成功仅证明其 Expo 工程可构建，不证明其客户端能迁移至小程序。
