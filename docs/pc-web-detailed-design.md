# 知行第一阶段 PC Web 详细技术设计

> 状态：详细设计基线，待 PoC 验证。不是业务代码开发授权，也不代表浏览器能力已在本项目环境通过。
> 适用范围：第一阶段 PC 浏览器用户端与管理员工作台。若与早期小程序/Expo 路线冲突，以当前 PC Web 路线为准。

## 1. 目标与边界

### 1.1 目标
1. 用户通过 PC 浏览器使用知行，核心阅读界面采用居中窄屏、单列、纵向阅读布局。
2. 用户个人阅读数据以当前浏览器本地数据集为主存储；服务器只保存端侧加密备份，不承担私人阅读数据在线主库。
3. 离线可查看已缓存原文、历史对话、笔记和认知记录；AI 对话、跨章节智能检索和获取未缓存内容需要联网。
4. 应用每次启动时检查备份状态；仅当本地存在尚未备份的变更时上传增量或全量备份。
5. 恢复凭证独立于账号密码；账号注销不影响备份恢复；数据集清除采用已确认的软删除语义。
6. 用户端、管理员工作台、公共书籍知识库和私人数据边界清晰。

### 1.2 非目标
- 第一阶段不开发微信小程序或原生 App。
- 不做多设备实时同步、自动合并或冲突解决。
- 不把浏览器存储视为绝对可靠的永久存储；必须提示浏览器数据清理、设备损坏和未备份数据丢失风险。
- 不在本阶段实现完整业务功能、生产数据库迁移或正式服务端 API。
- 不让管理员查看用户私人 Thread、Message、Note、Memory。

## 2. 总体架构

### 2.1 逻辑分层

| 层 | 主要职责 | 数据权威性 |
|---|---|---|
| 用户 Web UI | 阅读、原文展示、讨论、书架、笔记、设置 | 不作为数据权威 |
| 本地应用服务 | Thread、Message、ReadingRound、Note、Memory 领域规则 | 调用本地数据库事务 |
| 本地数据引擎 | 持久化、索引、迁移、快照、数据集隔离 | 用户私人数据主副本 |
| 本地加密与备份代理 | 序列化、压缩、加密、分块上传、校验 | 本地生成备份密文 |
| 公共内容 API | Book、BookRevision、原文、公共知识库和访问权益 | 平台公共数据权威 |
| 对话生成 API | 接收单次请求上下文、创建生成任务、调用模型、返回结果 | 短暂计算状态，不是私人历史主库 |
| 备份 API | 保存密文、最小 manifest、下载授权和生命周期墓碑 | 只管理加密备份 |
| 管理员工作台 | 书籍上传、加工、质检、发布、任务监控 | 只管理公共内容 |

### 2.2 部署边界
- 用户 Web 与 API 必须通过 HTTPS 提供；Web Crypto API 等安全能力依赖安全上下文。
- 建议用户端、管理端使用不同子域名或至少独立路由、独立权限策略；管理端不共享用户端会话权限。
- 公共书籍文件与私人备份对象存储分桶或逻辑命名空间隔离。
- 私人备份对象存储只接受密文；服务端不得持有可解密用户备份的密钥。
- 模型服务调用所需请求内容属于临时处理数据，不是服务器私人历史主库；必须最小化、访问控制、日志脱敏、短 TTL，并审查模型供应商数据条款。

### 2.3 主数据流

**阅读与讨论**
1. UI 读取本地数据集和公共书籍元数据。
2. 用户消息先写入本地事务并提交。
3. 客户端组装当前请求所需的最小上下文：当前论述单元、用户本轮输入、必要引用、少量相关认知。
4. 在线时向生成 API 提交请求；服务端创建 GenerationJob 并独立运行模型任务。
5. 客户端接收流式增量；增量仅作为临时展示状态，不把不完整 token 当成正式消息。
6. 生成完成后客户端获取最终结果，写入本地 Assistant Message 事务。
7. 若断线或页面关闭，服务端任务继续执行；重新打开后按 generation_id 查询最终状态并写回本地。
8. 生成失败时保留用户消息，显示失败状态，允许按幂等规则重试。

**本地备份**
1. 应用启动时检查本地数据集。
2. 比较本地 dirty_sequence 与 last_acked_sequence。
3. 无变化则快速标记已备份，不上传。
4. 有变化且网络可用，创建一致性快照，序列化、压缩、加密、分块上传。
5. 服务端校验密文哈希和 manifest，成功后返回 backup_id。
6. 客户端更新 last_backup_id 与 last_acked_sequence。
7. 失败或离线则保留待备份状态，不阻断阅读；下一次启动或网络恢复后重试。

