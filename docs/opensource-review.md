# 开源项目拆解与复用评估

> 初步调研记录。知行当前定位为用户本人及身边朋友共同使用的共享阅读服务，并未预设闭源商业化。许可证不是排除开源项目的硬门槛，但仍需记录并理解其义务；复用前继续检查源码、依赖许可证、提交历史、部署脚本和实际运行情况。

## 初步结论

没有一个候选项目同时覆盖知行的核心形态：移动端书籍长期对话、多用户 SaaS 书城、严格的私人数据隔离、长期认知记忆，以及本地预处理 + 云端完整处理。

优先采用“拆模块借鉴”，不直接整体 Fork 作为产品底座。

## 1. ReadAny

仓库：https://github.com/codedogQBY/ReadAny

公开技术信息（需以当前源码复核）：
- Tauri 2、React 19、TypeScript、Vite。
- 移动端使用 Expo / React Native 与 Tauri Mobile。
- SQLite、foliate-js、LangChain.js / LangGraph、Transformers.js。
- 本地优先电子书阅读器，支持书籍对话、混合检索、笔记和本地向量存储。

适合拆解：
- 移动端 Expo 项目结构与导航。
- EPUB/PDF 阅读和内容抽取。
- 书籍对话界面、原文定位和引用跳转。
- 本地向量化、混合检索的实现方式。

不宜直接照搬：
- 产品重心是本地阅读器与个人书库，不是多租户 SaaS。
- SQLite 本地数据模型不能直接替代云端用户隔离和长期会话模型。
- 内置阅读统计、阅读习惯和阅读管理能力不符合知行的核心原则。
- README 声明 GPL-3.0；若属实，整体复制或衍生分发会带来 GPL 合规义务。必须核验 LICENSE 文件及依赖许可证后再决定是否复用代码。

初步结论：优先作为移动端与阅读/检索实现的研究样本，不建议直接作为闭源商业产品底座。

## 2. TextSage

仓库：https://github.com/sunnyvucs/TextSage

公开技术信息：
- Python、FastAPI、MinerU、PostgreSQL、Qdrant。
- PDF 教材抽取、章节页码对齐、主题切片、图表元数据、可恢复处理流水线。
- README 声明 MIT 许可证。

适合拆解：
- PDF 解析器选择与章节页码对齐。
- 目录层级和主题切片。
- 图片/图表与页码关联。
- 可恢复、可重跑的文档处理流水线。

不宜直接照搬：
- 场景面向教材 PDF 和本地 Ollama 推理。
- 依赖 Qdrant，知行初期倾向 PostgreSQL + pgvector，需评估迁移成本。
- 需确认代码成熟度、测试覆盖、实际 OCR/解析质量和许可证文件。

初步结论：当前最值得优先拆解的书籍处理流水线候选。

## 3. BookLore

仓库：https://github.com/booklore-app/booklore

公开技术信息：
- 自托管、多用户电子书库。
- Spring Boot 后端与 Angular 前端（以当前仓库源码复核）。
- 支持元数据、BookDrop 导入、书架、OPDS、Kobo/KOReader 同步和 EPUB/PDF/漫画阅读。
- 当前仓库标示 AGPL-3.0。

适合拆解：
- 书籍元数据模型和版本管理。
- 批量导入、文件处理与人工审核流程。
- 书库组织、管理员管理界面。
- 多用户书库和权限模型。

不宜直接照搬：
- 其产品是自托管电子书图书馆，不是对话优先的阅读 Agent。
- Java/Spring + Angular 与当前拟选技术栈不同。
- AGPL-3.0 对网络服务修改版本的提供方式有额外源码提供义务，闭源商业复用前必须进行法律与工程合规评估。

初步结论：主要借鉴书籍管理、导入和元数据设计，不建议直接作为底座。

## 4. RAGFlow

仓库：https://github.com/infiniflow/ragflow

公开技术信息：
- Apache-2.0。
- 面向文档理解、RAG 和 Agent 的较完整平台，代码与部署组件较多。

适合拆解：
- 文档解析和布局理解。
- 检索策略、重排和引用证据组织。
- 复杂文档的解析评估方法。

