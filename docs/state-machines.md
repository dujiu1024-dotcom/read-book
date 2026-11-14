# 知行核心状态机

> 版本：0.3.0-draft  
> 状态：SQLite v6 本地阅读状态已落地；服务端账号、恢复挑战和备份后端仍是 API/设计契约，尚未有正式服务端实现。  
> 权威范围：定义阅读主线、阅读轮次、生成任务、消息、备份和数据集的状态及转换。字段定义见 [核心数据字典](data-dictionary.md)，API 定义见 [OpenAPI 契约](api-contract.yaml)。

## 1. 状态机总原则

1. 主线位置只由当前 ReadingRoundState 决定；临时查看和复习不得修改主线位置。
2. 作者原有章节和论述顺序是唯一主线；不能因临时查看、发散讨论或复习改变顺序。
3. 原文展示后等待用户发言；Agent 不主动推送问题、下一段原文、测验或提醒。
4. 不评估用户理解程度，不打分、不考试、不设置达标门槛。
5. 用户表达、原文展示、Agent 回复和笔记都必须保留可追溯来源。
6. 状态变更必须在本地数据库事务内完成；网络生成结果不能直接修改主线状态，必须由本地领域逻辑根据用户行为和最终结果推进。

## 2. 主线论述单元状态机

### 2.1 状态定义

| 状态 | 含义 | 是否允许推进 |
|---|---|---:|
| not_presented | 本轮主线尚未展示该论述单元 | 否 |
| presented | 原文已展示，PresentedSource 已写入本地 | 否 |
| awaiting_user | 原文展示完成，等待用户表达 | 否 |
| discussion_active | 用户消息已先行持久化，且来源标记为 mainline | 否 |
| discussed | 用户在讨论后主动点击继续，单元完成 | 是 |
| skipped | 用户确认理解并选择略读 | 是 |

### 2.2 已实现状态转换（SQLite v6）

| 当前状态 | 事件/条件 | 下一状态 | 持久化规则 |
|---|---|---|---|
| not_presented | 主线原文展示并创建 PresentedSource | presented | PresentedSource 与 progress 在本地事务中提交 |
| presented | 同一展示流程进入等待 | awaiting_user | 允许同一事务内连续写入 presented → awaiting_user |
| awaiting_user | 用户消息本地持久化，来源 presentationType=mainline | discussion_active | 记录 last_activity_message_id；必须先保存 Message |
| discussion_active | 用户点击“继续下一单元” | discussed | 终态，不回退 |
| awaiting_user | 用户确认“已理解并略读” | skipped | 只接受显式确认，不根据沉默/停留时长自动略读 |
| discussed / skipped | 重新查看或深入讨论 | 不变 | 创建 review PresentedSource，不回退进度 |
| 任意状态 | 临时查看、复习或引用展示 | 不变 | 只新增 temporary / review / citation PresentedSource |

当前实现不声称能从语义上判断用户是否真正理解，也不以模型自动判定讨论是否收束。V1 将“已讨论”定义为：至少一条关联当前主线单元的用户消息已持久化，随后用户主动选择继续。后续可增加语义分类，但不得改变原始消息与来源证据。

### 2.3 实质性讨论与略读边界

- 任何关联当前主线单元的用户消息都会使状态进入 discussion_active；这只表示发生了讨论输入，不代表理解正确。
- 纯确认、沉默或停留时间不会自动进入 discussed。
- 用户点击继续时，如果没有讨论输入，界面必须先询问是否确认略读。
- skipped 必须由用户明确确认；不能批量跳过尚未展示的单元。
- review / temporary / citation 不改变 ReadingUnitProgress。


### 2.1 状态定义

| 状态 | 含义 | 是否允许推进 |
|---|---|---:|
| not_presented（未展示） | 本轮主线尚未展示该论述单元 | 否 |
| presented（已展示） | 原文已展示，展示记录已落本地 | 否 |
| awaiting_user（待用户表达） | 原文展示完成，Agent 正在等待用户发言 | 否 |
| discussion_active（讨论中） | 用户已就当前单元表达问题、理解、观点、质疑或关联想法，讨论尚未收束 | 否 |
| discussed（已讨论） | 当前单元已完成本轮讨论，允许推进 | 是 |
| skipped（已略读） | 用户明确确认已理解并选择略读，允许推进 | 是 |