## 3. 本地存储技术方案

### 3.1 候选对比

| 维度 | IndexedDB | SQLite WASM + OPFS |
|---|---|---|
| 浏览器原生程度 | 原生 API，成熟度高 | SQLite WASM + OPFS Worker 组合 |
| 事务 | 原生事务，需遵守事务生命周期 | SQLite ACID 事务和约束 |
| 关系与约束 | 需应用层维护关系、索引和约束 | SQL、外键、唯一约束、索引 |
| 复杂查询 | 多对象仓库和游标，复杂查询需应用层拼装 | SQL 查询、聚合和全文扩展更自然 |
| 数据迁移 | object store/index 版本升级 | SQL migration，成熟工具链 |
| 大文本/批量处理 | 可存储，但查询与批处理组织复杂 | SQL 批量操作更自然 |
| 多标签页 | 浏览器负责事务协调，但需处理版本升级阻塞 | VFS 锁与 Worker 协调复杂，必须实测 |
| 加密 | 记录级 Web Crypto 封装需应用实现 | 应用层加密或定制构建；OPFS 本身不等于加密 |
| 可维护性 | 依赖封装库和应用层数据访问模式 | SQLite 生态强，但 WASM/Worker/VFS 增加复杂度 |

浏览器配额由浏览器实现决定；IndexedDB 与 OPFS 均受 origin 存储配额和清理策略约束。必须调用 estimate() 监测用量，并申请 persist()；申请成功与否都要按可被清理的风险设计。

### 3.2 当前技术建议（有条件，不是最终放行）

**首选 PoC：SQLite WASM + OPFS，单写入 Worker。**

理由：
- Thread、Message、ReadingRound、PresentedSource、Citation、Note、Memory 之间关系明确，存在唯一性、来源完整性和事务一致性要求。
- 备份需要对多个关联表生成同一时点的一致性快照；SQLite 事务和数据库级导出更容易表达。
- 复杂查询、认知演变关联、章节定位和本地全文检索更适合 SQL。
- SQLite 可通过 schema migration 和约束减少应用层数据不一致。

候选实现：
- 使用 SQLite 官方 WASM 构建。
- 数据库只允许一个专用 Worker 持有写连接；UI 通过消息 RPC 调用数据服务。
- 首轮比较官方 OPFS VFS 与 opfs-wl VFS；opfs-sahpool 仅作为性能对照，不作为默认方案，因为其多标签页连接限制更明显。
- 应用通过 Web Locks API 获取 dataset 级互斥锁，并用 BroadcastChannel 通知其他标签页当前数据库 owner。
- 所有数据库事务必须短小；不在事务中等待网络、模型响应或 UI 交互。
- 若当前浏览器不支持目标 VFS，不得静默降级到另一种存储后继续运行；应明确提示兼容性并进入只读/阻止写入的安全状态，避免出现两个数据副本。

**回退候选：IndexedDB。** 只有当 SQLite OPFS 在目标浏览器矩阵中无法满足稳定性、持久性或部署要求时，才以 IndexedDB 做正式方案。不能把 IndexedDB 和 SQLite 两套数据库同时作为可写主库。

### 3.3 浏览器支持基线
- 第一阶段主测：当前稳定版 Chrome、Edge 桌面端。
- Firefox、Safari：作为兼容性评估对象；只有 OPFS、Worker、Web Crypto、持久化申请、备份恢复全部通过后才纳入正式支持矩阵。
- SQLite 官方文档说明 OPFS 只能在 Worker 环境使用；不同 VFS 对多连接、锁、COOP/COEP 和浏览器版本有不同要求。Safari 版本差异尤其需要真实验证。
- 不能仅凭“浏览器支持 OPFS”就推断“指定 SQLite VFS 在该浏览器可靠”。

### 3.4 本地数据库结构与写入规则
本地数据库至少包括：
- LocalDataSet / LocalDataSetMeta
- AccountDataSetBinding
- ShelfEntry / EntitlementProof
- Thread / Message / GenerationReceipt
- PresentedSource / ReadingRound / ReadingRoundState
- Citation
- Note / NoteSource
- Memory / MemoryRelation / MemorySource
- BackupState / BackupJournal / BackupManifestCache
- AppSetting / MigrationLog

