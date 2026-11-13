# 知行（read-book）

以书籍为知识来源、以长期对话为核心交互的阅读 Agent。

## 项目原则

> 用户通过与 Agent 对话来读书。Agent 不管理阅读过程，只参与阅读和思考。

阅读时间、阅读节奏、读什么、何时停止，都由用户决定。产品不以阅读进度、打卡、计划或提醒驱动用户。

## 文档导航

- [产品原则与功能边界](docs/product-principles.md)
- [技术架构与关键设计](docs/architecture.md)
- [核心数据模型与 API 契约草案](docs/core-data-model.md)
- [开源项目拆解与复用评估](docs/opensource-review.md)
- [ReadAny + TextSage 深度复用评估](docs/reuse-assessment.md)
- [决策记录](docs/decision-log.md)
- [项目记录审查与下一步清单](docs/project-audit.md)
- [P0 开源项目运行验证记录](docs/p0-validation-report.md)
- [验证策略与验收清单（含平台入口与平台无关核心验证）](docs/validation-strategy.md)
- [标准书籍包与云端验收协议](docs/book-package-ingestion-contract.md)
- [ReadAny 逐文件适配清单](docs/readany-adaptation-matrix.md)
- [ReadAny 自动化测试覆盖审查](docs/readany-test-coverage-audit.md)

## 当前阶段

产品与技术方案讨论、开源项目调研阶段。尚未进入正式开发。未经明确确认，不直接开始业务代码开发。

当前入口方向：暂不锁定 Android/iOS 或具体跨端框架；优先验证微信小程序作为主入口候选、服务号作为辅助入口候选，并保持云端核心平台无关。当前仍处于验证阶段。

## 核心产品形态

- 用户端以手机为主；PC Web 作为管理员工作台。
- 不是阅读器，而是 Agent 主导的原文精读产品。
- Agent 按作者原有章节结构和论述逻辑提供原文；用户先理解、复述、提问，再与 Agent 讲解、讨论和辩论。
- 允许略读，不允许跳过主线；允许复习和查看其他章节原文，但不改变主线位置。
- 一本书只有一个长期 Thread；完成整本书后可开启新阅读轮次，历史对话和笔记全部保留。
- 每本书上架前建立全书通用知识库；用户个人对话、笔记和认知记忆独立隔离。
- 所有对话自动保存；Agent 自动识别并沉淀重要认知，不设置收藏功能。
- 用户加入书架即获得永久访问权；移出书架采用软删除，商城下架不影响既有访问权。
- 原始聊天记录保留；上下文压缩和认知摘要不得覆盖原始数据。
- 默认只有一个阅读导师 Agent，围绕作者主线引导用户阅读、讨论和思考。

## 技术方向（待验证）

React Native + Expo、React + Vite 管理端、Python + FastAPI、PostgreSQL + pgvector、Redis、对象存储、第三方模型 API。采用模块化单体，先不拆微服务。

## 架构边界

书籍可由本地工具进行初加工，但云端必须保留完整的解析、OCR、清洗、切片、向量化、索引构建、校验和更新能力。本地处理结果是可选的预处理输入，云端是正式数据的权威来源。