presented 与 awaiting_user 可以在同一事务中连续发生，但保留两个事件：原文展示成功、Agent 进入等待。这样可审计“展示过”与“当前等待”的差别。

### 2.2 允许的状态转换

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| not_presented | 主线展示成功并写入 PresentedSource | presented | 必须绑定当前 ReadingRound 和原文定位 |
| presented | 展示事务完成 | awaiting_user | Agent 停止主动输出，等待用户 |
| awaiting_user | 用户发出实质性讨论内容 | discussion_active | 只识别交互意图，不评价理解正确与否 |
| discussion_active | 用户继续提问/解释/质疑/补充 | discussion_active | 继续围绕本单元讨论 |
| discussion_active | 用户在已有实质讨论后发出继续阅读/推进指令，或自然表达本段讨论已结束 | discussed | 由 Agent 结合上下文判断交互是否已收束；不要求用户手动切换讨论模式 |
| awaiting_user | 用户要求继续，但本单元尚无实质讨论 | awaiting_user | 先询问是否已理解并希望略读；不得直接推进 |
| awaiting_user | 用户确认已理解并选择略读 | skipped | 记录用户确认事件 |
| awaiting_user | 用户选择继续讨论 | discussion_active | 留在当前单元 |
| discussion_active | 用户发出继续阅读/推进指令 | discussed | 记录本轮结束事件；不额外要求用户点击“结束讨论” |
| discussed / skipped | 用户要求重新查看或深入讨论该单元 | 不变 | 创建 review PresentedSource 并关联新讨论；不得回退 ReadingUnitProgress 终态。若用户要重新走完整主线，应由用户主动开启新 ReadingRound |
| 任意状态 | 临时查看其他章节 | 不变 | 创建 temporary PresentedSource，不改主线状态 |
| 任意状态 | 复习已读单元 | 不变 | 创建 review PresentedSource，不改主线状态 |

### 2.3 “实质性讨论”的拟定识别规则（待确认）

该规则只判断用户是否真正开始围绕本单元交流，不判断用户是否理解正确。

可视为实质性讨论的行为：
- 用户提出与本段有关的问题；
- 用户复述、解释或表达自己的理解；
- 用户提出观点、质疑、反例或不同意见；
- 用户将本段与自己的经验、其他知识或其他章节关联；
- 用户明确表达“我理解了，主要意思是……”等认知内容。

单独出现以下内容，不自动视为已讨论：
- “嗯”“好”“收到”等纯确认；
- “继续”“下一段”“往下读”等推进指令；
- 单个表情、无语义回应或与本段无关的寒暄。

**重要：** 上述识别是交互行为分类，不是理解度检测。即使用户的理解有误，也可以算作已经发生讨论；Agent 应在后续对话中回应和澄清，而不是阻止推进。

仍需产品确认的关键边界：
- 当用户只发出简短但可能有态度含义的回应（例如“确实”“不对”）时，是否由 Agent 结合上下文判定为实质讨论。
- 用户要求继续但没有实质讨论时，确认文案建议为：“如果你已经理解这一段，可以选择略读；如果还没弄明白，我们继续讨论。”不得把略读包装成默认选项或强迫用户答题。

### 2.4 略读约束

- 略读必须是用户主动确认，不允许 Agent 根据停留时长、沉默或“看起来不想读”自动略读。
- 用户仅说“不想看了”“跳过吧”，不能直接认定为已理解；Agent 应说明当前单元尚未讨论，并询问是否已理解并确认略读。
- 用户确认“已理解，略读”后，当前单元转为 skipped。
- skipped 是本轮主线的有效完成方式，不代表用户永久放弃该内容；用户仍可随时复习。
- 不允许批量略过尚未展示的后续主线单元。

## 3. 阅读轮次状态机

### 3.1 状态

