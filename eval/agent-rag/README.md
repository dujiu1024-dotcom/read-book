# 中文书籍 Agent/RAG 质量评测基线

本目录提供独立、离线、可替换检索器与模型的评测工具，不实现正式 Agent 或生产 RAG 服务。

## 当前状态

- 12 个合成 chunk fixture：模拟 EPUB 结构定位、PDF 页码/栏位定位、TXT 行号定位。
- 30 道标注问题：原文事实、跨段综合、概念解释、反驳作者、书中无依据、引用定位六类。
- 评测脚本：Recall@K、Citation Precision、Citation Coverage、人工 Groundedness、Locator Accuracy、拒答行为、Agent 规则事件、耗时和 Token 成本。
- Gold-blind lexical mock adapter：只根据问题文本和 chunk 文本检索，不读取 gold evidence 或 answerable 标签；CI 会运行并归档 mock predictions 与测量报告。
- 自动化测试：评测计算、输入完整性、未知引用、重复 ID 和数据集一致性。
- **尚无真实书籍样本和真实模型/检索器结果。当前 fixture 只验证评测工具，不构成真实质量基线。**

## 运行

Python 3.11+，无第三方依赖：

```bash
python -m unittest discover -s eval/agent-rag -p 'test_*.py' -v
python eval/agent-rag/mock_adapter.py --corpus eval/agent-rag/fixtures/corpus.jsonl --questions eval/agent-rag/fixtures/questions.jsonl --output /tmp/mock-predictions.jsonl
python eval/agent-rag/evaluator.py evaluate --corpus eval/agent-rag/fixtures/corpus.jsonl --questions eval/agent-rag/fixtures/questions.jsonl --predictions /tmp/mock-predictions.jsonl --output /tmp/mock-report.json
python eval/agent-rag/evaluator.py evaluate \
  --corpus eval/agent-rag/fixtures/corpus.jsonl \
  --questions eval/agent-rag/fixtures/questions.jsonl \
  --predictions /path/to/predictions.jsonl \
  --output artifacts/agent-rag-report.json \
  -k 3
```

每道问题必须有一条预测记录；预测协议见 [prediction-contract.md](prediction-contract.md)。标注规则见 [annotation-guideline.md](annotation-guideline.md)。

## 适配器边界

检索器/模型适配器只需读取 question JSONL，并输出同 question_id 的 prediction JSONL。适配器可接入 Mock、本地模型或真实 API；必须记录模型/检索器版本、运行配置、语料版本和实际成本。不得把 Mock 结果标成真实模型结果。

## 下一阶段真实样本要求

至少三本具有明确授权依据的真实中文样本：
1. 结构清晰 EPUB；
2. 复杂 PDF（注明扫描/OCR、双栏、脚注等特征）；
3. 结构较弱 TXT。

每本固定原始文件 SHA-256、版本、来源和许可说明。未确认可公开复制的原文不得提交公开仓库。每题由人工标注必要证据、可接受答案要点和定位，跨段/无依据题需要复核。

## 评测解释

- 评测器计算的是协议内可确定的指标，不自动理解引用语义。
- Citation Precision 需结合人工核验；Groundedness 明确由人工审阅字段计算。
- Agent 规则只检查适配器实际记录的事件；未记录不等于没有发生。
- 当前无预设 pass threshold。数据和基线跑出后再讨论阈值。
