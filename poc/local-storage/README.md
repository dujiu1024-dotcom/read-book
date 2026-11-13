# PoC A：本地存储与浏览器可靠性

本目录是独立技术验证，不是 read-book 正式业务实现，也不代表已完成生产级选型。

## 目标与数据模型

对 IndexedDB 与 SQLite WASM + OPFS 两条路线使用相同的六实体模型和固定测试数据：

- Thread：阅读对话线程
- Message：用户与 Agent 消息
- ReadingRound：一次阅读轮次
- Note：阅读笔记
- Memory：认知记忆
- Source：书籍/原文来源

关系：Thread→ReadingRound→Note→Memory，Note→Source，Message→Thread。

IndexedDB schema 当前版本为 v4：
- Message：datasetId 索引、threadId+sequence 唯一复合索引。
- ReadingRound：datasetId 索引、threadId+sequence 唯一复合索引；同一 Thread 可有多个不同序号轮次，不允许重复序号。
- Note、Memory：分别约束 ReadingRound、Note 的唯一归属。
- v1 与 v3 数据库升级至 v4 的迁移探针验证旧 Thread/Message 数据保留、索引修正和唯一约束语义。

SQLite 使用六张关系表、外键、CHECK、唯一约束和多表 JOIN。OPFS 文件使用独立的 v2 文件名，避免旧两实体 PoC 数据库结构冲突。

## 运行方式

在本目录执行：

```bash
npm install
npm run dev
npm run build
npm test
```

CI 安装 Playwright Chromium、Firefox、WebKit，以及 Google Chrome Stable、Microsoft Edge Stable。测试服务器通过 localhost 提供 COOP/COEP 响应头，以满足 Worker 与 OPFS 环境要求。

## 写入协调与失败策略

- Web Locks 对同一 dataset 提供单写者协调。
- BroadcastChannel 广播标签页状态。
- 无 Web Locks 时写入 fail-closed：拒绝写入并保持只读，不退化为无锁写入。
- IndexedDB 的整批数据集替换在同一个 readwrite transaction 内完成；事务中止时保留上一次已提交数据。
- SQLite 使用独立 Worker、OPFS VFS 与 BEGIN IMMEDIATE 事务。
- OPFS VFS 不可用时明确报错，不降级到内存 SQLite，避免产生第二份数据源。
- Worker 终止后重新初始化，验证 OPFS 数据仍可读取。

## 自动化覆盖范围

最新完整 CI：Run 43436771533。

- 95 项测试：55 passed、40 skipped、0 failed。
- IndexedDB：1k、10k、100k 数据规模；每种规模五轮写入/查询，输出 P50/P95、JS Heap 和浏览器存储占用。
- SQLite OPFS：1k、10k、100k 数据规模；每种规模五轮写入/查询，输出 P50/P95、JS Heap 和浏览器存储占用。
- Chrome Stable、Edge Stable、Playwright Chromium、Firefox、WebKit 的 IndexedDB 基础恢复、迁移、事务回滚与 fail-closed 检查。
- Chrome Stable、Edge Stable 与 Chromium 的 SQLite OPFS 基础恢复、完整性、唯一约束和多标签页串行打开。
- 浏览器进程完全关闭后重新打开的持久化配置目录测试在 Playwright Chromium 中验证 IndexedDB 与 SQLite OPFS 数据恢复。
- 配额不足：通过 Chromium CDP 降低 origin quota，验证替换事务失败且旧数据仍完整。
- persist() 被拒绝、站点数据清理、长文本往返、重复唯一键拒绝、缺失关联记录检测。
- v1/v3→v4 IndexedDB schema migration。
- 多标签页单写者、只读降级与锁交接。

40 项 skipped 是按项目设计的能力/主测范围跳过：例如 100k 性能基准只在 Playwright Chromium 执行，Chromium CDP 配额注入不在 Firefox/WebKit 执行，浏览器进程重启只在 Playwright Chromium 执行；SQLite OPFS 不支持的浏览器不执行 SQLite 写入测试。Skipped 不计为通过。

## 性能结果

测试环境：GitHub Actions Linux headless，Run 43436771533。每项基准五轮。时长为毫秒，JS Heap 与存储占用为 MB（十进制近似值）。