| 状态 | 含义 |
|---|---|
| active | 当前阅读轮次进行中 |
| completed | 本轮全部主线单元均为 discussed 或 skipped |
| abandoned | 本轮被明确终止；不等同于完成 |

### 3.2 转换规则与当前实现

- 首次打开 Thread 且不存在历史轮次时，自动创建 round_number=1。
- 已有 active 轮次时恢复该轮，不创建新轮。
- 只有所有 ReadingUnitProgress 都进入 discussed / skipped，才能将 ReadingRound 标记为 completed。
- completed 后不自动开启下一轮；PC 页面显示“开启新一轮阅读”，由用户主动触发。
- 新一轮在同一 Thread 下 round_number 递增，从当前 BookRevision 的主线第一个单元开始；历史 Message、Note、Memory、PresentedSource 全部保留。
- abandoned 状态在 Repository 中可表达，但当前 UI 暂无主动放弃入口。


### 3.1 状态

| 状态 | 含义 |
|---|---|
| active | 当前阅读轮次进行中 |
| completed | 当前版本的全部主线论述单元均已讨论或由用户确认略读 |
| abandoned | 用户明确终止本轮；不等同于完成 |

### 3.2 转换规则

- Thread 创建后启动 round_number=1，状态 active。
- 用户主动开启二刷/三刷时，在同一 Thread 下创建新 ReadingRound，round_number 递增。
- 新一轮从作者主线第一个单元开始，但历史消息、笔记、Memory 和来源关系全部保留。
- 只有当前 BookRevision 的所有主线论述单元都处于 discussed 或 skipped，且无未完成主线单元时，ReadingRound 才可转为 completed。
- 临时查看和复习记录不计入主线完成度。
- completed 后 Agent 询问用户是否开启下一轮；不得自动开启。
- abandoned 不允许被报告为 completed；是否允许恢复 abandoned 轮次需在产品规则中另行确认。

## 4. 主线位置与临时查看/复习

### 4.1 主线位置

- Thread 级位置由 SQLite v6 的 ReadingPosition 保存：mainline_node_id、displayed_node_id、view_mode、current_unit_discussed。
- 每轮每个单元的状态由 ReadingUnitProgress 保存；两者不能混为一张表。
- 主线推进必须先将当前单元写入 discussed / skipped，再更新 ReadingPosition 并呈现下一单元。
- 若下一单元原文加载失败，不得提前改变主线位置。

### 4.2 临时查看

- 因知识关联查看其他章节，presentation_type=temporary。
- 临时查看可以展示原文并继续讨论，但不得改变 ReadingPosition.mainline_node_id、ReadingUnitProgress 或轮次完成状态。
- 临时讨论消息保留来源引用，并标记 presentationType=temporary。

### 4.3 复习与引用

- 复习已读内容，presentation_type=review；引用回看，presentation_type=citation。
- 复习/引用不创建新 ReadingRound，不改变主线节点和单元状态。
- 复习中的讨论仍写入原 Thread，但不能回退 discussed / skipped 终态。


### 4.1 主线推进

- 当前主线节点由 ReadingRoundState.current_structure_node_id 表示。
- 推进时按已发布 BookRevision 的主线结构顺序定位下一个论述单元。
- 推进必须在一个本地事务中完成：校验当前单元可推进 → 记录其 discussed/skipped 终态 → 更新当前节点 → 创建新 PresentedSource → 写入展示事件。
- 若下一单元原文获取失败，不能提前推进；应保留当前节点和待处理状态。

### 4.2 临时查看

- 因知识关联查看其他章节或后续内容，presentation_type=temporary。
- 临时查看可以展示原文并围绕其讨论，但不得改变当前主线节点、主线单元状态或轮次完成状态。
- 临时讨论产生的 Message、Citation、Note、Memory 仍保留来源，但其 PresentedSource 必须标记 temporary。
- 临时查看结束后，Agent 应引导回到原主线位置；不得自动把临时章节变为主线下一节。

### 4.3 复习

- 复习已读内容，presentation_type=review。
- 复习不创建新 ReadingRound，不改变当前主线节点和单元状态。
- 复习中的讨论消息仍写入原 Thread，并关联复习 PresentedSource；是否形成 Note/Memory 仍按自动沉淀规则判断。