写入规则：
1. 每次用户动作对应明确的领域事务。
2. Message 采用追加写；重新生成产生新 Message，不覆盖旧回答。
3. sequence 在 Thread 事务内原子分配。
4. idempotency_key 唯一，防止重复提交。
5. Note 用户编辑与 AI 自动生成版本分离；AI 不覆盖用户编辑。
6. Memory 演变通过新记录和关系表表达，不覆盖旧观点。
7. 数据集切换必须先关闭当前连接，再切换显式选中的 dataset_id。
8. schema migration 失败时回滚并保留迁移前备份，不允许半迁移状态继续读写。

### 3.5 多标签页策略
第一阶段采用“一个数据集一个活动写入者”策略：
- 第一个打开的标签页获取 dataset lock 并成为 owner。
- 其他标签页通过 BroadcastChannel 接收 owner 状态；默认只读或提示该数据集已在另一个标签页打开。
- 需要接管时先请求 owner 释放锁；owner 无响应时执行受控恢复，不允许直接同时打开数据库。
- 页面关闭/崩溃后依赖浏览器释放锁；新 owner 必须先执行数据库完整性检查。
- 多标签页协同不是多设备同步。

## 4. 本地数据安全与密钥设计

### 4.1 威胁边界
- 浏览器同源隔离可限制其他网站直接访问数据，但不能防止本机恶意软件、已控制用户浏览器的脚本、XSS 或用户主动清理站点数据。
- OPFS/IndexedDB 不是加密存储。不能将“数据放在浏览器沙箱”描述成端到端加密。
- 必须分别说明本地数据库保护、备份密文保护、传输加密和模型处理隐私。

### 4.2 备份加密建议
- 使用浏览器 Web Crypto API。
- 为每个数据集生成随机 256-bit Backup DEK；不从账号密码直接生成 DEK。
- 使用独立恢复凭证派生/解包 KEK，用于包装 Backup DEK。恢复凭证与账号密码分离。
- 备份数据先序列化并压缩，再按固定最大块大小切分，逐块使用 AES-256-GCM 加密。
- 每块使用独立随机 96-bit nonce；同一密钥下不得重复使用 nonce。
- AAD 绑定 dataset_id、backup_id、backup_sequence、chunk_index、schema_version 和 cipher_suite，防止跨数据集/跨备份调包。
- manifest 保存算法套件、密钥版本、nonce、密文哈希、大小、块序号、父备份 ID 和 schema 版本；不包含书名、消息标题等明文私人内容。
- 服务端只验证密文完整性、哈希、大小和协议版本，不持有解密密钥。
- 恢复凭证格式、是否使用随机高熵密钥或用户口令、密钥轮换和 KDF 参数必须经安全评审与可用性测试后冻结。

### 4.3 本地数据库是否加密
这是与“服务器备份加密”不同的决策：
- 第一阶段至少保证备份在上传前端侧加密。
- 若本地数据库使用明文 SQLite，需明确依赖操作系统账户、浏览器配置文件权限和设备磁盘加密，不可声称应用级本地加密。
- 若要求应用级本地加密，应在 PoC 中单独比较 SQLCipher/WASM 或敏感字段加密方案，并测量查询、索引、迁移和恢复成本。
- 不应把浏览器 CryptoKey 的可持久化行为视为可靠硬件密钥库；恢复凭证仍必须由用户独立保存。

## 5. 备份协议

### 5.1 触发
- 每次应用启动时执行一次状态检查。
- 页面运行期间本地变更只更新 dirty_sequence，不立即为每条消息发起上传。
- 启动时若 dirty_sequence 大于 last_acked_sequence，且网络可用，触发备份。
- 若网络不可用，标记 pending；网络恢复后允许补做一次。
- 通过 dataset lock 与 backup job lock 保证单任务。
- 备份失败不回滚本地事务，不阻断阅读和编辑。

### 5.2 快照与增量
- 第一次备份必须是完整快照。
- 后续增量以已确认的父 backup_id 为基准，记录本次变更实体和删除墓碑。
- 增量必须验证父链连续；缺父版本、哈希错误或 schema 不兼容时停止增量恢复并请求完整快照。
- 定期创建新的完整检查点，避免恢复时无限回放增量；周期由备份体积和恢复耗时 PoC 决定。
- 不使用跨设备数据合并；恢复后该数据集进入当前设备本地运行，不自动建立双向同步。