| 适配器 / 数据量 | 写入 P50 / P95 | 数据集查询 P50 / P95 | 关联查询 P50 / P95 | JS Heap 已用 | Origin 存储占用 |
|---|---:|---:|---:|---:|---:|
| IndexedDB / 1k | 249 / 345 ms | 31 / 52 ms | 5.45 / 10 ms | 10 MB | 1.25 MB |
| IndexedDB / 10k | 2.39 / 2.82 s | 250 / 300 ms | 28 / 86 ms | 27.6 MB | 11.48 MB |
| IndexedDB / 100k | 15.73 / 20.47 s | 2.14 / 2.85 s | 238 / 339 ms | 103 MB | 113.84 MB |
| SQLite OPFS / 1k | 211 / 222 ms | 0.94 / 1.28 ms | 0.95 / 1.05 ms | 10 MB | 1.22 MB |
| SQLite OPFS / 10k | 1.47 / 1.61 s | 1.49 / 1.96 ms | 1.55 / 1.71 ms | 10 MB | 7.73 MB |
| SQLite OPFS / 100k | 18.69 / 19.11 s | 89 / 93 ms | 744 / 773 ms | 10 MB | 73.06 MB |

Origin 存储占用取自 `navigator.storage.estimate().usage`；IndexedDB 对应 usageDetails.indexedDB，SQLite OPFS 对应 usageDetails.fileSystem。JS Heap 取自 Chromium 的 `performance.memory.usedJSHeapSize`，不是浏览器进程总内存。CI 中六组样本的 persisted() 与 persist() 均为 false。

这些指标是 PoC 固定夹具的测量值，不构成存储选型结论。数据集查询和关联查询的实现形态不同；真实产品负载、设备性能、OPFS/IndexedDB 配额策略及桌面浏览器差异都可能改变结果。SQLite 的数据集查询更快，但 100k Thread 关联查询仍慢于 IndexedDB；写入性能也随运行环境变化。不能仅凭这一组 headless CI 数据定型。

## 已知限制与未完成验收

- 当前没有 package-lock.json，依赖安装尚未达到 lockfile 级可重复性；顶层依赖已精确固定版本，但传递依赖仍由 npm 解析。
- Chrome/Edge Stable 是 GitHub Actions Linux 环境安装的正式浏览器渠道，不等于用户实体设备；仍需真实桌面设备样本。
- 当前是独立 PoC，尚未接入 read-book 正式数据写入路径、阅读器和备份流程。
- 已验证逻辑关联缺失的检测，不等于完成 SQLite 文件级物理损坏检测与修复。
- 发现损坏时不静默清空或自动重建；生产恢复应由加密备份链路负责恢复，属于 PoC B（Issue #2）的后续验收。
- CI 未获得持久化存储授权，不能据此承诺浏览器数据永不被系统清理。
- 超大书籍导入、长期运行压力、真实设备断电/强制杀进程等仍需单独验证。

## 真实桌面设备验收（尚未执行）

CI 浏览器不能替代实体设备。本 PoC 不得仅凭 CI 结果做最终选型。至少收集以下设备样本；样本不足时保留两条路线，不做定型：

| 样本 | 操作系统/版本 | 浏览器/版本 | 设备/内存 | 必测项 |
|---|---|---|---|---|
| 设备 A | 待填 | Chrome Stable | 待填 | 刷新、浏览器完全退出重开、1k/10k、双标签页 |
| 设备 B | 待填 | Edge Stable | 待填 | 刷新、浏览器完全退出重开、1k/10k、双标签页 |
| 设备 C（可选） | 待填 | Safari 或其他目标浏览器 | 待填 | IndexedDB 基础恢复、能力检测 |

每次样本记录：
- OS、浏览器完整版本、CPU/内存、设备类型、是否无痕模式。
- 每轮写入、数据集查询、关联查询的原始耗时；至少五轮，分别记录 P50/P95。
- `navigator.storage.estimate()` 的 quota/usage/usageDetails、`persisted()` 与 `persist()` 结果。
- 刷新、完整退出浏览器进程后重开、两个标签页同时打开同一数据集的结果。
- 错误名称、错误消息、控制台异常；失败样本不得从报告中剔除。

注意：不要在真实用户数据上做故障注入或清理站点数据。配额不足、站点数据清理等破坏性测试仅使用独立测试数据集和测试浏览器配置文件。

## 当前结论

两条存储路线均已完成六实体模型、1k/10k/100k 自动化基准和核心可靠性测试。尚不做最终选型，不关闭 Issue #1；先保留两条独立路线，等待 lockfile、真实设备样本和生产恢复链路验证。