## 5. Thread 生命周期边界

SQLite v6 的 Thread 只持久化 id、dataset_id、book_revision_id、created_at，并通过 (dataset_id, book_revision_id) 保证唯一。当前版本没有 Thread.status 字段，也没有归档/恢复状态转换；因此不应把 active / archived 描述为已实现能力。不同阅读轮次在同一 Thread 内累积。


## 6. Message 与 Generation 状态机

### 6.1 本地 Message

| 角色 | 状态 | 含义 |
|---|---|---|
| user | saved | 用户原始消息已本地持久化 |
| assistant | generating | 已创建占位消息，生成尚未完成 |
| assistant | completed | 服务端权威结果已写入本地 |
| assistant | failed | 生成失败，保留失败记录 |
| assistant | cancelled | 生成取消，保留消息与任务记录 |

- 本地 Message 只允许 user / assistant，不持久化 system。
- 用户消息必须先写入本地，再请求生成。
- SSE delta 仅用于临时显示，不作为正式消息正文。
- Assistant Message 只有在服务端权威快照返回 completed + result，且本地事务提交后才变为 completed。
- 用户消息及失败记录不因生成失败而删除。

### 6.2 服务端 GenerationJob 与本地 GenerationDelivery

服务端 GenerationJob 的设计状态：queued → running → completed / failed / cancelled / expired。

本地 GenerationDelivery（SQLite v3）状态：queued → running → completed / failed / cancelled / expired。

- 本地 delivery 保存 client_generation_id、generation_id、idempotency_key、消息关联、last_sequence、last_event_id 和 expires_at。
- 重复提交复用同一客户端生成身份与幂等键；事件游标不回退；终态不可回退。
- 网络断开不等于任务失败；恢复时从本地 cursor 续传，并以服务端最终快照作为权威结果。
- 正式服务端 GenerationJob 尚未部署；上述服务端状态是 API/设计契约，不代表后端已实现。


### 6.1 Message

| 状态 | 含义 | 允许转换 |
|---|---|---|
| pending | 消息已创建但尚未完成持久化/生成 | complete / failed / cancelled |
| complete | 消息正文完整并已持久化 | 终态 |
| failed | 生成或持久化失败，保留失败记录 | 通过新消息/新生成尝试恢复，不覆盖原记录 |
| cancelled | 生成已取消 | 通过新生成尝试恢复，不覆盖原记录 |

- 用户 Message 必须先写入本地并标记 complete，再发起网络请求。
- Assistant Message 只有在服务端最终结果完整返回且本地事务提交后才标记 complete。
- 流式 delta 仅为 UI 临时状态，不创建正式 Message。
- 重新生成创建新的 Assistant Message，并用 supersedes_message_id 指向被替代的旧回复。
- 消息 sequence 在同一 Thread 内单调递增；失败尝试也不能复用已分配的 sequence。

### 6.2 GenerationJob / GenerationReceipt

服务端 GenerationJob：
queued → running → completed / failed / cancelled / expired

本地 GenerationReceipt：
submitted → streaming → completed / failed / cancelled / expired

规则：
- 服务端终态只允许一次；取消与自然完成竞态由服务端原子提交先后决定。
- 网络断开不等于任务失败；客户端恢复连接后通过 generation_id 查询。
- 事件流 sequence 只用于增量显示和断点恢复，不是最终结果权威来源。
- 服务端 completed 后必须可查询完整结果，直到 expires_at。
- 客户端成功写入本地 Assistant Message 后，GenerationReceipt 标记 completed 并记录 result_message_id。
- 服务端 TTL 到期后任务结果可清除；本地已持久化消息不受影响。
- 同一个 Idempotency-Key 重放必须返回同一个生成任务，不得重复执行。

## 7. 备份上传状态机

客户端流程阶段：snapshotting → encrypting → uploading → awaiting_commit → committed。

