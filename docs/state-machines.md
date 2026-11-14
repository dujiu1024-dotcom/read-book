# 知行核心状态机

> 版本：0.2.1-draft  
> 状态：设计草案；产品语义边界已按已确认原则约束，讨论完成判定、消息持久化边界及恢复流程仍有待确认。  
> 权威范围：定义阅读主线、阅读轮次、生成任务、消息、备份和数据集的状态及转换。字段定义见 [核心数据字典](data-dictionary.md)，API 定义见 [OpenAPI 契约](api-contract.yaml)。交叉审查记录见 [状态机与 API 契约一致性审查](state-machine-contract-audit.md)。

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

## 5. Thread 状态机

Thread 状态仅表达会话生命周期，不表达阅读进度。

| 当前状态 | 事件 | 下一状态 | 规则 |
|---|---|---|---|
| 不存在 | 用户首次打开具体 BookRevision 的阅读对话 | active | 创建唯一 Thread |
| active | 用户归档 | archived | 保留全部历史数据 |
| archived | 用户重新打开 | active | 恢复同一 Thread，不创建新 Thread |

唯一性：同一 LocalDataSet + BookRevision 只能有一条 Thread。不同版本分别建立 Thread。

## 6. Message 与 Generation 状态机

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
queued → running → cancel_requested → cancelled / completed / failed
queued → cancel_requested → cancelled / completed / failed
queued / running → completed / failed / expired（终态竞态由服务端原子提交决定）

本地 GenerationReceipt：
submitted → streaming → completed / failed / cancelled / expired

规则：
- cancel_requested 是非终态，表示已收到取消请求但任务尚未提交最终结果；API 的 GenerationAccepted / GenerationStatus 均可返回该状态。
- cancel_requested → cancelled 表示取消成功；若任务在取消生效前自然完成或失败，则允许转为 completed / failed。所有终态只能原子提交一次；取消与自然完成竞态以服务端先提交的终态为准。
- 客户端取消接口返回 202 只代表取消请求已接受，不代表最终状态已经 cancelled。
- 网络断开不等于任务失败；客户端恢复连接后通过 generation_id 查询。
- 事件流 sequence 只用于增量显示和断点恢复，不是最终结果权威来源。
- 服务端 completed 后必须可查询完整结果，直到 expires_at。
- 客户端成功写入本地 Assistant Message 后，GenerationReceipt 标记 completed 并记录 result_message_id。
- 服务端 TTL 到期后任务结果可清除；本地已持久化消息不受影响。
- 同一个 Idempotency-Key 重放必须返回同一个生成任务，不得重复执行。

## 7. 备份上传状态机

queued → snapshotting → serializing → encrypting → uploading → verifying → committed

失败分支：
- retryable_failed：网络错误、超时、服务端暂时不可用；保留任务并退避重试。
- permanent_failed：协议不兼容、密文校验失败、数据集已清除、授权无效；停止自动重试并提示。
- cancelled：仅允许在备份提交前取消。

约束：
- 备份快照绑定单一 dirty_sequence。
- 上传期间产生的新变更进入更高 dirty_sequence，不混入当前快照。
- 服务端确认 committed 后，客户端才推进 last_acked_sequence。
- 增量备份必须绑定已提交 parent_backup_id；父链不完整时不能作为可恢复备份提交。
- 同一备份请求重试必须幂等；分块上传按 part_no 和密文哈希去重。
- 清除墓碑优先于任何上传完成请求；已清除数据集不得产生新的可恢复备份。
- 每次应用启动执行备份检查；检查异步执行，不阻塞首屏和本地阅读。

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

三类状态不可混为一个枚举：

| 层级 | 状态/阶段 | 含义与映射 |
|---|---|---|
| 客户端备份任务 | queued / snapshotting / serializing / encrypting | 本地准备阶段；尚未形成服务端可恢复备份 |
| 客户端备份任务 | uploading | 服务端 BackupUploadSession 应为 open |
| 客户端备份任务 | verifying | 服务端 BackupUploadSession 为 completing；服务端校验分块、数量、密文哈希、版本和墓碑 |
| 客户端备份任务 | committed | 服务端 BackupUploadSession 为 completed，且 BackupManifest 为 committed；客户端才推进 last_acked_sequence |
| 客户端备份任务 | retryable_failed | 保留本地任务与快照上下文，退避重试；不得伪造服务端 rejected |
| 客户端备份任务 | permanent_failed | 记录错误并停止自动重试；服务端是否 rejected 由实际校验结果决定 |
| 服务端 BackupUploadSession | open / completing / completed / expired / rejected | 上传会话生命周期；completed 不得绕过 Manifest 最终提交检查 |
| 服务端 BackupManifest | uploading / committed / rejected / inaccessible | 备份清单生命周期；只有 committed 且父链完整的备份可进入可恢复清单 |

### 11.1 BackupUploadSession 状态转换

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 幂等初始化请求通过校验 | open | 创建上传会话，返回已收到分块列表 |
| open | 分块上传通过哈希与 part_no 校验 | open | 相同 part_no + 相同哈希为幂等成功；相同 part_no + 不同哈希拒绝 |
| open | 客户端提交 complete | completing | 原子锁定会话，检查分块数量和清除墓碑 |
| open | 超过 expires_at | expired | 不再接受分块或完成请求 |
| completing | 密文哈希、分块、版本、父链和墓碑校验全部通过，Manifest 提交成功 | completed | 仅在 Manifest.committed 后进入 completed |
| completing | 校验失败或墓碑命中 | rejected | 记录错误；不得生成可恢复清单 |
| completed / expired / rejected | 重放请求 | 不变 | 返回既有结果或明确拒绝，不重新提交、不复活 |

