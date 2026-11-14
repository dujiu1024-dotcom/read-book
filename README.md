# 知行（read-book）

以书籍为知识来源、以长期对话为核心交互的阅读 Agent。

## 项目原则

> 用户通过与 Agent 对话来读书。Agent 不管理阅读过程，只参与阅读和思考。

用户决定何时阅读、何时发言、何时继续。原文呈现后，Agent 等待用户表达，不主动推送问题、提醒或下一段内容。

## 当前阶段（2026-11-14）

**MVP 0.1 的主要产品代码链路已进入 main，当前重点转为收尾缺口、配置边界和最终整合。**

- #1：IndexedDB 与 SQLite WASM + OPFS 对照 PoC、ADR-0001 和自动化证据已进入仓库；仍缺依赖 lockfile 的可重复安装基线。
- #2：端侧加密备份 PoC 已实现全量/增量、分块加密、续传和清除墓碑；仍需生产威胁模型、密码学评审、生产服务端及密钥轮换策略。
- #3：EPUB/PDF/TXT 导入 PoC 已实现；真实授权出版物、复杂版式、OCR 和定位人工抽样仍未完成。
- #4：Mock Generation Server 的幂等、SSE、断线恢复和取消验证已完成；正式 HTTP/SSE Transport 已在产品运行时实现，但生产服务端仍需部署。
- #5：PR #52 已合并书籍包 v1 Schema、目录/ZIP 校验器 CLI 和处理契约校验；不代表云端加工服务已实现。
- #6：PR #59 已合并离线 JSONL 评测工具，覆盖 Recall@K、引用准确/覆盖、Groundedness、拒答、行为违规、延迟和 Token Cost；真实中文书籍、授权记录、人工标注和模型实测仍未完成。
- #7：状态机、数据字典和 OpenAPI 已有一致性修订；Message.pending、账号 ID 类型、恢复挑战证明等语义仍需产品/安全决策。
- #9：PR #53 已合并 Markdown、JSON/JSONL、OpenAPI 和书籍包契约质量门禁；当前仅手动触发，最终验收后再启用 PR/main 自动触发。
- MVP 主链路：PR #40、#43–#45、#48–#49、#51 已合并，覆盖本地消息与认知持久化、PC 阅读运行时、Agent 会话控制、备份上传和空数据集恢复。
- PR #54 已修复生成服务地址配置；PR #55 已合并失败任务重试，复用原始用户消息并保留历史 Assistant 尝试。
- 真实书籍 API、Generation API、模型 Provider、备份服务地址和认证模块均由部署环境注入；仓库未包含生产凭据或生产服务实现。

PoC、自动化和代码合并只证明对应代码范围已交付，不等于真实服务、真实书籍质量或生产安全验收完成。项目不安排实体手机/平板真机测试，以自动化浏览器测试、响应式视口矩阵和标准桌面浏览器兼容性检查作为验收方式。

## 当前 MVP 工作主线

唯一 MVP 总控：[#23 跑通阅读—讨论—认知沉淀闭环](https://github.com/dujiu1024-dotcom/read-book/issues/23)

- [x] [#24 领域模型与纯规则内核](https://github.com/dujiu1024-dotcom/read-book/pull/24)（已合并）
- [x] [#20 PC 窄屏阅读原型自动化与浏览器兼容性验收](https://github.com/dujiu1024-dotcom/read-book/pull/20)（已合并）
- [x] [#22 移动触控适配模拟视口自动化验收](https://github.com/dujiu1024-dotcom/read-book/pull/22)（已合并，不要求实体设备测试）
- [x] [#8 PC 阅读交互原型](https://github.com/dujiu1024-dotcom/read-book/issues/8)（PR #20/#22 已合并；原型验收完成）
- [x] [#25 正式阅读客户端代码主线](https://github.com/dujiu1024-dotcom/read-book/issues/25)（PR #30/#34/#45 已合并；真实 API 环境与真实书籍验收仍待部署）
- [x] [#26 本地个人数据 Repository 代码主线](https://github.com/dujiu1024-dotcom/read-book/issues/26)（PR #32/#33/#37–#40/#43/#48/#49/#51 已合并；生产备份服务与安全评审仍待完成）
- [x] [#27 Agent 生成适配器与可靠消息交付代码主线](https://github.com/dujiu1024-dotcom/read-book/issues/27)（PR #31/#35/#40/#44/#45/#55 已合并；真实服务端/认证由部署环境提供）
- [x] [#28 自动认知沉淀、版本演变与来源追溯代码主线](https://github.com/dujiu1024-dotcom/read-book/issues/28)（PR #29/#36/#37/#42/#43/#48 已合并；模型 Provider 与真实样本质量评测仍待配置）

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