- 只有服务端返回 committed，客户端才调用 acknowledgeBackup。
- dirty_sequence 在本地事务提交时递增；acknowledgeBackup 只确认本次一致性快照的 sequence。
- 上传期间的新写入保留更高 sequence，不会被本次确认吞掉。
- 失败或网络断开不自动确认；待上传密文包和幂等身份保存在本地，恢复时查询服务端 received_parts 后续传。
- 新设备先查询备份并询问是否恢复；恢复只允许导入空数据集。
- 客户端已实现 HTTP 上传/下载适配器与加密链恢复；正式服务端、清除墓碑并发竞态和生产安全评审仍未完成。


## 8. 数据集生命周期状态机

服务端 DataSetLifecycle：
- active：允许在授权范围内查询备份、上传新备份和恢复。
- inactive：未被当前账号绑定或当前无活动授权；不能据此推断数据已销毁。通过有效独立恢复凭证可重新发起恢复授权。
- cleared：用户已清除个人数据；不可逆墓碑，阻断读取、检索、下载、恢复、重新授权、重新关联和上传完成。

转换：
- active → inactive：账号关系解除或生命周期进入非活动状态；原始密文保留。
- active / inactive → cleared：用户完成明确清除确认。
- cleared → 任意其他状态：禁止。

本地 LocalDataSet 生命周期与服务端 DataSetLifecycle 分离。账号切换不得自动改变本地数据集；用户必须显式选择当前账号下可用的数据集。跨账号恢复必须走独立恢复凭证流程，且清除墓碑不可绕过。


## 9. 账号身份、数据集与绑定状态机

本节区分账号身份、外部登录身份、本地数据集、账号绑定和服务端数据集墓碑。它们不是同一个生命周期。

### 9.1 Account

状态：`active`、`suspended`、`deleted`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 完成账号注册 | active | 创建身份主体，不创建或接管私人数据集 |
| active | 风控/管理冻结 | suspended | 禁止新认证及受限在线操作；不得删除本地数据或备份 |
| suspended | 解冻 | active | 恢复允许的认证能力 |
| active / suspended | 用户完成账号注销 | deleted | 账号身份与认证关系失效；不得级联清除本地数据集或服务器加密备份 |
| deleted | 重新注册 | 不变 | 视为新账号；不得自动恢复旧账号绑定 |

`deleted` 为终态。账号注销不是个人数据清除；不能把 Account.deleted 映射为 DataSetLifecycle.cleared。

### 9.2 ExternalIdentity

状态：`active`、`revoked`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 绑定受支持的登录身份 | active | `(provider, provider_subject)` 全局唯一 |
| active | 用户解绑或账号注销 | revoked | 认证映射失效，不删除账号以外的数据 |
| revoked | 重新绑定 | 新建身份记录 | 不复活旧映射；仍须满足唯一性和账号状态校验 |

### 9.3 AccountDataSetBinding

状态：`active`、`inactive`、`revoked`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 用户明确选择数据集并建立当前账号上下文 | active | 显式绑定；同一数据集最多一个 active 账号绑定 |
| active | 用户切换账号或主动解除当前选择 | inactive | 只解除当前上下文，不修改数据集内容及备份 |
| active / inactive | 账号注销或绑定被安全撤销 | revoked | 不删除数据集，不自动迁移或合并 |
| inactive | 用户再次明确选择同一账号下的数据集 | active | 重新校验账号权限与数据集状态 |
| revoked | 再次使用 | 禁止复活 | 需要重新走合法绑定流程并产生新绑定记录 |

账号切换后，在用户明确选择数据集前，不得读取、展示或写入此前账号的数据集。跨账号恢复必须走独立恢复凭证流程，不得把本地绑定当作恢复授权。

### 9.4 LocalDataSet

本地状态：`active`、`locally_locked`、`restore_pending`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 首次初始化本地数据 | active | 创建本地数据集 |
| active | 当前账号上下文切换/退出 | active | 数据仍保留，但访问必须经过显式数据集选择和账号隔离校验 |
| active | 本地安全锁定 | locally_locked | 禁止读取和写入，解锁后回到 active |
| 不存在/空数据集 | 用户主动开始备份恢复 | restore_pending | 先保护现有本地数据；恢复过程不得覆盖非空数据集 |
| restore_pending | 密文验证、解密、结构迁移和关系校验全部成功 | active | 原子提交恢复结果 |
| restore_pending | 任一步失败 | 原状态或受保护快照 | 不得留下半恢复、半覆盖数据；记录失败原因 |