### 11.2 BackupManifest 状态转换

| 当前状态 | 事件/条件 | 下一状态 | 处理规则 |
|---|---|---|---|
| 不存在 | 初始化备份并创建清单 | uploading | 仅为待提交记录，不可恢复 |
| uploading | 上传会话完成且密文/父链/墓碑校验通过 | committed | 进入可恢复备份清单 |
| uploading | 校验失败、会话过期或清除墓碑命中 | rejected | 不可恢复；密文对象按存储保留策略处理 |
| committed | 数据集被清除或访问资格被不可逆撤销 | inaccessible | 只失效化清单可用性，不物理删除原始密文和密钥材料 |
| rejected / inaccessible | 重试或普通授权 | 不变 | 不允许原位复活；新备份必须使用新 backup_id 和 backup_sequence |

inaccessible 是访问状态，不代表密文已删除或已损坏；DataSetLifecycle.cleared 墓碑仍是所有读写接口的最终判定权威。

补充约束：
- 网络中断、页面关闭或客户端超时不等于服务端上传失败；恢复后先查询上传会话状态和备份清单，再决定续传或重建。
- API 必须提供按 backup_id 查询上传会话状态及已收到分块的只读接口；客户端不能通过猜测最后一次 HTTP 响应推断会话状态。

- 客户端不得仅凭 HTTP 成功响应推进 `last_acked_sequence`，必须确认服务端 `BackupManifest.committed`。
- `retryable_failed`、`permanent_failed` 是客户端任务状态，不是 BackupManifest 的新枚举值。
- 同一幂等键重试必须返回同一上传会话；已提交备份不可被重试覆盖。
- 清除墓碑在会话完成和清单提交时再次检查；墓碑存在时拒绝提交且不得复活数据集。

## 12. 消息与生成状态边界（待契约确认）

- `GenerationJob` 是服务端短暂计算任务；`GenerationReceipt` 是本地恢复生成状态的记录；`Message` 是本地长期对话记录。三者不能共用一个状态字段。
- 用户 Message 必须在发起网络生成前本地持久化成功；生成失败不删除用户 Message。
- Assistant Message 只有完整结果写入本地事务后才可标记 `complete`。
- 当前数据字典为 Message 定义了 `pending / complete / failed / cancelled`，但尚未明确 `pending` 是否表示本地持久化事务未完成，还是生成过程进行中。不得用 Message.pending 代替 GenerationReceipt.streaming；该字段语义须在契约评审中明确。
- 流式 delta 仅为临时 UI 状态；不得作为正式 Message 或备份数据。
- GenerationJob 的 `completed / failed / cancelled / expired` 是服务端终态；终态竞态由服务端原子提交决定。客户端以查询到的最终结果为准，不以 SSE 事件流作为最终权威。

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
| SM-025 | GenerationJob 为 running，取消请求先于任务终态提交 | 客户端请求取消 | 任务进入 cancel_requested；接口返回 202；随后只能原子提交 cancelled / completed / failed 之一 |
| SM-026 | BackupUploadSession 为 open，客户端因断网不确定分块是否成功 | 客户端按 backup_id 查询会话 | 返回当前状态与已收到分块；相同 part_no/哈希重传幂等，不同哈希拒绝 |
| SM-027 | BackupManifest 为 committed | 数据集清除墓碑成功提交 | Manifest 转为 inaccessible；原始密文不物理删除，所有下载/恢复仍由墓碑拒绝 |
| SM-028 | BackupUploadSession 为 completing，清除请求并发提交 | 服务端完成最终校验 | 清除墓碑优先；会话 rejected，Manifest 不得 committed |
| SM-029 | 同一 LocalDataSet 已存在 active AccountDataSetBinding | 另一账号尝试建立 active 绑定 | 唯一约束拒绝；不得出现同数据集双账号同时可访问 |
| SM-030 | RecoveryChallenge 为 consumed 或已过期 | 客户端重放 challenge_id | 拒绝重放；不签发第二份 BackupAuthorization，必须创建新挑战 |

## 15. 尚待确认与验证

### 需要产品确认
1. 简短回应（如“确实”“不对”）是否可由 Agent 结合上下文判定为实质性讨论；建议允许上下文判断，但不得依赖字数阈值。
2. 用户在主线已完成后要求重新深入讨论某个 skipped 单元，是否只作为 review，不改变已完成轮次状态；建议默认如此，除非用户主动开启新一轮。
3. abandoned 轮次是否允许继续恢复；建议第一版先不提供恢复 abandoned 的入口，避免和二刷语义混淆。
4. Message.pending 的持久化语义，以及本地 Message 状态与 GenerationReceipt 状态的映射。
5. 浏览器安装上下文是否需要独立 Device 标识；第一版不因此引入多设备同步或数据集自动合并。
6. RecoveryChallenge 的失败次数、速率限制、挑战有效期和重放保护参数，由安全设计确定。
7. AccountDataSetBinding.account_id 在数据字典中为 TEXT，而服务端 Account.id 为 UUID；需确认它存储 Account UUID 字符串还是平台 opaque subject，确认前不得假定二者可直接关联。

### 需要 PoC 验证
- 本地事务并发下主线状态与 Message sequence 一致性。
- 页面关闭/刷新、生成断线、取消竞态时的状态恢复。
- 多标签页锁、备份快照和 dirty_sequence 正确性。
- 状态事件与业务实体事务的原子性。
- 临时查看/复习绝不改变主线状态的自动化测试。
- 账号注销不级联删除备份、账号切换不泄露其他数据集、清除墓碑与上传/授权并发竞态测试。
- 恢复挑战单次消费、授权过期/撤销及 cleared 墓碑阻断恢复的测试。

