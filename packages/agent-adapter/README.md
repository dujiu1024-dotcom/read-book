# Agent Adapter Contract

Issue #27 的第一阶段协议适配边界。此包不绑定模型供应商、HTTP 库、SSE 实现或 UI 框架。

## 当前能力

- 对齐 `docs/api-contract.yaml` 的 GenerationRequest、GenerationAccepted 和 GenerationStatus。
- 统一创建、查询、取消和事件流传输接口。
- 校验请求上下文边界，限制最近消息和相关认知数量。
- 对 SSE 事件序号做连续性检查，允许断线重连后的重复事件幂等忽略。
- 流式事件只作为临时展示；只有 GET 返回 completed 且包含结果时，才产生权威最终结果。
- `persistUserMessageBeforeGeneration` 强制先等待本地消息事务提交，再调用生成服务；持久化失败时不会发起网络请求。

## 运行测试

要求 Node.js 22：

```bash
cd packages/agent-adapter
npm test
```

## 边界

当前只有协议、校验和编排边界，没有生产 HTTP/SSE 传输实现、数据库 Repository、真实模型服务或 UI 接入。传输实现必须注入 `GenerationTransport`，本地 Repository 必须注入 `UserMessageRepository`。不得把 Mock 测试结果描述为真实 Agent 质量或生产可靠性。
