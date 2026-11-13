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

- 两种存储方案使用相同的最小领域关系：Thread、Message；预留 ReadingRound、Note、Memory、Source 扩展位置。
- IndexedDB 使用 datasetId 索引和 thread/sequence 唯一索引。
- SQLite 使用独立 Worker、OPFS VFS、外键、CHECK、唯一约束及 dataset 索引。
- 性能界面支持 1k、10k、100k 消息；每次规模执行 5 轮，分别记录写入、数据集查询和按 Thread 关联查询的 P50/P95 与原始样本。IndexedDB 使用 datasetId 与 threadSequence 索引；SQLite 使用 Thread-Message JOIN。内存字段仅在浏览器暴露 performance.memory 时提供，存储体积由 Storage Estimate 观测。
- IndexedDB 和 SQLite 分别使用不同数据库，测试运行时一次只选择一个写入；两者不是同一数据集的双写主库。
- OPFS 不可用时 SQLite 方案明确失败，不降级为内存数据库。
- `persist()` 是浏览器申请，不代表永久存储；申请结果和配额仅作为观测数据。
- 已增加 Web Locks 单写者协调器与 BroadcastChannel 状态广播：无法获得写锁的标签页进入只读模式，释放后允许锁交接；该协调器目前为独立 PoC 组件，尚未接入 IndexedDB/SQLite 的正式写入口。

## 测试结果状态

| 验收项 | 状态 | 说明 |
|---|---|---|
| 工程独立运行 | 待本地执行 | 尚未生成 lockfile |
| IndexedDB 1k/10k/100k | 待实测 | 自动化先覆盖 1k；手工界面支持三种规模、5 轮 P50/P95 |
| SQLite OPFS 1k/10k/100k | 待实测 | 自动化先覆盖 1k；手工界面支持三种规模、5 轮 P50/P95 |
| Chrome 与 Edge 实测 | 未执行 | Playwright Chromium 不等于两个正式浏览器版本验收 |
| 复杂关系查询与唯一约束 | 部分实现 | SQLite 约束已定义，需补充负向用例 |
| 多标签页单写者与锁交接 | PoC 组件已实现 | 新增跨标签页锁竞争/只读降级/锁交接测试，等待 CI；尚未接入正式写入口 |
| Worker 崩溃/页面关闭恢复 | 未执行 | 需故障注入 |
| 配额不足与 persist 拒绝 | 未执行 | 需模拟与真实浏览器测试 |
| 迁移与批量一致性快照 | 未实现 | 后续迭代 |
| P50/P95、内存、存储体积 | 已加入采集 | 尚未在目标 Chrome/Edge 环境完成实测与报告 |

## 已知技术前提

SQLite 官方 WASM npm 包说明：OPFS 后端只能在 Worker 中使用；示例部署需要 COOP: same-origin 与 COEP: require-corp。Node 环境只支持内存数据库，不能代替浏览器 OPFS 实测。

## 下一步

1. 生成 lockfile 并在 Chromium/Chrome/Edge 实际环境执行 1k/10k/100k。
2. 补充完整领域 Schema、关联查询、迁移、批量快照和多轮统计。
3. 将 Web Locks + BroadcastChannel 单写者策略接入两种存储适配器的真实写入口，并补充故障释放测试。
4. 增加崩溃、刷新、关闭、配额、persist 拒绝、多标签页和损坏恢复故障注入。
5. 汇总实测数据后再形成存储选型结论；未完成前不放行正式数据库选型。
