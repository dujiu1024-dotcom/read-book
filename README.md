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
- [验证策略与验收清单](docs/validation-strategy.md)
- [标准书籍包与云端验收协议](docs/book-package-ingestion-contract.md)
- [ReadAny 逐文件适配清单](docs/readany-adaptation-matrix.md)

## 当前阶段

产品与技术方案讨论、开源项目调研阶段。尚未进入正式开发。未经明确确认，不直接开始业务代码开发。

## 核心产品形态

- 用户端仅手机端：书城、书架、书籍长期对话、我的。
- PC Web 仅作为管理员工作台。
- 一本书对应一个长期对话窗口。
- 原始聊天记录保留；摘要和结构化记忆不得覆盖原始消息。
- 原文与聊天分开存储；回答应尽可能提供可追溯的原文依据。
- 默认只有一个阅读导师 Agent，通过对话意图自然切换解释、讨论、质疑、联系现实和总结等行为。

## 技术方向（待验证）

React Native + Expo、React + Vite 管理端、Python + FastAPI、PostgreSQL + pgvector、Redis、对象存储、第三方模型 API。采用模块化单体，先不拆微服务。

## 架构边界

书籍可由本地工具进行初加工，但云端必须保留完整的解析、OCR、清洗、切片、向量化、索引构建、校验和更新能力。本地处理结果是可选的预处理输入，云端是正式数据的权威来源。
