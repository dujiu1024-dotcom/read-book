# 知行（read-book）

以书籍为知识来源、以长期对话为核心交互的阅读 Agent。

## 项目原则

> 用户通过与 Agent 对话来读书。Agent 不管理阅读过程，只参与阅读和思考。

用户决定何时阅读、何时发言、何时继续。原文呈现后，Agent 等待用户表达，不主动推送问题、提醒或下一段内容。

## 当前阶段（2026-11-14）

**MVP 0.1 正式开发已启动，目标是跑通“阅读原文 → 用户表达 → Agent 基于原文回应 → 自动认知沉淀 → 认知演变追溯”的完整闭环。**

- PR #24 领域模型与纯规则内核已合并到 main。
- PR #20 PC 窄屏阅读原型的 Chromium/Playwright 自动化 CI 已通过；后续以自动化视口矩阵和桌面浏览器兼容性检查验收，不要求实体手机/平板测试。
- PR #22 Playwright iPhone/Pixel 设备配置模拟测试已通过，用于验证响应式布局与触控目标；不要求实体设备复测。
- PR #13 已合并：IndexedDB 与 SQLite WASM + OPFS 对照 PoC 完成，ADR-0001 有条件首选 SQLite WASM + OPFS 单写入 Worker；#1 仍待 lockfile 级依赖可重复性验收。
- #2 加密备份 PoC 已有自动化证据，但生产密钥持久化、生产服务端架构和安全评审未完成。
- PR #16 已合并：EPUB/PDF/TXT 首版导入 PoC，Chromium 12/12 自动化测试通过；样本为自建夹具，#3 仍待真实出版物抽样、复杂版式和精确回跳验收。
- #4 生成任务 PoC 使用 Mock Server，已验证消息先落本地、幂等、流式事件和断线恢复；不代表生产队列或真实模型服务完成。
- #5 书籍包 Schema/校验器与 #9 质量门禁已有 CI 证据，仍需最终审查。
- #6 当前为合成语料和 Mock 检索评测，不构成真实中文书籍或生产 Agent 质量基线。
- #7 身份、数据集与状态机契约仍需完成一致性验收。
- PR #32 已合并：LocalRepository 事务契约、数据集边界和 Agent 消息持久化端口已建立。PR #33 正在推进 SQLite OPFS Repository 首版适配器，完整迁移/备份/损坏恢复尚未完成。
- #28 已合并 PR #29：完成可配置的认知候选价值评估、观点来源区分、置信度/歧义度与 Citation 来源门禁；抽取、版本演变和持久化仍在开发。
- #27 已合并 PR #31：完成 GenerationTransport 协议、事件序号校验和本地先保存后请求的编排边界；真实 HTTP/SSE 服务仍未接入。

PoC、设备配置模拟和 CI 通过仅代表对应自动化范围通过，不等于生产安全或完整产品验收通过。项目不安排实体手机/平板真机测试，以自动化浏览器测试、响应式视口矩阵和标准桌面浏览器兼容性检查作为验收方式。

## 当前 MVP 工作主线

