# Agent/RAG 离线评测输入输出契约（V1）

## 1. 文件

- `fixtures/corpus.jsonl`：每行一个 chunk。
- `fixtures/questions.jsonl`：每行一道人工标注问题。
- Predictions：由任意检索器/模型适配器生成，评测器不绑定特定厂商。

## 2. Prediction JSONL

每行对应一个 question_id，示例：

```json
{
  "question_id": "E01",
  "retrieved_chunk_ids": ["epub-001", "epub-003"],
  "citations": [
    {
      "chunk_id": "epub-001",
      "locator": {"type": "epub_cfi_fixture", "value": "/6/2[chapter1]!/4/2"}
    }
  ],
  "claims": [
    {
      "text": "协同效率不等于沟通次数增加。",
      "claim_type": "author_fact",
      "evidence_chunk_ids": ["epub-001"],
      "human_adjudicated_supported": true
    }
  ],
  "abstained": false,
  "agent_actions": [],
  "latency_ms": 340,
  "input_tokens": 800,
  "output_tokens": 120
}
```

字段要求：
- `retrieved_chunk_ids`：按检索排序返回；Recall@K 只计算前 K 个。
- `citations`：回答实际展示给用户的引用，不是全部召回结果。
- `locator`：必须由被引用 chunk 的原始 locator 透传，不允许模型自行编造。
- `claims`：拆分可核验的主张；来源类别为 author_fact / user_view / ai_inference。
- `human_adjudicated_supported`：人工审阅后填写；未经审阅必须省略，不能默认 true。
- `abstained`：是否明确说明证据不足或样本无法回答。
- `agent_actions`：记录实际发生的 Agent 行为事件，供规则检查。
- `latency_ms`、`input_tokens`、`output_tokens`：实际测量值；Mock 必须显式标记运行配置，不能冒充真实模型成本。

每道题必须恰好有一条预测。重复 question_id、未知 chunk、缺失问题或非法数值均使评测失败。

## 3. 指标定义

| 指标 | 定义 | 说明 |
|---|---|---|
| Recall@K | Top K 召回的 gold evidence 数 / gold evidence 总数 | 无依据题不计入 |
| Citation Precision | 实际引用中属于 gold evidence 的引用数 / 实际引用总数 | chunk 命中不等于语义支持，仍需人工审阅 |
| Citation Coverage | 有至少一条 gold 引用的可回答题数 / 可回答题总数 | 不评价引用是否足以支持每个子结论 |
| Groundedness | 人工判定有依据的作者事实 claim 数 / 已审阅作者事实 claim 总数 | 脚本不自动判语义蕴含 |
| Locator Accuracy | 正确结构化 locator 的定位题数 / 有定位标注的题数 | 精确字段比较 |
| Abstention Accuracy | 对无依据题正确拒答的题数 / 无依据题总数 | 同时观察可回答题错误拒答率 |
| Policy Violations | 禁止的主动推送、下一段推送、测验、打分和催促行为次数 | 依赖适配器记录的事件日志 |
| Latency / Token Cost | 平均耗时、输入 token、输出 token | 需记录真实运行环境和模型版本 |

首轮不设置人为合格阈值。先跑出可复现测量值，再结合产品风险讨论阈值。
