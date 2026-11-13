# PoC A：PC Web 本地数据存储与浏览器可靠性

本目录是完全独立的技术验证工程，不属于知行正式业务代码，不连接正式账号、用户数据或服务端 API。

## 环境与固定版本

- Node.js：22.12.0 或更高的 22.x/兼容 LTS。
- SQLite WASM：`@sqlite.org/sqlite-wasm@3.54.1-build1`。
- Playwright：`@playwright/test@1.65.0`。
- Vite：`7.2.2`。
- 浏览器主测：Chromium（Chrome/Edge 需分别记录实际版本）；Firefox/WebKit 仅做兼容探测，不等同于 Safari/Edge 实际产品浏览器验收。

## 启动

```bash
cd poc/local-storage
npm install
npx playwright install chromium firefox webkit
npm run dev
```

打开终端显示的本地地址。SQLite OPFS 必须在 Worker 中运行；Vite 已配置 COOP/COEP 响应头。不要通过 file:// 打开页面。

## 自动化测试

```bash
npm test
npm run build
```

测试覆盖基础 IndexedDB 写入、查询、刷新后重开，以及 Chromium 下 SQLite OPFS 的启动/明确失败行为。浏览器测试需要安装对应 Playwright 浏览器。

## 当前实现范围与限制

- 两种存储方案现使用相同的六实体最小领域关系：Thread、Message、ReadingRound、Note、Memory、Source；测试夹具建立 Thread→ReadingRound→Note→Memory 与 Note→Source 关系，Message 归属 Thread。
- IndexedDB 使用六个 Object Store、datasetId 索引、thread/sequence 唯一索引，以及 readingRoundId/noteId 等关系索引。
- SQLite 使用独立 Worker、OPFS VFS、六张关系表、外键、CHECK、唯一约束及关系索引。
- 性能界面支持 1k、10k、100k 消息；每次规模执行 5 轮，分别记录写入、数据集查询和跨 Thread、ReadingRound、Note、Memory、Source 关系查询的 P50/P95 与原始样本。IndexedDB 使用 datasetId 与复合索引；SQLite 使用多表 JOIN。内存字段仅在浏览器暴露 performance.memory 时提供，存储体积由 Storage Estimate 观测。
- IndexedDB 和 SQLite 分别使用不同数据库，测试运行时一次只选择一个写入；两者不是同一数据集的双写主库。
- OPFS 不可用时 SQLite 方案明确失败，不降级为内存数据库。
- `persist()` 是浏览器申请，不代表永久存储；申请结果和配额仅作为观测数据。
- 已将 Web Locks 单写者协调接入 IndexedDB 与 SQLite OPFS 基准写入口：无法获得写锁的标签页会在执行写入前失败并提示只读降级；释放后可由另一标签页获得写锁。BroadcastChannel 广播锁状态。浏览器不支持 Web Locks 时会显式在结果中标注 `unsupported`，不能据此宣称多标签页写安全。

## 测试结果状态

| 验收项 | 状态 | 说明 |
|---|---|---|
| 工程独立运行 | 待本地执行 | 尚未生成 lockfile |
| IndexedDB 1k/10k/100k | 100k 自动化通过 | Run 43424902738：Chromium 100k、5 轮写入/查询与 Thread 关联查询通过（1.9 分钟）；指标原始数据将在下一轮 CI 日志输出 |
| SQLite OPFS 1k/10k/100k | CI 环境未具备 VFS | Run 43424902738：Worker 中 `sqlite3.opfs` 不可用；不能标记通过，新增实际 VFS 探测并跳过机制，需在支持 OPFS 的 Chrome/Edge 环境单独实测 |
| Chrome 与 Edge 实测 | 未执行 | Playwright Chromium 不等于两个正式浏览器版本验收 |
| 六实体关系与关联查询 | 已实现，待新 CI | 两种适配器均建立六实体关系；IndexedDB 关系索引与 SQLite 多表 JOIN 已接入性能基准 |
| 多标签页单写者与锁交接 | CI 通过 | Run 43424902738：Chromium 跨标签页竞争、阻止第二标签页写入、释放后交接并成功写入通过 |
| Worker 崩溃/页面关闭恢复 | 未执行 | 需故障注入 |
| 配额不足与 persist 拒绝 | 未执行 | 需模拟与真实浏览器测试 |
| 迁移与批量一致性快照 | 未实现 | 后续迭代 |
| P50/P95、内存、存储体积 | 已加入采集 | 尚未在目标 Chrome/Edge 环境完成实测与报告 |

## 两实体模型历史基线（Run 43425500315；不代表当前六实体模型）

测试环境：GitHub Actions Linux headless Chromium；100,000 条消息；5 轮写入/查询；Web Locks 单写者协调已启用。数值为本次运行观测值，不代表 Chrome/Edge 桌面稳定版。

| 指标 | P50 | P95 |
|---|---:|---:|
| IndexedDB 批量写入 | 5,356 ms | 5,853 ms |
| IndexedDB 数据集查询（getAll） | 2,550 ms | 3,640 ms |
| IndexedDB Thread 关联查询 | 271 ms | 296 ms |

- JS Heap：约 103 MB（运行结束时 performance.memory.usedJSHeapSize）。
- Storage Estimate：usage 约 112.9 MB；quota 约 10.85 GB；usageDetails.indexedDB 约 112.9 MB。
- persisted() 返回 false，persist() 请求返回 false：当前 CI 环境未授予持久化存储权限；这不影响 IndexedDB 本次读写测试，但意味着不能声称已取得持久化保护。
- SQLite OPFS 100k：本次 CI Worker 未暴露 OPFS VFS，测试明确跳过；没有 SQLite 性能数据。

## 已知技术前提

SQLite 官方 WASM npm 包说明：OPFS 后端只能在 Worker 中使用；示例部署需要 COOP: same-origin 与 COEP: require-corp。Node 环境只支持内存数据库，不能代替浏览器 OPFS 实测。

## 下一步

1. 生成 lockfile 并在 Chromium/Chrome/Edge 实际环境执行 1k/10k/100k。
2. 补充完整领域 Schema、关联查询、迁移、批量快照和多轮统计。
3. 增加 Worker 强杀、页面强制关闭和锁持有者异常退出故障测试；当前 Web Locks 已接入两种 PoC 写入口。
4. 增加崩溃、刷新、关闭、配额、persist 拒绝、多标签页和损坏恢复故障注入。
5. 汇总实测数据后再形成存储选型结论；未完成前不放行正式数据库选型。