`LocalDataSet.lifecycle_status` 与服务端 `DataSetLifecycle.status` 分离管理。第一版不做多设备实时同步；不同设备产生的数据集不得自动合并。当前数据字典没有独立 Device 实体，故本契约不虚构设备账号或设备同步状态；浏览器安装上下文是否需要持久化设备标识，列为安全设计待评审项。

### 9.5 Server DataSetLifecycle

状态：`active`、`inactive`、`cleared`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 首次建立备份数据集索引 | active | 仅保存最小必要索引和密文元数据 |
| active | 当前账号绑定解除或无活动授权 | inactive | 不代表数据销毁；密文保持不变 |
| inactive | 合法恢复凭证通过校验并重新授权 | active | 重新建立可用授权前必须检查墓碑 |
| active / inactive | 用户明确确认清除个人数据 | cleared | 软删除/失效化用户关联索引和可用授权；原始密文及密钥材料保持不动 |
| cleared | 任意登录、恢复、授权、上传完成或重新关联请求 | cleared | 不可逆墓碑优先，拒绝业务操作 |

清除动作必须覆盖并发竞态：任何上传完成、授权签发、下载和恢复操作在最终提交时都必须再次检查墓碑；不能只在请求入口检查一次。

## 10. 恢复挑战与恢复授权状态机

### 10.1 RecoveryChallenge

状态：`issued`、`consumed`、`expired`。

- 创建挑战前校验恢复凭证标识格式、频率限制和滥用防护；挑战不得泄露数据集是否存在。
- `issued → consumed`：挑战响应验证成功并原子消费；同一挑战不得重复签发授权。
- `issued → expired`：超过 expires_at 后失效。
- `consumed`、`expired` 均为终态；重试必须创建新挑战。
- 挑战响应验证失败不得泄露恢复凭证或数据集信息；失败次数与限流策略由安全设计确定。

### 10.2 BackupAuthorization

状态：`active`、`used`、`expired`、`revoked`。

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | RecoveryChallenge 验证成功 | active | 签发短时、范围受限的恢复授权 |
| active | 完成授权范围内的恢复使用 | used | 单次授权消费；记录 used_at |
| active | 超过 expires_at | expired | 不可再下载或恢复 |
| active | 数据集清除、风险撤销或主动撤销 | revoked | 立即失效 |
| used / expired / revoked | 再次使用 | 不变 | 拒绝；重新恢复必须创建新挑战和授权 |

授权签发、下载和恢复每一步均须检查 `DataSetLifecycle`。`cleared` 优先于所有授权状态。恢复凭证独立于账号密码；服务端不得存储恢复凭证明文。凭证丢失且无其他有效恢复方式时，数据不可恢复，不设置管理员解密后门。

## 11. 备份任务、上传会话与备份清单的状态映射

三层状态不可混为一个枚举：

| 层级 | 当前契约 |
|---|---|
| 客户端 Repository 备份边界 | createConsistentSnapshot → upload → acknowledgeBackup；上传失败不确认 |
| 服务端 BackupUploadSession | API 目前定义上传会话标识、过期时间、分块大小上限和 received_parts；会话内部状态机尚未由正式服务端实现 |
| 服务端 BackupRecord / Manifest | API 响应只将 committed 备份列入可恢复清单；未提交备份不得作为恢复源 |

补充约束：
- 网络中断、页面关闭或客户端超时不等于服务端上传失败；恢复后先查询会话和清单，再决定续传。
- 客户端不得仅凭 HTTP 成功响应推进 last_acked_sequence，必须确认 BackupRecord.status=committed。
- 服务端清除墓碑优先于上传完成和恢复；正式服务端必须在 complete/restore 时再次检查。


## 12. 消息与生成状态边界（实现对齐）

