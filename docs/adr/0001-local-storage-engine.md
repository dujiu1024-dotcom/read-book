# ADR-0001：PC Web 私人数据主存储路线

- 状态：有条件采纳（实现前仍需完成依赖锁定与正式集成审查）
- 日期：2026-11-14
- 关联：Issue #1、Issue #26
- 范围：第一阶段 PC Web 单设备本地私人数据主存储

## 背景

知行的 Thread、Message、ReadingRound、Citation、Note、Memory 和 MemoryVersion 存在明确关系、唯一性、追加写和一致性快照要求。私人阅读数据以当前设备本地数据集为主存储；服务端不作为私人历史主库。

候选路线：
1. IndexedDB
2. SQLite WASM + OPFS，由专用 Worker 持有数据库连接

## 验证证据

GitHub Actions Linux headless 自动化环境，固定数据模型，1k / 10k / 100k Message，每个数据量五轮。时间为 P50 / P95，JS Heap 和 Origin 存储占用为近似 MB。

| 适配器 / 数据量 | 写入 | 数据集查询 | 关联查询 | JS Heap | Origin 存储 |
|---|---:|---:|---:|---:|---:|
| IndexedDB / 1k | 249 / 345 ms | 31 / 52 ms | 5.45 / 10 ms | 10 MB | 1.25 MB |
| IndexedDB / 10k | 2.39 / 2.82 s | 250 / 300 ms | 28 / 86 ms | 27.6 MB | 11.48 MB |
| IndexedDB / 100k | 15.73 / 20.47 s | 2.14 / 2.85 s | 238 / 339 ms | 103 MB | 113.84 MB |
| SQLite OPFS / 1k | 211 / 222 ms | 0.94 / 1.28 ms | 0.95 / 1.05 ms | 10 MB | 1.22 MB |
| SQLite OPFS / 10k | 1.47 / 1.61 s | 1.49 / 1.96 ms | 1.55 / 1.71 ms | 10 MB | 7.73 MB |
| SQLite OPFS / 100k | 18.69 / 19.11 s | 89 / 93 ms | 744 / 773 ms | 10 MB | 73.06 MB |

最新完整自动化运行：
- Run 43533658992：成功。
- Run 43533666028：成功。
- 覆盖 Playwright Chromium、Chrome Stable、Edge Stable、Firefox、WebKit；SQLite OPFS 只在支持环境执行。
- 测试总计 95 项，55 passed、40 skipped、0 failed（skipped 为按浏览器能力或主测范围跳过，不计为通过）。

## 决策

**有条件首选 SQLite WASM + OPFS，单写入 Worker。**

理由：
- 领域实体间关系、唯一性、外键和多表事务是核心数据正确性要求；SQLite 原生关系约束更贴合数据模型。
- 100k 固定负载下，SQLite 数据集查询 P50/P95 为 89/93 ms，IndexedDB 为 2.14/2.85 s。
- 100k 样本的 Origin 存储占用：SQLite 约 73.06 MB，IndexedDB 约 113.84 MB。
- SQL 事务、Schema migration 和一致性快照更容易表达与审查。

## 重要权衡

本次数据并不证明 SQLite 在所有操作上更快：
- 100k 写入：SQLite 18.69/19.11 s，慢于 IndexedDB 的 15.73/20.47 s（P50 较慢，P95 接近）。
- 100k 关联查询：SQLite 744/773 ms，慢于 IndexedDB 的 238/339 ms。当前查询形态与索引需要在真实 Repository 查询中重新设计和验证。
- 数据集查询和关联查询是固定 PoC 查询，不等于完整产品工作负载。
- 测试运行于 Linux headless，不外推到所有操作系统和设备组合。

因此，本 ADR 选择 SQLite 的主要依据是关系一致性、事务、迁移和数据集查询/存储表现，而不是“所有性能指标领先”。

## 实施约束

1. 一个 dataset 同时只能有一个活动写入者；数据库连接由专用 Worker 持有。
2. 使用 Web Locks 做 dataset 级互斥；锁不可用或未获得锁时 fail-closed，进入只读/阻止写入状态。
3. OPFS VFS 不可用时明确报错，不静默退化到内存 SQLite 或另一份可写 IndexedDB 主库。
4. 不允许 SQLite 与 IndexedDB 同时成为可写主库。
5. 只有当 SQLite OPFS 在目标浏览器矩阵中无法满足可靠性/部署要求时，才通过新的 ADR 审查 IndexedDB 替代路线。
6. 用户消息必须先在本地事务提交，Repository Promise resolve 后才允许启动 Agent 网络请求。
7. 数据集清除按软删除语义撤销指定绑定和派生授权索引，不物理删除无关私人数据。
8. 浏览器存储不是永久存储。当前 CI 的 persisted() / persist() 均未获授权，必须向用户说明站点数据清理风险，并由独立备份链路保护。

## 浏览器支持范围

- 第一阶段主测目标：当前稳定版 Chrome、Edge 桌面浏览器自动化环境。
- Firefox、Safari 仅在能力与对应自动化测试通过后纳入正式支持矩阵。
- 不安排实体手机、平板或其他真机采样；本决策仅对已记录的自动化环境和目标浏览器范围负责。

## 未完成事项 / 放行条件

- [ ] 为 PoC 和正式适配器补齐 package-lock.json，使用 npm ci 验证可重复安装。
- [ ] 复核 100k 关联查询的 SQL 与索引设计，形成真实 Repository 查询基准。
- [ ] 完成正式 SQLite Worker / Repository 适配器、迁移、锁协调、配额失败和刷新/关闭重开测试。
- [ ] 与 #2 加密备份恢复链路定义一致性快照和损坏恢复边界。
- [ ] 正式集成前完成安全审查；PoC 结果不能替代生产验收。

## 结果

本 ADR 给出有条件的实现方向，允许 #26 开始 SQLite Repository 适配器的工程化实现，但不关闭 #1，也不宣称生产数据库已交付。上述放行条件完成后再更新 ADR 状态。