不宜直接照搬：
- 对知行早期阶段偏重，部署和维护成本较高。
- 不提供知行所需的移动端一书一长期对话产品形态。
- 应先验证其文档处理能力是否显著优于轻量方案，再考虑局部集成。

初步结论：作为复杂文档解析与 RAG 机制参考，不作为整体底座。

## 5. ChatPDF（shibing624）

仓库：https://github.com/shibing624/ChatPDF

公开技术信息：
- Python，支持 PDF、DOCX、Markdown、TXT 等文档。
- README 声明 Apache-2.0。
- 包含基础 RAG、中文切片优化和 GraphRAG 示例。

适合拆解：
- 中文文本切片。
- Embedding、召回与重排的基础实现。
- 简化 RAG 的可读代码样本。

不宜直接照搬：
- 项目 README 自述代码较粗糙，需审查依赖版本、异常处理、测试和安全。
- 不具备完整书籍生命周期、SaaS 多租户和长期对话能力。

初步结论：适合作为 RAG 基础算法和中文切片的学习样本。

## 初步复用优先级

| 优先级 | 项目 | 主要研究对象 | 初步策略 |
|---|---|---|---|
| P1 | TextSage | 文档解析、章节对齐、切片、任务恢复 | 深入拆源码 |
| P1 | ReadAny | Expo 移动端、书籍对话、原文定位、混合检索 | 深入拆源码；先核许可证 |
| P2 | BookLore | 书籍元数据、导入审核、书库管理 | 选择性借鉴设计 |
| P2 | ChatPDF | 中文切片、基础 RAG | 算法参考 |
| P3 | RAGFlow | 复杂文档解析、检索重排 | 只做能力对照 |

## 下一轮源码审查清单

每个项目按相同维度检查：
1. 目录结构与核心模块入口。
2. 数据模型：Book、Chapter、Document、Chunk、Conversation、Message。
3. 文档解析与格式适配。
4. 切片、Embedding、向量存储、混合检索。
5. 对话上下文和引用定位。
6. 文件上传、任务队列、失败重试。
7. 用户隔离、鉴权、权限。
8. 部署依赖、资源占用和开发启动难度。
9. LICENSE、依赖许可证、模型和数据授权。
10. 可复用代码清单、需重写部分和潜在合规风险。

## 参考链接

- ReadAny: https://github.com/codedogQBY/ReadAny
- TextSage: https://github.com/sunnyvucs/TextSage
- BookLore: https://github.com/booklore-app/booklore
- RAGFlow: https://github.com/infiniflow/ragflow
- ChatPDF: https://github.com/shibing624/ChatPDF


---

# 源码级补充审查（2026-11-13）

以下结论来自对关键源码文件的抽查，不等于完整安全审计或完整许可证合规审查。

## ReadAny：已检查关键实现

抽查文件：
- `packages/app-expo/package.json`
- `packages/core/src/types/chat.ts`
- `packages/core/src/stores/chat-store.ts`
- `packages/core/src/ai/chat-memory.ts`
- `packages/core/src/rag/vectorize-trigger.ts`
- `packages/core/src/rag/chunker.ts`

观察：
1. Expo 应用已经是较完整的移动端工程，使用 React Native、React Navigation、Expo SQLite、Zustand；同时依赖 LangChain 生态和多家模型 SDK。其移动端依赖体量和原生模块数量不算轻，不能简单理解为一个极简 Expo 示例。
2. Chat 类型包含 Thread、Message、Citation、Thread.memorySummary 等结构；Thread 通过 bookId 关联书籍。
3. Chat Store 明确按 bookId 区分书籍会话，并将线程和消息持久化到本地 SQLite。代码允许一本书存在多个 thread，并维护 bookActiveThreadIds；知行应进一步收敛为一本书唯一长期对话，不能照搬其多线程产品行为。
4. Chat memory 会将较旧消息压缩为 memorySummary，同时保留消息存储路径；但其摘要规则较宽泛，知行必须强化“用户观点、AI观点、原文事实分离”，并保证原始消息不可被摘要替代。
5. RAG 向量化流程包含切片、Embedding、批量入库、索引来源记录和进度回调；同时支持本地 Transformers.js 与远程 Embedding API。
6. 切片器基于 TextSegment 聚合，保留 CFI 起止位置及段落级 CFI，默认目标约 300 tokens、最小 50 tokens、重叠比例 0.2。这种“切片与原文定位绑定”的设计值得借鉴。
7. 类型中的 ReadingContext 包含当前章节、阅读位置百分比、选区、周边文本和操作类型。知行不应把阅读位置管理作为核心交互；可保留必要的原文定位元数据，但不要将其暴露为进度管理。

