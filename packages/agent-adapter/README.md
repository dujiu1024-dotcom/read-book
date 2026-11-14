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


## HTTP/SSE Transport（PR #35）

- `createHttpGenerationTransport` 实现 OpenAPI 定义的创建、查询、取消和事件流端点。
- API base URL 与短期 Bearer Token 由宿主注入；不硬编码真实域名或凭据。
- SSE 通过带 Authorization 的 fetch + ReadableStream 解析，支持按最后已处理 sequence 使用 `after` 参数恢复。
- 校验 SSE 的 id/event 与 JSON payload 一致性，限制单事件大小；AbortSignal 取消流读取。
- API 错误保留 HTTP 状态、错误码、request_id 和 retryable。
- SSE 只用于临时增量展示；最终结果仍以 GET GenerationStatus 为准。
- 当前仅 Mock Fetch 契约测试，未连接真实服务端；网络重试策略由上层编排，Transport 不自动重试。
