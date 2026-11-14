# SQLite OPFS Local Repository Adapter

Issue #26 的第一阶段 SQLite WASM + OPFS Repository 适配器实现，基于 ADR-0001 的有条件技术方向。

## 当前实现

- SQLite WASM 在专用 Worker 内初始化 OPFS VFS；不支持 OPFS 时明确失败，不降级到内存数据库。
- 一个 Repository 事务绑定一个 datasetId，并通过 Web Locks 获取数据集独占写锁；不支持锁或未取得锁时 fail-closed。
- `LocalRepository` 接口适配：Thread、Message、ReadingRound、ReadingPosition、PresentedSource、ReadingUnitProgress、Citation、Note、MemoryVersion/Relation/Candidate、GenerationDelivery、账号绑定软撤销与一致性快照。
- 同一数据集同一 BookRevision 的 Thread 唯一约束。
- Message sequence 在 `BEGIN IMMEDIATE` 事务内分配，数据库唯一约束兜底；用户消息写入仅在事务提交后 resolve。
- 每次有写入的事务提交后递增 dataset dirtySequence。
- 账号绑定撤销只清空该绑定的账号关联和授权记录，不删除数据集及其他私人数据。

## 运行测试

要求 Node.js 22：

```bash
cd packages/local-repository-sqlite
npm install
npx playwright install chromium
npm run build
npm test
```

Vite 测试服务器设置 COOP/COEP 响应头，以便 Worker 使用 OPFS VFS。

## 未完成 / 边界

- 当前仍是第一阶段适配器，不是最终生产存储放行。
- Schema v1→v6 迁移已实现：依次增加 MemoryRelation、GenerationDelivery、MemoryCandidate、PresentedSource 和 ReadingUnitProgress 等结构；每个版本迁移在独立 SQLite 事务中执行，失败回滚，高版本数据库拒绝降级写入。
- MemoryRelation 写入验证两端版本、同数据集/Thread 来源消息、fromVersion 来源交集和原文定位；支持按版本查询并进入一致性快照。
- SQLite Worker 将 `SQLITE_FULL`/配额错误映射为 `QUOTA_EXCEEDED`，将数据库损坏信号映射为 `INTEGRITY_FAILED`，迁移失败映射为 `MIGRATION_FAILED`；调用方可按 RepositoryError.code 区分恢复策略。
- 文件级物理损坏注入、真实配额压满和多浏览器/操作系统可靠性仍未完成最终验证。HTTP 加密备份客户端已与一致性快照、确认游标和空数据集恢复接入；正式服务端和生产安全评审仍未完成。
- 需要 package-lock.json 和 `npm ci` 可重复安装。
- 当前 Playwright 只覆盖 Chromium OPFS 自动化环境；不外推到所有浏览器/操作系统。
- Repository contract 已覆盖主要数据边界；本轮新增 ReadingRound/PresentedSource/ReadingUnitProgress 状态转换与快照样例。统一最终验收由用户执行，本轮不运行测试/CI。