许可证：
- 仓库 LICENSE 文件明确为 GNU GPL v3。
- 初步策略：不直接复制其核心代码进入闭源产品。可研究架构和算法思想；如需复用具体代码，必须先做法律合规评估，或联系作者获取其他授权。

## TextSage：已检查处理流水线

抽查文件：
- `main.py`
- `src/pipeline.py`
- `api_server.py`
- README 与依赖配置（部分文件路径仍需进一步确认）

观察：
1. 主流程把处理拆成可独立执行的阶段：PDF 提取、manifest 校验、页面向量化、章节对齐、切片、写入 PostgreSQL、切片向量化和归档。
2. PDF 会先拆成逐页文件；抽取预览页后识别学科，再按配置选择 MinerU 或 PyMuPDF。
3. 章节目录解析、章节页码对齐、内容切片和向量写入相互独立，可按单本书重跑。这与知行“本地初加工 + 云端完整处理、失败可恢复”的方向高度相关。
4. API 侧使用 Qdrant 做向量召回，并回 PostgreSQL 取回完整 chunk；还根据 chunk 中的图号查找图片。
5. 当前 API 示例绑定 Ollama 本地模型，检索使用学科/年级过滤；这是教材 Tutor 的单场景实现，不是知行需要的通用多租户服务。
6. 项目 README 声明 MIT，但本次通过 GitHub Contents API 获取根目录 LICENSE 返回 404。许可证尚未完成核实，不能仅凭 README 声明就认定可直接复用。应进一步检查是否有其他授权文件、依赖许可证及仓库作者说明。

初步策略：
- 最值得借鉴其处理阶段拆分、manifest、可恢复流水线、章节页码对齐和图文关联。
- 不照搬其 Qdrant + Ollama 的部署组合；知行先验证 PostgreSQL + pgvector 是否够用。
- 在许可证核实前，只做技术研究，不复制代码。

## BookLore：已检查实体与导入队列

抽查文件：
- `BookEntity.java`
- `BookdropEventHandlerService.java`
- README、LICENSE

观察：
1. BookEntity 将书籍、元数据、文件、书架、用户阅读进度等关系分开建模；书籍可关联多个文件，并根据格式优先级选择主文件。
2. BookDrop 通过文件系统事件监听，将新文件放入阻塞队列，由后台线程异步处理。
3. 入队后先检查文件类型、重复路径和文件稳定性，再记录待审核状态，提取初始元数据并按配置补充在线元数据。
4. 这套“文件到达—稳定性检查—队列处理—待审核—元数据补全”的导入工作流值得借鉴。
5. 它是自托管数字图书馆，模型和用户体验都偏书库管理，不是对话优先产品。

许可证：
- LICENSE 文件明确为 GNU AGPL v3。
- 闭源商业产品如直接修改并通过网络向用户提供服务，可能触发 AGPL 对对应源码提供的义务。知行不应直接 Fork 作为底座，具体复用前需法律评估。

## ChatPDF：已检查 RAG 核心

抽查文件：
- `rag.py`
- README、LICENSE

观察：
1. 代码实现中文与英文不同切片路径，中文使用 jieba 分词及句末标点控制切分。
2. 支持 BM25 与句向量的混合召回，并提供 reranker 对候选结果重排。
3. 提供命中 chunk 的邻近上下文扩展，避免只把孤立片段交给模型。
4. RAG 类包含 chunk_size、chunk_overlap、similarity_top_k、rerank_top_k 等可调参数，可作为知行检索评测基线。
5. 代码较偏模型实验与本地推理，缺少完整 SaaS、多租户和长期对话产品结构。

许可证：
- LICENSE 文件明确为 Apache License 2.0。
- 若后续复用代码，仍需保留许可证和 NOTICE（如适用），并审查依赖许可证。

