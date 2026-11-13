# PoC C：EPUB / PDF / TXT 导入与原文定位

独立阅读引擎 PoC，不依赖数据库、备份或生成任务 PoC。固定版本：Node 22.12.0、epubjs 0.3.93、pdfjs-dist 6.5.438、fflate 0.8.2、Playwright 1.65.0、Vite 7.2.2。

## 运行

```bash
cd poc/book-ingestion
npm install
npx playwright install chromium
npm run dev
npm test
npm run build
```

## 固定样本

`src/fixtures.js` 可重复生成 3 个 EPUB、3 个 PDF、3 个 TXT 样本；测试时记录 SHA-256。样本均为自建虚拟内容，无版权文本。

## 当前实现

- EPUB：读取元数据、导航目录、spine 章节文本，尝试生成 EPUB CFI。
- PDF：PDF.js 解析物理页码、文本项和页内视口坐标；印刷页码不自动推断。
- TXT：UTF-8 严格解码，失败时尝试 GB18030；生成段落起止字符偏移。
- Citation：每章/每页/每段生成定位记录，点击可展示引用文本与定位。
- 文件字节和解析结果存入独立 IndexedDB；刷新后可确认已导入条目仍在。
- PDF.js 使用独立 Worker；EPUB 当前解析流程仍有主线程工作，尚未完成大文件 UI 阻塞测试。

## 尚未通过的验收项

- 固定样本哈希尚未写入报告；当前测试运行时计算 SHA-256。
- EPUB 图片、脚注语义、复杂目录、真实 CFI 回跳与定位精度需人工复核。
- PDF 双栏阅读顺序、页眉页脚过滤、脚注/图表、扫描件 OCR 边界尚未实现；仅保留页内文本项坐标。
- TXT GB18030 固定样本目前为 UTF-8 占位；需要提交真实编码字节夹具后才能验收编码回退。
- 引用回跳目前显示定位元数据与引用片段，不是最终排版阅读器中的精确滚动定位。
- 尚未完成损坏文件、超大文件、刷新后重新解析、离线缓存和性能基准。
- 不把解析成功等同于正文完整或定位正确；必须人工抽样对照原文件。

该 PoC 不决定最终阅读器选型，不构成正式导入服务。
