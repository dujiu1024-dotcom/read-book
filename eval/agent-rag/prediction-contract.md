# Agent/RAG 离线评测输入输出契约（V1）

Prediction JSONL 每行对应一个 question_id。retrieved_chunk_ids 按检索排序；citations 是实际展示给用户的引用；locator 必须透传 chunk 原始 locator，不允许模型编造；claims 拆分可核验主张，human_adjudicated_supported 必须由人工审阅；abstained 表示是否说明证据不足；agent_actions 记录实际行为；latency_ms 和 token 字段必须来自实际运行。Mock 结果必须标明 run_kind，不得冒充真实模型。

| 指标 | 定义 |
|---|---|
| Recall@K | Top K 命中的 gold evidence / gold evidence 总数 |
| Citation Precision | 实际引用中命中 gold evidence 的比例 |
| Citation Coverage | 可回答问题中至少有一条 gold 引用的比例 |
| Groundedness | 人工判定有依据的 author_fact claim 比例 |
| Locator Accuracy | 正确结构化定位 / 有定位标注的题目 |
| Abstention Accuracy | 无依据问题被正确拒答的比例 |
| Policy Violations | 禁止主动推送、下一段推送、测验、打分和催促事件次数 |
| Latency / Token Cost | 实际耗时和模型 token 成本 |

首轮不设置人为合格阈值。先建立可复现测量，再结合产品风险讨论阈值。
