# PoC D：生成任务、流式响应与断线恢复

独立 Mock Generation Server + 浏览器客户端，不依赖其他 PoC，不连接真实 LLM、账号或正式 API。

## 启动

```bash
cd poc/generation-recovery
npm install
npm run server
# 另开终端
npm run dev
```

## 自动化测试

```bash
npx playwright install chromium
npm test
npm run build
```

Playwright 配置会自动启动 Mock Server 与 Vite；本地手工运行时需分别启动。

## 已实现协议语义

- 用户消息先写入 IndexedDB，再发起 POST 请求。
- 使用 Idempotency-Key 创建 generation_id；重复提交复用原任务。
- Mock Server 独立运行，生成任务不依赖浏览器 SSE 连接。
- SSE 事件带 event_id、sequence、generation_id。
- GET generation 返回状态与最终结果；客户端刷新后根据本地 job 重新查询/订阅。
- 流式 delta 只用于临时展示；只有 GET 最终状态为 completed 且包含 final_result 时，才写入本地 Assistant Message。
- 取消请求在服务端形成 cancelled 终态；取消后不创建 Assistant Message。
- 服务端只在内存保存短暂任务数据，日志不打印消息正文。

## 已知限制

- Mock Server 使用内存状态；服务进程重启后任务丢失，尚未验证 Worker/进程重启后的任务持久化恢复。
- 生成过程由固定 token 模拟，不调用真实模型。
- SSE 事件目前是内存事件队列，没有 Redis/数据库等持久化队列。
- 尚未覆盖事件乱序/重复注入、代理缓冲、心跳超时、自然完成与取消的高并发竞态、任务 TTL 和服务端日志自动审计。
- 用户消息已持久化，但任务创建请求失败后的 UI 重试入口还需补充。
- 该 PoC 不等于正式 Generation API，也不代表所有故障场景通过。
