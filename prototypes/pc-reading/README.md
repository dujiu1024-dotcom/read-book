# 知行 PC 窄屏阅读交互原型

PC 阅读客户端原型，支持明确标注的 Demo BookContentProvider、公共书籍 API Provider，以及六本 GitHub 公开语料的只读 Provider。真实 API/持久化/Agent 能力必须由宿主配置，不会由演示状态冒充。

## 启动

需要 Node.js 22。使用 Vite 启动（本目录依赖 TypeScript Worker，不能用纯静态文件服务器代替）：

```bash
cd prototypes/pc-reading
npm install
npm run dev
```

浏览器打开终端输出的本地地址。

## 当前覆盖

- PC 居中窄屏单列布局，最大内容宽度 430 CSS px。
- 原文区始终位于讨论区上方，可折叠/展开。
- 主线原文按顺序推进；当前单元未讨论时，点击继续必须确认是否略读。
- 临时查看、复习、引用回跳均不改变主线游标；可返回当前主线。
- 历史消息滚动位置保护：用户正在阅读历史时，新消息不强制滚到底部。
- 模拟消息先显示“本地已保存”，并演示生成中、停止、失败和重试。
- 备份状态来自实际备份端口；未配置时明确显示未配置，演示模式不上传数据。
- 支持键盘发送（Ctrl/Cmd + Enter）、焦点可见、状态文字不只依赖颜色。
- 触控操作目标最小高度 44 CSS px；输入框字号 16 CSS px，降低 iOS 聚焦自动缩放风险。
- 不包含收藏、测验、评分、主动提问、主动提醒或自动续读。

顶部“···”是原型专用演示开关：切换当前单元“已讨论/未讨论”状态，用于验证继续前确认；不是正式产品入口。

## 自动化浏览器测试

CI 使用 Chromium 和 Playwright 验证折叠/展开、临时查看、复习、回到主线、消息保存状态、停止、失败/重试、主线确认、历史滚动保护、窄屏宽度和模拟 200% 缩放。

额外使用 Playwright 的 iPhone 13、Pixel 7 设备配置模拟触控视口，检查触控能力、44 CSS px 点击区域、折叠、章节选择、消息发送与停止。**设备配置模拟不是真实 iOS/Android 硬件测试**，不能验证系统键盘、Safari/Chrome 原生缩放、浏览器地址栏动态视口、操作系统字体渲染或真实触控延迟。

本原型仍是交互验证工具，不是正式 UI 设计稿。自动化通过不等于真实用户可用性研究通过；若需验证实际理解成本，应另行组织目标用户任务评审。项目不要求实体手机/平板真机测试，移动端适配通过 Playwright 设备配置模拟和响应式视口自动化验证。


## BookContentProvider 边界（Issue #25）

页面通过 `BookContentProvider.loadBookRevision(bookRevisionId)` 加载书籍版本，不再在页面脚本中内嵌章节与原文 fixtures。Provider 对返回内容执行结构校验：版本 ID、书籍元数据、初始主线单元、单元唯一 ID、章节、定位和正文均须有效。

当前支持 Demo Provider、公共书籍 API Provider、GitHub 六书 Provider 和本地标准书籍包 Provider。Demo 仅用于开发与自动化测试；没有显式选择 GitHub 书目或本地书籍包、也未配置正式 API 时才使用 Demo。

运行 Provider 契约测试：

```bash
node --test prototypes/pc-reading/book-content-provider.test.mjs
```


## 公共书籍 API Provider

已增加 `createPublicBookApiProvider`，按 OpenAPI 契约读取：
- `GET /v1/book-revisions/{revision_id}`
- `GET /v1/book-revisions/{revision_id}/structure`
- `GET /v1/book-revisions/{revision_id}/nodes/{node_id}/content`

真实 API 地址和访问令牌由宿主注入，不写死占位域名或凭据。配置方式是在加载 `app.js` 前注入：

```js
window.READ_BOOK_CONFIG = {
  apiBaseUrl: "https://实际 API 域名/",
  bookRevisionId: "已发布的 BookRevision UUID",
  getAccessToken: async () => "由宿主认证模块提供的短期访问令牌"
};
```

若没有配置公共 API，且没有显式选择 GitHub 书目或本地书籍包，页面使用 Demo Provider；真实书籍不会展示演示讨论消息或固定演示回复。


## 本地运行（正式阅读客户端）

本目录现由 Vite 构建，生产模式会接入 SQLite WASM + OPFS 本地 Repository、公共书籍 API Provider 和 HTTP/SSE Agent Transport，不再使用固定演示回复。