唯一 MVP 总控：[#23 跑通阅读—讨论—认知沉淀闭环](https://github.com/dujiu1024-dotcom/read-book/issues/23)

- [x] [#24 领域模型与纯规则内核](https://github.com/dujiu1024-dotcom/read-book/pull/24)（已合并）
- [x] [#20 PC 窄屏阅读原型自动化与浏览器兼容性验收](https://github.com/dujiu1024-dotcom/read-book/pull/20)（已合并）
- [x] [#22 移动触控适配模拟视口自动化验收](https://github.com/dujiu1024-dotcom/read-book/pull/22)（已合并，不要求实体设备测试）
- [x] [#8 PC 阅读交互原型](https://github.com/dujiu1024-dotcom/read-book/issues/8)（PR #20/#22 已合并；原型验收完成）
- [ ] [#25 正式阅读客户端](https://github.com/dujiu1024-dotcom/read-book/issues/25)（PR #30 已合并：BookContentProvider 解耦；真实书籍 Provider 待接入）
- [ ] [#26 本地个人数据 Repository](https://github.com/dujiu1024-dotcom/read-book/issues/26)（PR #32 已合并 Repository 契约；PR #33 SQLite OPFS 适配器开发中）
- [ ] [#27 Agent 生成适配器与可靠消息交付](https://github.com/dujiu1024-dotcom/read-book/issues/27)（PR #31 已合并：协议适配与先保存后请求；真实 Transport 待接入）
- [ ] [#28 自动认知沉淀、版本演变与来源追溯](https://github.com/dujiu1024-dotcom/read-book/issues/28)（PR #29 已合并：认知候选评估规则）

推进原则：#25 继续接入真实书籍 Provider；#26 按 ADR-0001 推进 SQLite OPFS 适配器，但生产放行仍受 lockfile、迁移、恢复和备份验收约束；#27 已完成协议边界，继续接真实 HTTP/SSE Transport；#28 继续完成认知抽取和版本演变。

## 技术验证与质量保障

- 第一组总控：[#11 本地阅读基础能力与可靠性验证（#1–#4）](https://github.com/dujiu1024-dotcom/read-book/issues/11)
- 第二组总控：[#12 书籍协议、Agent 质量、产品契约与工程门禁（#5–#9）](https://github.com/dujiu1024-dotcom/read-book/issues/12)
- 最终技术整合：[#10 独立 PoC、契约与 CI 整合验收](https://github.com/dujiu1024-dotcom/read-book/issues/10)

两组总控负责证据、风险和状态跟踪，不构成所有 MVP 开发工作的前置依赖。#10 负责其范围内的技术整合结论，不替代 MVP 端到端产品验收。

## MVP 0.1 验收目标

1. 至少一本合法授权、来源可追溯的真实书籍可导入并阅读。
2. 原文展示、主线阅读、临时查看/复习和引用回跳符合产品原则。
3. 用户消息先可靠落本地，再发起 Agent 生成；刷新/断线后可恢复。
4. Agent 回应能关联书籍原文证据；无证据时明确说明。
5. 系统自动识别值得沉淀的认知，不依赖用户主动收藏。
6. 认知支持补充、修正、冲突、推翻和延伸；旧版本不可覆盖。
7. 再次打开后恢复书籍、阅读主线、讨论和认知历史。
8. 数据集隔离、软删除和授权清除边界通过负向测试。
9. 关键自动化测试通过，并完成标准桌面浏览器兼容性与响应式视口矩阵验收；不要求实体设备测试。

## 文档导航

- [产品原则与功能边界](docs/product-principles.md)
- [技术架构与关键设计](docs/architecture.md)
- [核心数据模型概览](docs/core-data-model.md)
- [核心数据字典（字段与约束权威来源）](docs/data-dictionary.md)
- [核心状态机（主线、轮次、生成与备份）](docs/state-machines.md)
- [OpenAPI 3.1 接口契约（API 路径权威来源）](docs/api-contract.yaml)
- [全书知识库与管理员加工工作台](docs/book-knowledge-base.md)
- [阅读 Agent 交互与主线机制](docs/reading-agent.md)
- [用户认知记忆与读书笔记](docs/user-memory.md)
- [本地数据、加密备份与账号分离](docs/data-storage-security.md)
- [标准书籍包与云端验收协议](docs/book-package-ingestion-contract.md)
- [决策记录](docs/decision-log.md)
- [项目审查与验证策略](docs/project-audit.md)、[验证策略](docs/validation-strategy.md)
- [PC Web 详细技术设计](docs/pc-web-detailed-design.md)
- [PC Web 技术 PoC 验证计划](docs/pc-web-poc-plan.md)
- [PC Web 窄屏阅读交互规范](docs/pc-web-interaction-spec.md)
- [文档验收报告](docs/document-acceptance-report.md)
- [ADR-0001：PC Web 私人数据主存储路线](docs/adr/0001-local-storage-engine.md)

## 核心产品形态

- 知行不是电子书阅读器或学习计划工具，而是围绕原文展开的长期阅读对话。
- 原文按作者结构拆分为语义完整的论述单元；展示后等待用户发言，不主动推送问题或内容。
- 阅读界面上方展示可折叠原文，下方展示讨论；两者属于同一思维过程。
- 不打分、不考试、不评估用户理解程度；Agent 负责回应和讨论。
- 一本具体书籍版本对应一条长期 Thread；阅读轮次在同一 Thread 中累积。
- 全书主线按作者章节和论述逻辑组织；临时查看/复习不改变主线。
- Agent 自动识别并沉淀重要认知，不设置收藏动作。
- 用户个人阅读数据以本地为主存储，服务器只保存加密备份。
- 账号注销、数据集解绑和备份清除遵循已确认的数据隔离与软删除语义。

## 架构边界

- 用户个人数据：本地为主，服务器加密备份为辅。
- 公共书籍数据：服务器管理书籍版本、原文和全书知识库。
- 管理员工作台：负责书籍上传、加工、质量验收和发布，不访问用户私人阅读数据。
- 云端模型调用可能接收当前讨论所需的最小上下文，须明确告知并限制传输范围。
- 书籍加工链路与用户个人数据备份链路相互独立。

## 技术方向（部分待验证）

客户端本地数据库、服务端账号与公共书籍服务、加密备份服务、Agent 编排与模型 API。具体框架和数据库选型以对应 PoC、自动化测试证据、标准浏览器兼容性检查和安全评审为准，未经验证不冻结。