### 5.3 上传状态机
queued → snapshotting → serializing → encrypting → uploading → verifying → committed

失败状态：
- retryable_failed：网络错误、超时、服务端暂时不可用；保留任务并退避重试。
- permanent_failed：协议不兼容、密文校验失败、数据集已清除、授权无效；停止自动重试并提示。
- cancelled：仅允许在未提交阶段取消；已提交备份不可由客户端撤销改写。

每个阶段记录 backup_job_id、dataset_id、parent_backup_id、dirty_sequence、重试次数和错误码；不得记录私人正文。

### 5.4 恢复流程
1. 新设备本地没有知行数据时提示是否恢复；用户可暂不恢复。
2. 用户提供独立恢复凭证。
3. 服务端验证恢复授权，检查数据集未被清除，签发短时下载授权。
4. 客户端下载密文到临时目录。
5. 校验 manifest、哈希、父链、版本和分块完整性。
6. 使用恢复凭证解包 DEK，解密并解压。
7. 在临时数据库中执行 schema migration 和完整性检查。
8. 用户确认恢复目标数据集；若当前设备已有其他数据集，必须明确选择，不自动覆盖或合并。
9. 导入成功后原子切换为活动数据集；失败时删除临时产物，原本地数据保持不变。
10. 恢复完成后是否将该数据集关联到当前账号并继续备份，必须由用户明确确认。

### 5.5 数据集清除
清除个人数据必须同时处理：
- 数据集状态墓碑（cleared）；
- 全部备份版本及增量父链的访问资格；
- 备份清单关联索引；
- 已签发下载票据和恢复票据；
- 预签名下载 URL 的可用性或有效期；
- 排队中的上传任务、分块上传会话和并发完成请求；
- 新的恢复授权、下载、检索、重新关联请求。

服务端保留原始密文和密钥材料不动。墓碑必须比普通索引具有更高的访问判定优先级，所有读写/签发接口统一检查。若上传与清除并发，清除墓碑优先；晚到的上传完成请求必须拒绝提交为可恢复备份。

## 6. 服务端 API 契约

> API 路径、方法、参数和请求/响应结构的唯一权威来源为 [OpenAPI 3.1 契约](api-contract.yaml)。本节只解释接口分组和实现约束，不独立定义接口。

### 6.1 公共书籍与权益
- `GET /v1/books`：查询已发布书目。
- `GET /v1/books/{book_id}/revisions`：查询书籍版本。
- `GET /v1/book-revisions/{revision_id}`：获取版本详情。
- `GET /v1/book-revisions/{revision_id}/structure`：获取作者原书结构与主线节点。
- `GET /v1/book-revisions/{revision_id}/nodes/{node_id}/content`：获取论述单元原文及定位。
- `POST /v1/book-revisions/{revision_id}/knowledge/search`：检索该版本公共知识库。
- `POST /v1/entitlements`、`POST /v1/entitlements/verify`：签发/校验具体 BookRevision 的访问权益。

### 6.2 对话生成
- `POST /v1/generations`：创建短暂生成任务。
- `GET /v1/generations/{generation_id}`：查询任务状态和完整最终结果。
- `GET /v1/generations/{generation_id}/events`：获取流式事件。
- `POST /v1/generations/{generation_id}/cancel`：请求取消任务。

约束：
- 客户端先将用户消息写入本地事务，再发起生成请求。
- 服务端只暂存完成模型调用所需的最小上下文和结果，设置短 TTL、严格访问控制和日志脱敏；不得作为 Thread/Message 历史主库。
- 流式 delta 只用于临时展示；最终结果必须可通过 generation_id 查询，客户端写入本地后才成为正式 Assistant Message。
- 幂等键用于防止网络重试重复创建任务；取消与自然完成竞态以服务端先提交的终态为准。

### 6.3 加密备份与恢复
- `POST /v1/backups/init`：创建备份上传会话。
- `PUT /v1/backups/{backup_id}/parts/{part_no}`：上传密文分块。
- `POST /v1/backups/{backup_id}/complete`：校验并提交备份。
- `GET /v1/backups?dataset_id=...`：在当前账号授权范围内查询备份。
- `GET /v1/backups/{backup_id}/download`：下载密文。
- `POST /v1/recovery/challenges`、`POST /v1/recovery/authorize`：使用独立恢复凭证完成挑战验证并签发短时授权。
- `GET /v1/recovery/backups`：通过恢复授权查询可恢复备份。
- `POST /v1/data-sets/{dataset_id}/clear`：写入不可逆清除墓碑。
- `POST /v1/account/deletion`：注销账号身份，不删除本地数据或服务器加密备份。

