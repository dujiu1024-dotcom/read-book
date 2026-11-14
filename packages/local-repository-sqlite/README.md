# SQLite OPFS Local Repository Adapter

Issue #26 的第一阶段 SQLite WASM + OPFS Repository 适配器实现，基于 ADR-0001 的有条件技术方向。

## 当前实现

- SQLite WASM 在专用 Worker 内初始化 OPFS VFS；不支持 OPFS 时明确失败，不降级到内存数据库。
- 一个 Repository 事务绑定一个 datasetId，并通过 Web Locks 获取数据集独占写锁；不支持锁或未取得锁时 fail-closed。 快照恢复同样使用该数据集写锁，避免绕过事务锁与其他标签页并发写入。
- `LocalRepository` 接口适配：Thread、Message、ReadingRound、ReadingPosition、Citation、Note、MemoryVersion、账号绑定软撤销与一致性快照。
- 同一数据集同一 BookRevision 的 Thread 唯一约束。
- Message sequence 在 `BEGIN IMMEDIATE` 事务内分配，数据库唯一约束兜底；用户消息写入仅在事务提交后 resolve。
- 每次有写入的事务提交后递增 dataset dirtySequence。
- 账号绑定撤销只清空该绑定的账号关联和授权记录，不删除数据集及其他私人数据。
- Note 写入校验数据集归属、Thread 与 ReadingRound 一致性、来源消息/原文归属及 revision 单调递增；冲突 ID 不得跨数据集或 Thread 覆盖。

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
- Schema v1→v2 迁移已实现：新增 MemoryRelation 表和双向索引，原有数据集 schema_version 升级至 2；迁移在独立事务中执行，失败回滚，高版本数据库拒绝降级写入。
- MemoryRelation 写入验证两端版本、同数据集/Thread 来源消息、fromVersion 来源交集和原文定位；支持按版本查询并进入一致性快照。
- SQLite Worker 将 `SQLITE_FULL`/配额错误映射为 `QUOTA_EXCEEDED`，将数据库损坏信号映射为 `INTEGRITY_FAILED`，迁移失败映射为 `MIGRATION_FAILED`；调用方可按 RepositoryError.code 区分恢复策略。
- 每次打开数据库并完成 Schema 迁移后，先执行 `PRAGMA quick_check` 与 `PRAGMA foreign_key_check`；任一检查异常即以 `INTEGRITY_FAILED` fail-closed，不自动删除、重建或覆盖数据库。
- 启动时 SQLite 逻辑完整性检查已接入；文件级物理损坏的隔离、用户确认后的恢复/重新导入流程仍未完成。配额压力、备份快照与 #2 端侧加密备份链路集成尚未完成。
- 需要 package-lock.json 和 `npm ci` 可重复安装。
- 当前 Playwright 只覆盖 Chromium OPFS 自动化环境；不外推到所有浏览器/操作系统。
- 还需补充完整 Repository contract suite：Citation/Note/MemoryVersion/MemoryRelation 来源完整性、配额失败、文件损坏边界和 #2 备份快照集成。