1. 在本目录安装依赖：`npm install`
2. 启动：`npm run dev`
3. 在页面加载前注入 `window.READ_BOOK_CONFIG`：
   - `apiBaseUrl`：公共书籍 API 地址
   - `generationApiBaseUrl`：生成服务 API 地址（可与 apiBaseUrl 相同）
   - `bookRevisionId`：已发布书籍版本 UUID
   - `localDataSetId`：本地数据集 ID
   - `getAccessToken`：返回当前登录令牌的异步函数；也可由 `window.READ_BOOK_AUTH.getAccessToken` 提供
   - `encryptedBackupPort`：自定义加密备份端口，必须同时实现 `uploadSnapshot(snapshot)`、`listBackups()` 和 `restoreToRepository(repository, recoveryCredential)`；也可用 `createEncryptedBackupPort(datasetId)` 工厂注入完整端口；未提供时使用 HTTP 加密备份客户端
   - `onRecoveryCredential(secret)`：首次备份时展示独立恢复凭证，用户确认已安全保存后返回 `true`；不配置则停止首次上传
   - `confirmRestore({datasetId, backups})`：新设备发现远端备份时询问是否恢复；也可使用内置确认框
   - `getRecoveryCredential()`：用户选择恢复后获取独立恢复凭证；也可使用内置输入框
   - `createNewDataSet({previousDatasetId})`：用户拒绝恢复时，由宿主创建全新的服务端数据集并返回新 UUID；不允许复用原数据集覆盖远端备份
   - `backupKdfIterations`、`backupChunkBytes`、`backupCheckpointInterval`：可选 KDF、分块大小和全量检查点间隔
   - `memoryExtractionProvider`、`memoryCandidatePolicy`：可选的结构化认知抽取 Provider 与价值评估策略
   - `planMemoryEvolution(input)`：可选的跨批次认知演变规划器；必须为每条 accepted 候选返回明确的版本计划，含前序版本和必要关系；未配置时不自动写入认知

示例（必须由宿主登录系统注入令牌，不要把令牌写入静态文件）：

```js
window.READ_BOOK_CONFIG = {
  apiBaseUrl: "https://your-book-api.example",
  generationApiBaseUrl: "https://your-generation-api.example",
  bookRevisionId: "00000000-0000-4000-8000-000000000001",
  localDataSetId: "local-dataset-1",
  getAccessToken: async () => window.READ_BOOK_AUTH.getAccessToken(),
};
```

本地讨论消息在发起网络请求前与 Assistant 占位消息、生成回执一并提交到 OPFS。启动时会创建一致性快照并尝试通过加密备份 API 上传；首次上传必须先让用户保存独立恢复凭证。SSE delta 只用于临时显示，最终消息以服务端完成快照为准。刷新后会恢复本地消息并尝试恢复待处理生成任务。

新设备本地数据为空时会先查询远端备份并询问是否恢复；恢复时要求独立恢复凭证，并且只允许导入空数据集。若用户拒绝恢复，宿主必须先创建新的数据集 ID，避免把新数据写入旧备份链。缺少对应配置时页面明确报错/显示未配置，不会伪造真实书籍、Agent 回复或云端备份状态。实体真机测试不属于开发前置。

## 标准书籍包本地导入（Issue #25）

阅读页提供“导入书籍”入口，选择由书籍加工 PoC 导出的 `.zip` 标准书籍包后，客户端会：

1. 在解压前检查 ZIP 中央目录、路径、条目数量、压缩方式和声明展开体积；拒绝分卷、加密与 ZIP64 包。
2. 校验书籍包 v1.0.0 的 manifest、书目元数据、章节树、正文切片和资源清单；package_id 仅标识打包批次，不冒充 BookRevision ID，本地导入时独立生成并持久化 Book/BookRevision UUID。
3. 校验原始文件大小与 SHA-256，并逐个校验带摘要的正文切片。
4. 将通过校验的原始 ZIP 保存到独立 IndexedDB 书籍库，不写入用户私人阅读数据 Repository。
5. 通过 `createLocalBookPackageProvider()` 将章节与正文切片映射为阅读单元。

本地导入不要求先部署公共书籍 API。未配置真实 Agent 服务时，阅读运行时仍使用 SQLite WASM + OPFS Repository，自动创建本地数据集并持久化 Thread、阅读主线/临时查看位置和历史消息；讨论输入保持禁用，不展示固定演示回复。真实讨论与云端备份仍需宿主配置认证、Generation API 和备份服务。

导入实现：`local-book-package-provider.js`。对应自动化测试：`node --test local-book-package-provider.test.mjs`；本目录脚本：`npm run test:book-package`。按项目统一验收约定，本轮未运行测试或构建。

## GitHub 六本真实语料接入

阅读页现在可以直接选择六本公开 GitHub 语料，不需要先下载或上传到 read-book 仓库：

