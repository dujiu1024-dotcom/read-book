# 知行核心状态机

> 版本：0.1.0-draft  
> 状态：设计草案；产品语义边界已按已确认原则约束，讨论完成判定细则仍待确认。  
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
| discussed / skipped | 用户要求重新讨论当前单元 | discussion_active | 若当前轮仍活动，允许重新打开；保留既有事件 |
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

## 9. 事件与审计最低要求

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

## 10. 尚待确认与验证

### 需要产品确认
1. 简短回应（如“确实”“不对”）是否可由 Agent 结合上下文判定为实质性讨论；建议允许上下文判断，但不得依赖字数阈值。
2. 用户在主线已完成后要求重新深入讨论某个 skipped 单元，是否只作为 review，不改变已完成轮次状态；建议默认如此，除非用户主动开启新一轮。
3. abandoned 轮次是否允许继续恢复；建议第一版先不提供恢复 abandoned 的入口，避免和二刷语义混淆。

### 需要 PoC 验证
- 本地事务并发下主线状态与 Message sequence 一致性。
- 页面关闭/刷新、生成断线、取消竞态时的状态恢复。
- 多标签页锁、备份快照和 dirty_sequence 正确性。
- 状态事件与业务实体事务的原子性。
- 临时查看/复习绝不改变主线状态的自动化测试。

