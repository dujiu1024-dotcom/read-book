# 状态机、数据字典与 OpenAPI 契约一致性审查记录

日期：2026-11-13  
审查版本：state-machines.md 0.2.1-draft  
范围：D-030 至 D-049 产品决策、核心数据字典、OpenAPI 3.1、核心数据模型与状态机之间的字段/枚举/状态转换一致性。  
性质：文档静态审查与契约修订；不是数据库 PoC、安全评审或业务 API 实现验收。

## 1. 审查结论

第一轮字段核对发现 7 类契约缺口，另在 OpenAPI 机器校验中发现 1 处既有引用错误，均已在本分支修订：

1. GenerationJob 的 API 已出现 cancel_requested，但数据字典和 GenerationStatus 终态查询 Schema 未完整表达。
2. BackupUploadSession 在状态机中有生命周期，但 API 响应没有 status，也没有按 backup_id 查询上传会话/已接收分块的接口。
3. RecoveryChallenge 在状态机中有定义，但数据字典缺少实体字段。
4. BackupUploadSession 和 BackupManifest 只有枚举映射，缺少完整状态转换、终态和并发规则。
5. BackupManifest.inaccessible 在数据字典中存在，但状态机缺少 committed → inaccessible 转换。
6. AccountDataSetBinding 的“同一数据集最多一个 active 绑定”缺少明确的部分唯一索引规格。
7. OpenAPI 多处引用 components.responses.ApiError，但原契约只定义了 components.schemas.ApiError，Response Object 引用目标不存在；已补充 components.responses.ApiError 并引用既有 ApiError Schema。

以上已修订并增加 SM-025 至 SM-030 行为测试规格。当前仍有明确未决项，故文档继续保持 draft，不关闭 Issue #7。

## 2. 修订明细

| 对象 | 审查发现 | 本轮修订 |
|---|---|---|
| GenerationJob | API GenerationAccepted 已允许 cancel_requested，但 GenerationStatus 和数据字典未完整覆盖 | 将 cancel_requested 定义为非终态，补充 queued/running/cancel_requested 与 completed/failed/cancelled/expired 的转换语义；更新数据字典和 OpenAPI |
| BackupUploadSession | API Schema 未返回状态，且缺少断线后查询上传会话状态的接口 | BackupUploadSession Schema 增加 status；新增 GET /v1/backups/{backup_id}/session，返回状态与已接收分块 |
| RecoveryChallenge | 状态机有 issued/consumed/expired，数据字典无实体 | 增加 RecoveryChallenge 字段、索引和安全待确认边界 |
| BackupUploadSession | open/completing/completed/expired/rejected 缺少完整迁移表 | 增加状态转换、幂等分块、过期、完成和墓碑竞态规则 |
| BackupManifest | inaccessible 枚举无转换定义 | 补充 committed → inaccessible；仅失效化访问，不物理删除密文和密钥材料 |
| AccountDataSetBinding | 同一数据集最多一个 active 绑定，但无数据库约束规格 | 增加 local_dataset_id 的 active 部分唯一索引规格 |
| OpenAPI ApiError | $ref 指向不存在的 components.responses.ApiError | 新增标准 Response Object，并复用 components.schemas.ApiError |

## 3. 交叉核对结果

### 已对齐

- ReadingUnitProgress：not_presented / presented / awaiting_user / discussion_active / discussed / skipped；与数据字典一致。
- ReadingRound：active / completed / abandoned；completed 由所有主线单元终态决定。
- Thread：active / archived；唯一约束为 LocalDataSet + BookRevision。
- Message：pending / complete / failed / cancelled；其 pending 语义仍待产品/技术确认，未擅自解释。
- GenerationReceipt：submitted / streaming / completed / failed / cancelled / expired；与数据字典一致。
- LocalDataSet：active / locally_locked / restore_pending；与数据字典一致。
- Account：active / suspended / deleted；与数据字典一致。
- ExternalIdentity：active / revoked；与数据字典一致。
- AccountDataSetBinding：active / inactive / revoked；与数据字典一致。
- DataSetLifecycle：active / inactive / cleared；cleared 不可逆，墓碑优先。
- BackupAuthorization：active / used / expired / revoked；与数据字典一致。
- BackupManifest：uploading / committed / rejected / inaccessible；补充状态转换后与数据字典一致。

### API 边界

- GenerationJob 是服务端短暂任务；GenerationReceipt 是本地恢复记录；Message 是本地长期对话。三者不共用状态字段。
- GenerationStatus 查询完整最终结果；SSE 事件流不是最终结果权威来源。
- BackupUploadSession.completed 必须与 BackupManifest.committed 的提交结果一致。
- BackupUploadSession 过期/拒绝不等于 BackupManifest 已提交；只有 committed 清单进入可恢复列表。
- DataSetLifecycle.cleared 墓碑优先于上传完成、下载、恢复、授权签发和重新关联。
- 旧 API 路径历史草案在 core-data-model.md 中标为废止；当前 API 唯一权威来源为 api-contract.yaml。
- 首轮 OpenAPI 机器校验在 ApiError Response 引用处失败，定位为契约组件缺失；修复后由同一 CI 复跑确认，不将首次失败记为通过。

## 4. 尚未关闭的契约问题

| 编号 | 未决项 | 原因/处理 |
|---|---|---|
| OPEN-01 | Message.pending 表示本地持久化未完成，还是生成过程进行中 | 不得与 GenerationReceipt.streaming 混用；需产品/技术共同确认 |
| OPEN-02 | AccountDataSetBinding.account_id 为 TEXT，Account.id 为 UUID | 需确认本地保存 Account UUID 字符串还是平台 opaque subject；确认前不建立错误外键 |
| OPEN-03 | Device 是否需要独立实体/标识 | 第一版不做多设备同步；浏览器安装上下文标识需安全评审 |
| OPEN-04 | RecoveryChallenge proof 算法、恢复凭证标识哈希方式、失败次数与速率限制 | 由安全设计冻结，当前仅定义状态与数据最小化边界 |
| OPEN-05 | abandoned ReadingRound 是否允许恢复 | 建议第一版不恢复，避免混淆二刷语义 |
| OPEN-06 | 简短回应（如“确实”“不对”）是否视为实质讨论 | 允许 Agent 结合上下文判断，但不得以字数/理解评分判断 |

## 5. 证据与后续验证边界

- 本审查证明文档字段/枚举/状态语义经过静态核对和修订，不证明 SQLite 部分唯一索引、外键和事务语义已在目标运行环境验证。
- RecoveryChallenge、备份墓碑、账号切换和并发竞态仍需安全评审及后续 PoC。
- SM-001 至 SM-030 是可执行测试规格，不代表当前已有业务实现或自动化测试通过。
- Issue #7 应在 OPEN-01 至 OPEN-04 的产品/安全边界确认、文档链接质量门禁通过后再验收；不得把文档修订当作正式业务开发授权。
