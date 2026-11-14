# Local Repository Contract

Issue #26 的 Repository 边界与事务契约。当前不绑定 IndexedDB 或 SQLite 实现；具体适配器需依据 Issue #1 的验证结论实现。

## 契约范围

- 私人阅读数据以本地数据集为权威；所有读写必须显式携带 datasetId/dataSetId 或由事务上下文绑定数据集。
- 同一数据集、同一不可变 BookRevision 只允许一条长期 Thread。
- Message 采用追加写；同一 Thread 的 sequence 由 Repository 在事务内原子分配，并由唯一约束保证。
- 用户消息写入接口只在数据库事务成功提交后 resolve；失败必须 reject，不得返回“已保存”。
- Agent 请求只能在本地消息保存 Promise resolve 后启动；事务回调不得发起网络或模型调用。
- ReadingRound、Citation、Note、MemoryVersion 与来源关系在同一事务边界内维护。
- 认知版本追加，不覆盖旧版本。
- 账号关联撤销采用软删除：只撤销指定绑定及其派生索引/授权信息，不删除数据集和其他私人数据。
- schema 迁移失败、写锁不可用、配额不足或完整性检查失败时，不得静默切换第二个可写主库。

## 当前实现状态

已交付 Repository 接口、事务边界、错误码、数据集备份序号不变量和 Agent UserMessageRepository 结构适配器。尚未交付真实持久化适配器、迁移、并发锁、数据集隔离的数据库级约束和浏览器端恢复。

## 运行测试

要求 Node.js 22：

```bash
cd packages/local-repository-contract
npm test
```

## 边界

该包是契约层，不是生产 Repository。内存 Mock 或契约测试不能作为浏览器持久化、SQLite OPFS/IndexedDB 可靠性或数据恢复通过的证据。
