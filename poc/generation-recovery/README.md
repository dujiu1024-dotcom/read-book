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

- 用户消息先写入 IndexedDB，再发起 POST 请求；任务创建失败后保留本地待重试任务，刷新后仍可使用原 Idempotency-Key 重试，不重复插入用户消息。
- 使用 Idempotency-Key 创建 generation_id；重复提交相同正文复用原任务，同一幂等键提交不同正文返回 409；服务端持久化正文 SHA-256 摘要，不在日志中输出正文。
- Mock Server 任务独立于浏览器 SSE 连接。
- SSE 事件带 event_id、sequence、generation_id；支持按 after 序号重放事件。
- GET generation 返回状态与最终结果；客户端刷新后根据本地 job 重新查询/订阅。
- 流式 delta 只用于临时展示；只有 GET 最终状态为 completed 且包含 final_result 时，才写入本地 Assistant Message。
- 取消请求形成 cancelled 终态；取消后不创建 Assistant Message。\n- SSE 使用 no-cache/no-transform 与 X-Accel-Buffering: no，支持可配置心跳并在 Response close 时清理订阅。\n- 任务及最终结果具有可配置 TTL；过期后停止生成、清除最终结果并进入 expired 终态。\n- 服务端结构化审计只记录 generation_id、事件类型、序号和请求摘要，不记录消息正文、访问令牌或幂等键。
- 服务端任务状态、幂等键映射、事件序列和最终结果写入原子替换的本地 JSON 状态文件；进程重启后恢复任务并从已持久化的增量位置继续模拟生成。
- 状态文件默认位于当前工作目录的 `.poc-generation-state.json`，可通过 `GENERATION_STATE_FILE` 指定路径；文件权限设置为仅当前用户可读写。服务端只持久化请求正文 SHA-256，不保存用户消息明文；消息正文只在客户端 IndexedDB 保存。
- 监听端口可通过 `PORT` 配置。默认 4177。

## 新增进程重启验证

Playwright 会为每个子进程测试分配独立临时端口与状态文件，并可配置模拟 token 延迟，避免端口碰撞和取消竞态测试受调度时序影响。测试会启动独立 Mock Server 子进程：
1. 创建任务并等待至少两个事件持久化；
2. 终止服务进程；
3. 使用相同状态文件重启服务；
4. 验证原 generation_id 和幂等键映射仍有效；
5. 验证任务继续执行至唯一最终结果；
6. 从指定序号重放事件，检查序号连续。

可通过环境变量配置 `GENERATION_HEARTBEAT_MS`（默认 15000）、`GENERATION_TASK_TTL_MS`（默认 24 小时）和 `GENERATION_TOKEN_DELAY_MS`（模拟生成延迟）。\n\n## 已知限制

- 本地 JSON 状态文件只用于单进程 PoC，不是生产级持久化队列；没有多实例并发协调、文件锁、WAL、数据库事务和备份恢复。
- 进程强制终止时，最后一个尚未完成原子替换的事件可能尚未持久化；验收只承诺已确认写入状态文件的事件。
- 生成过程由固定 token 模拟，不调用真实模型。
- 已增加幂等键与请求正文绑定、事件 ID 唯一性/序号连续性/断点回放、接近自然完成时取消竞态测试。仍未覆盖服务端主动重复/乱序注入、代理缓冲、心跳超时、任务 TTL、服务端日志自动审计和高并发压力测试。
- 用户消息已持久化；任务创建请求失败后的 UI 重试入口已实现，刷新后复用原幂等键。
- 该 PoC 不等于正式 Generation API，也不代表所有故障场景通过。
