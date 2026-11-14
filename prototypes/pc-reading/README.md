# 知行 PC 窄屏阅读交互原型

独立阅读交互页面，当前使用明确标注的 Demo BookContentProvider。无真实账号、数据库、模型服务、业务 API 或持久化依赖。

## 启动

需要 Python 3：

```bash
python -m http.server 4173 --directory prototypes/pc-reading
```

浏览器打开 `http://localhost:4173`。

## 当前覆盖

- PC 居中窄屏单列布局，最大内容宽度 430 CSS px。
- 原文区始终位于讨论区上方，可折叠/展开。
- 主线原文按顺序推进；当前单元未讨论时，点击继续必须确认是否略读。
- 临时查看、复习、引用回跳均不改变主线游标；可返回当前主线。
- 历史消息滚动位置保护：用户正在阅读历史时，新消息不强制滚到底部。
- 模拟消息先显示“本地已保存”，并演示生成中、停止、失败和重试。
- 轻量备份状态只展示演示状态，不上传数据。
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

当前接入的是 `createDemoBookContentProvider()`，仅用于开发与自动化测试；它不是真实书籍服务，也不代表 EPUB/PDF/TXT 导入已接通。后续可替换为本地书籍包或公共书籍 API Provider，而不改变阅读页面。真实内容接入仍是 Issue #25 的未完成验收项。

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

若没有配置公共 API，页面明确使用 Demo Provider；若配置了真实书籍，页面不会展示演示讨论消息或固定演示回复，讨论输入暂时禁用，等待 #26/#27 接入。


## 标准书籍包本地导入（Issue #25）

阅读页提供“导入书籍”入口，选择由书籍加工 PoC 导出的 `.zip` 标准书籍包后，客户端会：

1. 校验 ZIP 路径、文件数量与展开体积边界。
2. 校验书籍包协议版本、BookRevision UUID、书目元数据和章节树。
3. 校验原始文件大小与 SHA-256，并逐个校验带摘要的正文切片。
4. 将通过校验的原始 ZIP 保存到独立 IndexedDB 书籍库，不写入用户私人阅读数据 Repository。
5. 通过 `createLocalBookPackageProvider()` 将章节与正文切片映射为阅读单元，加载后进入本地只读阅读模式。

本地导入不要求先部署公共书籍 API。未配置真实 Agent 服务时，讨论输入保持禁用，不展示固定演示回复；主线、临时查看、复习和引用定位仍可用于阅读。真实讨论仍需宿主配置认证与 Generation API。

导入实现：`local-book-package-provider.js`。对应自动化测试：`node --test local-book-package-provider.test.mjs`；本目录脚本：`npm run test:book-package`。按项目统一验收约定，本轮未运行测试或构建。


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
   - `encryptedBackupPort.uploadSnapshot(snapshot)`：可选自定义加密备份端口；未提供时，阅读运行时自动创建 HTTP 加密备份客户端
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