- 《传习录》：garychowcmu/daizhigev20 的 儒藏/语录/传习录.txt，按卷上、中、下及原文行号拆分阅读单元。
- 《毛泽东选集》第一至第五卷：ruguoaaa/gushi 各卷目录中的 Markdown 正文，按原始篇目编号排序，再按段落拆分阅读单元。
- 阅读页顶部书目选择器可切换六本书；五卷分别使用独立 BookRevision ID，不会拼接。
- 原文卡片显示章节/段落定位，并提供对应 GitHub 原始文件链接。
- 正文直接从来源仓库读取，不复制进 read-book 仓库；公开访问不代表已授予再分发许可。可通过“导入书籍”入口选择符合 v1.0.0 的本地书籍包，进入本地持久化阅读模式。
- 已接入 SQLite WASM + OPFS 本地阅读位置/Thread/历史持久化，来源正文使用 Cache Storage 在线优先缓存；宿主配置完整 Generation API、认证和备份服务后，可使用正式 Agent、认知沉淀和加密云端备份。
- GitHub API 或 Raw 内容读取失败时优先使用本机已有来源缓存；无缓存时显示错误，不回退到演示正文。

启动方式：

```bash
npm run dev
```

打开阅读页后，在顶部选择《传习录》或《毛泽东选集》对应卷次。

## GitHub 语料的本地阅读位置

公开语料模式会使用与本地导入书籍相同的 localDataSetId 和 SQLite WASM + OPFS Repository 保存阅读主线、临时查看位置和 Thread；默认数据集标识保存在 read-book:local-dataset-id。书籍版本 ID 根据本次读取的 Git blob SHA 集合计算指纹；来源文件变化后会形成新的 BookRevision，不会把新版本误当成旧版本。

当宿主没有配置完整的 Generation API、认证和加密备份服务时，阅读位置、Thread 和历史消息只保存在本机，并创建本地一致性快照；界面明确显示 Agent/备份未配置。服务配置完整时则走正式 Reader Runtime 的备份检查、恢复提示和上传流程。

## GitHub 语料离线缓存

GitHub 语料 Provider 使用浏览器 Cache Storage 缓存来源仓库的目录元数据和正文文件。策略为在线优先：联网时更新缓存；网络失败或来源服务返回错误时尝试读取已有缓存。来源文件 SHA 指纹决定 BookRevision，因此缓存的旧目录和正文会作为旧版本恢复，不会与新版本混合。

缓存只包含公开来源的目录和正文，不包含用户阅读位置、消息或认知数据。阅读位置仍保存在 SQLite/OPFS；加密云端备份仍需宿主服务配置。浏览器清理站点数据后，离线缓存可能被清除。

## Agent 多来源证据

正式书籍服务模式会在用户发送讨论后，对当前 BookRevision 的阅读单元做本地词项检索，最多附带 7 条相关原文作为 additional_sources。检索使用中文二元/三元词组与英文词项的本地 BM25 风格排序，并对标题、章节名、原文命中、同章集中度和查询覆盖率进行加权；结果只来自当前 BookRevision。服务端返回的每条引用仍必须通过 BookRevision、节点、定位和原文摘录核验，只有核验通过的 CitationRecord 才会显示。引用卡片逐条回跳到对应原文。该检索是轻量词项匹配，不等同于语义向量检索；真实 Agent 仍需宿主配置 Generation API 和认证。

## GitHub 语料与 Agent 接入边界

GitHub 语料的 BookRevision ID 和结构节点 ID 均由来源 Git Blob SHA、文件路径和定位确定性生成 UUID，满足 GenerationRequest 的 UUID 契约。在线加载时逐文件计算 Git Blob SHA-1；若网络缓存内容与目录元数据声明的 Blob SHA 不一致，整本书拒绝加载，防止混合新旧版本。

若宿主配置了 Generation API、访问令牌、本地数据集 ID 和完整加密备份服务，GitHub 语料模式可使用正式阅读运行时、Agent、历史消息、认知状态、多来源引用及备份/恢复。配置不完整时自动使用本地模式，不会伪称 Agent 或云端备份成功。自定义备份端口必须同时实现上传、备份清单查询和恢复到本地 Repository。


来源检索的边界：客户端只负责从当前 BookRevision 中挑选有限候选原文；最多 7 条，每条最多 30,000 字符，当前原文与额外来源合计不超过 Generation API 的 120,000 字符上限。重试和断线恢复使用消息持久化的来源引用重建原始证据集合，不会因检索算法或书籍内容变化而静默替换来源。客户端检索结果不等于模型引用，只有服务端完成原文核验并持久化为 CitationRecord 的引用才会展示。测试代码位于 `source-retriever.test.mjs`，执行命令为 `npm run test:source-retriever`；按项目约定本轮不执行测试。