- Message 是本地长期对话记录；GenerationDelivery 是本地可恢复任务交付记录；GenerationJob 是服务端计算任务。三者不能共用一个状态字段。
- user Message 状态为 saved；assistant Message 使用 generating / completed / failed / cancelled。
- GenerationDelivery 使用 queued / running / completed / failed / cancelled / expired。
- completed Assistant Message 必须来自服务端权威快照并在本地事务中提交。
- 当前代码不存在 Message.pending，也不存在独立 GenerationReceipt 表；旧文档中的这两个概念已分别由 saved/generating 状态和 GenerationDelivery 取代。


## 13. 事件与审计最低要求

关键事件建议：
- mainline.source_presented
- mainline.awaiting_user
- mainline.discussion_started
- mainline.discussed
- mainline.skipped_confirmed
- mainline.advanced
- source.temporary_presented
- source.review_presented
- reading_round.started
- reading_round.completed
- generation.submitted / generation.completed / generation.failed / generation.cancelled
- backup.started / backup.committed / backup.failed
- dataset.cleared

事件至少包含 event_id、local_dataset_id、thread_id（适用时）、reading_round_id（适用时）、entity_id、event_type、occurred_at、schema_version。事件日志存本地并纳入加密备份；服务端不得为审计而保存私人消息正文。

## 14. 契约测试规格（Given / When / Then）

以下是供后续实现和自动化测试直接采用的行为规格，不代表当前已有可执行测试或 PoC 已通过。

| 编号 | Given（前置条件） | When（事件） | Then（预期结果） |
|---|---|---|---|
| SM-001 | 当前主线单元为 not_presented | 原文成功展示并完成本地事务 | 单元依次记录 presented、awaiting_user；绑定当前轮次和原文定位 |
| SM-002 | 当前单元为 awaiting_user，尚无实质讨论 | 用户要求继续 | 不推进主线；询问用户是否已理解并确认略读 |
| SM-003 | 当前单元为 awaiting_user | 用户明确确认已理解并略读 | 单元转为 skipped；记录确认事件后才允许推进 |
| SM-004 | 当前单元为 discussion_active | 用户主动要求继续 | 单元转为 discussed；在本地事务中推进到下一主线单元 |
| SM-005 | 当前主线位置为 N | 用户临时查看其他章节 | 创建 temporary PresentedSource；ReadingRoundState 和 ReadingUnitProgress 不变 |
| SM-006 | 某单元已为 discussed 或 skipped | 用户要求复习/再次深入讨论 | 创建 review PresentedSource；原单元状态和轮次完成状态不回退 |
| SM-007 | 当前轮次至少一个主线单元未进入 discussed/skipped | 用户请求结束阅读 | 轮次不得标记 completed |
| SM-008 | 当前轮次全部主线单元均为 discussed/skipped | 最后一个单元完成事务成功 | 轮次可标记 completed；不得自动创建下一轮 |
| SM-009 | 同一 LocalDataSet + BookRevision 已有 Thread | 再次打开该版本阅读 | 返回原 Thread，不创建第二条 Thread |
| SM-010 | Thread 为 archived | 用户重新打开 | 同一 Thread 回到 active；历史消息和来源关系保留 |
| SM-011 | 用户消息尚未成功写入本地 | 用户发送消息并触发生成 | 不得先发起网络生成；本地持久化失败时不提交生成请求 |
| SM-012 | GenerationJob 已 completed，但客户端尚未落本地结果 | 客户端重连并查询 generation_id | 获取完整最终结果并尝试本地事务写入；不得仅依赖 SSE 最后一条事件 |
| SM-013 | 同一生成请求已使用 Idempotency-Key 创建任务 | 客户端以同一键重试 | 返回同一 GenerationJob，不重复执行生成 |
| SM-014 | 应用启动且本地存在未备份变更 | 启动备份检查遇到离线/网络错误 | 应用和本地阅读继续可用；保留待备份状态，不丢失本地变更 |
| SM-015 | 增量备份请求缺少已提交 parent_backup_id | 服务端验收备份 | 拒绝将其提交为可恢复增量备份 |
| SM-016 | 数据集已 cleared，且存在并发中的上传完成请求 | 请求提交 BackupManifest | 最终提交检查命中墓碑并拒绝；不得复活数据集或推进 last_acked_sequence |
| SM-017 | 用户已登录账号 B，但当前设备仅有账号 A 的数据集绑定 | 用户尚未明确选择数据集 | 不展示、不读取、不写入账号 A 的数据集 |
| SM-018 | Account 已注销，服务器仍保留加密备份 | 用户查询账号状态或重新注册 | 不级联删除备份；新账号不得自动接管旧数据集 |
| SM-019 | RecoveryChallenge 已 consumed 或 expired | 客户端重放同一挑战 | 拒绝重放；必须创建新挑战 |
| SM-020 | BackupAuthorization 为 active，但 DataSetLifecycle 已 cleared | 用户请求下载或恢复 | 墓碑优先，授权立即不可用；请求拒绝 |
| SM-021 | LocalDataSet 为非空，用户启动恢复 | 恢复流程开始 | 先保护现有数据；不得直接覆盖，必须由产品流程明确处理目标数据集 |
| SM-022 | LocalDataSet 处于 restore_pending | 解密、迁移或关系校验任一步失败 | 不提交半成品；保留原数据/快照并记录失败原因 |
| SM-023 | ExternalIdentity 已 revoked | 使用原 provider_subject 登录 | 拒绝旧映射；重新绑定必须创建新记录并通过唯一性校验 |
| SM-024 | AccountDataSetBinding 为 inactive | 用户明确重新选择该账号下的数据集 | 重新校验权限与 DataSetLifecycle 后才可转为 active |

