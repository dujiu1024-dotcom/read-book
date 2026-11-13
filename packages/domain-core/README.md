# Domain Core

知行领域规则内核的第一批正式代码。该包保持纯函数与零运行时依赖，不绑定 UI 框架、数据库、网络或模型供应商。

## 当前包含

- 数据集内按 BookRevision 唯一长期 Thread 的约束检查
- 主线位置与临时查看/复习/引用视图分离
- 仅允许显式推进主线；未讨论单元需要显式略读确认
- 用户消息草稿与已持久化消息分离；由存储适配器提交成功后，编排层才能启动 Agent 请求
- Agent 消息生成状态的完成、失败、取消转换
- 认知记忆追加式版本链，保留前序版本和来源引用

## 运行测试

要求 Node.js 22，在仓库根目录执行：

```bash
cd packages/domain-core
npm test
```

## 边界

这里定义的是领域规则，不提供真实持久化、浏览器存储、API、Agent 推理或加密能力。`createUserMessage` 只创建待持久化草稿，不代表数据已写入。调用方必须先由存储适配器成功提交并取得已保存消息，再启动 Agent 请求。下一步必须等待本地数据库 PoC（Issue #1）给出选型，再实现存储适配器。


## Memory candidate evaluation

`evaluateMemoryCandidate(candidate, policy)` is a deterministic, explainable gate for the first stage of Issue #28.

- It keeps `user`, `author` and `assistant_inference` viewpoints explicit.
- It evaluates novelty, stability, explanatory power, discussion depth and relation strength independently; discussion frequency alone cannot qualify a memory.
- It requires traceable source message IDs and checks confidence and ambiguity separately from cognitive value.
- It returns `accept`, `needs_confirmation` or `reject` with machine-readable reason codes and the weighted score.
- Thresholds and weights are supplied by the caller. This package deliberately defines no universal production threshold before real-book evaluation and product review.

This is a pure rule module. It does not call an LLM, persist candidates, or claim that an accepted candidate is already a committed MemoryVersion.
