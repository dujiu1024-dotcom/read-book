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