## 15. 外部实现与最终验收边界

### 尚未由正式服务端实现的状态机
- Account / ExternalIdentity / BackupAuthorization / RecoveryChallenge / DataSetLifecycle / GenerationJob 的状态定义仍是服务端契约；需要正式后端实现、授权与安全评审。
- BackupUploadSession 的服务端内部状态转换、墓碑并发控制、挑战失败次数/速率限制和授权撤销竞态需要后端实现与安全评审。
- Thread archived 状态、MigrationLog 独立审计表和 BackupJournal 逐行变更表不属于当前 SQLite v6 已实现范围。

### 最终统一验收（本轮开发不执行）
- SQLite v5→v6 原子迁移、ReadingRound/PresentedSource/ReadingUnitProgress 状态转换与快照恢复。
- 页面关闭/刷新、生成断线/取消、备份续传和新设备恢复。
- 临时查看/复习/citation 不改变主线进度。
- 正式服务端清除墓碑、账号注销、恢复授权和生成终态竞态。


### 需要产品确认
1. 简短回应（如“确实”“不对”）是否可由 Agent 结合上下文判定为实质性讨论；建议允许上下文判断，但不得依赖字数阈值。
2. 用户在主线已完成后要求重新深入讨论某个 skipped 单元，是否只作为 review，不改变已完成轮次状态；建议默认如此，除非用户主动开启新一轮。
3. abandoned 轮次是否允许继续恢复；建议第一版先不提供恢复 abandoned 的入口，避免和二刷语义混淆。
4. Message.pending 的持久化语义，以及本地 Message 状态与 GenerationReceipt 状态的映射。
5. 浏览器安装上下文是否需要独立 Device 标识；第一版不因此引入多设备同步或数据集自动合并。
6. RecoveryChallenge 的失败次数、速率限制、挑战有效期和重放保护参数，由安全设计确定。

### 需要 PoC 验证
- 本地事务并发下主线状态与 Message sequence 一致性。
- 页面关闭/刷新、生成断线、取消竞态时的状态恢复。
- 多标签页锁、备份快照和 dirty_sequence 正确性。
- 状态事件与业务实体事务的原子性。
- 临时查看/复习绝不改变主线状态的自动化测试。
- 账号注销不级联删除备份、账号切换不泄露其他数据集、清除墓碑与上传/授权并发竞态测试。
- 恢复挑战单次消费、授权过期/撤销及 cleared 墓碑阻断恢复的测试。

