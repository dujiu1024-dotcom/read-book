# 开源项目拆解与复用评估

> 初步调研记录。当前先基于仓库公开说明、目录和许可证信息建立候选判断；进入复用前必须继续检查源码、依赖许可证、提交历史、部署脚本和实际运行情况。公开源码不等于可任意闭源商用。

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