约束：
- init、complete、clear 和恢复授权使用幂等键或等效重放保护。
- 分块上传支持断点续传；服务端按块号与密文哈希去重。
- 服务端只校验密文哈希、大小和最小 manifest，不解密私人备份。
- 墓碑优先于所有普通索引、上传完成、下载、恢复和授权签发；晚到的上传完成请求不得复活已清除数据集。
- 账号授权查询与恢复凭证授权查询是两条独立路径；不得把恢复凭证等同于账号登录态。
- 具体字段、错误结构和安全方案以 OpenAPI 与安全设计为准。

## 7. 身份、数据集与访问权益
- Account 只代表认证身份。
- LocalDataSet 使用随机不可预测 ID；本地数据集与当前账号的绑定关系显式保存。
- 同一设备切换账号时不自动切换到其他账号的数据集；必须先选择数据集。
- 不同账号的数据集在 UI、数据访问层和备份授权层都必须隔离。
- 用户加入某个 BookRevision 时，服务端签发版本访问权益凭证；凭证绑定 account、book_revision_id、授权时间和签名版本。
- 本地缓存权益凭证用于离线访问已缓存内容；在线获取新内容时服务端仍校验权益。
- 永久权益不可因商城下架而失效；新版 BookRevision 需要单独加入。

## 8. 错误与恢复设计

| 场景 | 系统行为 |
|---|---|
| 浏览器不支持 OPFS/VFS | 阻止创建新数据集或进入安全只读状态；不自动换库 |
| 存储配额不足 | 保留当前数据；停止导入/缓存；提示清理非核心缓存或备份后处理 |
| 浏览器清理站点数据 | 通过独立备份恢复；明确未备份数据不可恢复 |
| 数据库损坏 | 停止写入；尝试完整性检查和最近成功备份恢复，不覆盖损坏库 |
| Worker 崩溃 | 重启 Worker，执行完整性检查和未完成事务恢复 |
| 多标签页竞争 | 只有 owner 可写；其他标签页只读或提示 |
| 网络中断 | 本地阅读和编辑继续；生成任务状态可稍后查询 |
| 备份失败 | 保留 pending 标记，下一次启动/联网后重试 |
| 恢复失败 | 临时库丢弃，当前本地库不变 |
| 数据集已清除 | 所有下载、恢复和重新授权请求拒绝 |

## 9. 非功能要求
- 本地用户消息写入必须先于网络请求。
- 本地事务不得跨越网络等待。
- 关键写入应有 dirty_sequence，不能依赖页面关闭事件保证备份。
- 应用启动时备份检查异步执行，不阻塞首屏和本地阅读。
- 任何备份状态不得泄露私人正文。
- 所有服务端 API 进行用户/数据集授权校验；管理端无私人数据读取权限。
- 本地数据 schema 与备份包 schema 独立版本化。
- 书籍公共内容版本与用户私人数据版本独立演进。
- 关键可观测性包括本地事务耗时、备份耗时/大小、恢复耗时、Worker 崩溃、配额异常、生成任务最终状态；日志不记录正文。

## 10. 放行前置条件
以下事项通过 PoC 和安全评审前保持待验证：
1. SQLite WASM + OPFS 在 Chrome/Edge 主测环境的持久性、崩溃恢复和多标签页锁。
2. IndexedDB 对照组的事务、迁移、批量导出和大文本性能。
3. Web Crypto 备份加密、恢复凭证、密文完整性和恢复演练。
4. 完整/增量备份一致性、断点续传、幂等和清除墓碑竞态。
5. EPUB/PDF/TXT 文件导入、阅读、定位和缓存。
6. fetch 流式输出断线、重连、取消和最终结果查询。
7. 目标浏览器兼容矩阵和存储配额/持久化策略。
8. 隐私政策、模型供应商数据留存与临时生成任务 TTL。

## 11. 参考资料
- MDN Storage quotas and eviction criteria — https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria
- MDN StorageManager.persist() — https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist
- MDN Web Crypto API — https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API
- MDN Using IndexedDB — https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB
- SQLite WASM OPFS — https://sqlite.org/wasm/doc/tip/persistence.md
- SQLite WASM VFS trade-offs — https://www.sqlite.org/wasm/doc/trunk/persistence.md