## RAGFlow：初步部署结构检查

抽查：
- `docker/docker-compose.yml`
- LICENSE

观察：
1. Docker Compose 组合包含多个服务和独立依赖，不是一个简单的 FastAPI + PostgreSQL 服务。
2. 仓库面向通用文档理解、RAG 和 Agent 基础设施，能力范围明显大于知行第一阶段。
3. LICENSE 为 Apache 2.0。
4. 不建议整体部署作为知行底座；应先针对复杂 PDF、版面解析、表格/图片理解和检索重排做对照测试。

## 更新后的判断

- **最优先深入拆解：TextSage 的处理流水线**，但许可证需要先核实。
- **最值得研究移动端与书籍对话：ReadAny**，重点看 Expo 工程、原文 CFI 定位、切片和向量化；GPL-3.0 阻止我们未经评估直接复制代码。
- **最值得研究书籍导入管理：BookLore**，重点看 BookDrop、待审核状态和实体关系；AGPL-3.0 下只做设计参考为主。
- **最值得研究中文 RAG 召回：ChatPDF**，可作为 Apache-2.0 候选代码样本，但需要评估依赖与工程质量。
- **RAGFlow 作为能力对照**，不作为早期系统底座。

下一步需要把 TextSage 的目录、关键阶段函数、数据表结构和实际部署依赖查完整；同时对 ReadAny 的会话、记忆和向量数据库实现补充单元测试与边界分析。


---

# 复用策略调整（2026-11-13）

## 产品使用范围补充

用户明确：知行当前不以商业化为前提，SaaS 形态主要是为了让用户本人和身边朋友共同使用。项目不应默认按“闭源商业 SaaS”筛选技术方案。

## 对开源许可证的处理原则

- 不再因为 GPL、AGPL 等许可证直接排除候选项目。
- 许可证不作为技术研究和方案比较的硬性否决条件。
- 仍记录项目及依赖的许可证，实际复用、修改、分发或对外提供网络服务前，确认相应义务。
- 不把“非商用”误解为“没有许可证义务”；部署方式、是否向第三方提供服务、是否分发修改版本等因素仍需考虑。
- 评估优先级调整为：功能与产品契合度、代码质量和可维护性、可运行性、改造成本、部署复杂度、许可证义务。

## 复用策略调整

- ReadAny：从“主要研究、不复制代码”调整为“优先评估可直接复用的模块”，尤其是 Expo 工程、书籍对话、CFI 原文定位、切片与向量化。
- TextSage：优先研究并评估其处理流水线代码能否直接纳入或改造成知行的本地/云端处理模块；许可证核验仍是必要信息，但不再预设为淘汰条件。
- BookLore：可评估直接复用其书籍导入、元数据和管理后台模块的可行性，同时判断 Spring Boot/Angular 技术栈是否值得整体引入。
- ChatPDF：可评估直接复用中文切片、混合召回和重排代码。
- RAGFlow：继续作为复杂文档解析能力对照；如果实际测试显示能显著降低开发成本，再评估局部集成或整体采用。

## 后续审查的核心问题

不先问“许可证是否让我们不能用”，而是先判断：
1. 能否实际运行，运行依赖和资源开销是多少？
2. 哪些模块与知行需求高度重合？
3. 直接复用、Fork 改造、独立重写，哪种总成本最低？
4. 是否会把不需要的阅读管理、复杂 Agent 或基础设施一并带进来？
5. 项目自身的许可证及第三方依赖义务是什么，实际部署/分发方式需要履行什么要求？

最终目标是选出最省时间、最稳妥、可持续维护的实现路径，而不是为了“全部自研”而自研。


## 深度源码审查结论

ReadAny 与 TextSage 的详细文件级分析、不能直接沿用的模块、组合架构及复用顺序，见 [ReadAny + TextSage 深度复用评估](reuse-assessment.md)。

当前推荐：
- ReadAny：作为手机端工程和书籍对话能力的 Fork 起点，先验证构建和核心流程。
- TextSage：提取 PDF 处理阶段设计和局部算法，不整体作为知行后端。
- 知行自建云端 API、用户隔离、一书一长期对话、认知记忆与书籍数据模型。
