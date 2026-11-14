# P0 开源项目运行验证记录

> **历史路线记录，已失效。** ReadAny/TextSage 复用的移动端与小程序路线已被 D-049（第一阶段 PC Web）替代；本文仅保留当时的环境与运行证据，不再作为当前路线依据。
>
> 验证日期：2026-11-13  
> 目标：ReadAny 移动端底座、TextSage PDF 处理流水线  
> 验证性质：远程源码与仓库结构复核；本次未完成本地克隆、依赖安装和实际运行。不得将源码审查写成运行通过。

## 1. 执行摘要

| 项目 | 仓库版本 | 本次实际执行 | 当前结论 |
|---|---|---|---|
| ReadAny | main @ `fce44689e1377df1ae99a35e8e71d5e8b3a639d1` | Git clone 未开始成功；源码通过 GitHub API 检查 | 值得继续作为移动端 Fork 候选；运行状态未验证 |
| TextSage | main @ `c2363f6f8df74c703536bf717d9c3178bf4260d7` | Git clone 未开始成功；源码通过 GitHub API 检查 | 不建议整体复用；只提取 PDF 处理算法和阶段设计 |

### 本次执行阻塞

在当前执行容器运行：
- `git clone --depth 1 https://github.com/codedogQBY/ReadAny.git`
- `git clone --depth 1 https://github.com/sunnyvucs/TextSage.git`

两条命令均因 `Could not resolve host: github.com` 失败。当前环境无法从 GitHub 建立网络连接。因此不能安装依赖、执行测试、构建 Android/iOS，也不能处理真实 PDF。该阻塞属于本次执行环境的网络限制，不代表上游项目构建失败。

本次改用已授权 GitHub 连接读取仓库元数据、目录树和关键源码。下述结论均标记为“源码审查发现”，不冒充端到端运行结果。

## 2. ReadAny

### 2.1 固定版本与技术信息

- 仓库：`codedogQBY/ReadAny`
- 分支：`main`
- 本次检查 commit：`fce44689e1377df1ae99a35e8e71d5e8b3a639d1`
- commit 时间：2026-10-07
- 仓库根目录 packageManager：`pnpm@9.15.0`
- Expo 移动端包：`packages/app-expo`，版本 `1.3.7`
- README 明确要求 Expo development build；Expo Go 不支持其原生模块和配置。
- 根包包含 pnpm workspace、patchedDependencies，且存在自定义 Expo 原生模块。

### 2.2 源码审查发现

1. **移动端是完整的本地应用，不是云端 SaaS 客户端。**
   - MobileSyncAdapter 直接管理本机 `readany.db`，通过 expo-sqlite 执行 VACUUM、完整性检查和文件读写。
   - 书籍解析、切片、向量化由移动端本地队列触发。
   - README 的跨设备同步能力以 WebDAV 为主，不等于平台云端用户/书籍/Thread/Message API。
   - 这进一步证实知行不能仅通过增加一个登录页就得到云端权威架构；需要建设服务端数据 API 和同步适配层。

2. **RAG 本地处理链路有复用价值。**
   - `auto-vectorize-service.ts` 接收本地书籍数据，调用 Extractor 提取章节，再调用 vectorize trigger。
   - 适合借鉴本地初加工、进度回调和向量化接口。
   - 需要抽离平台依赖，形成可在管理员 PC 和云端 Worker 复用的处理核心；手机端不应承担管理员书籍入库工作流。

3. **对话 UI 有较高复用价值。**
   - MessageList 使用 FlatList 展示 MessageV2，包含流式状态、消息滚动和 Citation 点击回调。
   - 仍需核对 Thread 存储、上下文构造、消息持久化和服务端模型调用的实际调用链。
   - 知行需把一本书多个 Thread 收敛为每用户每本书一个长期 Thread。

4. **原生构建不是零成本。**
   - 项目有自定义 Android/iOS Expo modules、Reader HTML 构建步骤和 native 配置脚本。
   - Android 验证需要 Android SDK/模拟器或设备；iOS 本地构建需要 macOS/Xcode。当前容器不能代替这些设备环境。
   - 后续应优先做依赖安装、Expo prebuild 和 Android 构建；iOS 在具备 macOS/Xcode 的环境验证。

### 2.3 对知行的判断

- 保留候选：Expo 工程、书籍对话 UI、流式消息组件、引用展示、EPUB 阅读与定位组件。
- 需要拆分：SQLite Repository、RAG 本地解析/切片、Embedding 和 Vector Store 适配器、WebDAV 同步层。
- 需要重写/建设：云端身份与权限、云端 Thread/Message API、平台笔记与认知记忆、云端 RAG、同步冲突处理。
- 需要删减或隐藏：阅读统计、打卡/连续阅读、徽章、阅读进度驱动等与知行核心原则冲突的产品功能。
- 结论：**继续作为移动端 Fork 候选，但尚未通过运行验证。**

## 3. TextSage

### 3.1 固定版本与技术信息

- 仓库：`sunnyvucs/TextSage`
- 分支：`main`
- 本次检查 commit：`c2363f6f8df74c703536bf717d9c3178bf4260d7`
- README 声明 Python 3.10+、FastAPI、Qdrant、PostgreSQL、Ollama。
- 依赖入口未在仓库根目录发现 `requirements.txt`、`pyproject.toml`；仓库目录树中也未发现根目录 `LICENSE` 文件。README 的 MIT badge 不能代替实际许可证文本，许可证状态应标为未核实。
- `src/config.py` 将 ROOT_DIR 写死为 Windows 路径 `D:\\AI\\AI Projects\\PDFParserAI`。

### 3.2 源码审查发现

1. **处理流水线可拆解借鉴。**
   - PDF 拆页、文本提取、学科识别、目录提取、章节页码对齐、切片、PostgreSQL 写入、向量化、归档是分阶段模块。
   - `main.py` 提供按阶段执行的 CLI 参数，具备一定阶段重跑能力。
   - `manifest.json` 保存 source_pdf、subject、part、class_number、extractor 和 page 列表，可作为 manifest 思路参考。

2. **不是通用图书处理引擎。**
   - 项目定位是 school textbook PDF。
   - 目录结构、章节/学科/年级识别、页码对齐和 topic×page 切片都围绕教材设计。
   - 当前不能据此认为它支持 EPUB、TXT、普通非教材 PDF 或扫描书籍的通用处理。

3. **依赖和部署较重。**
   - MinerU 或 PyMuPDF、Groq Vision 或 Ollama、SentenceTransformers、Qdrant、Redis、PostgreSQL。
   - Embedding 默认 BAAI/bge-base-en-v1.5，面向英文语料的默认选择不能直接用于知行中文书籍。
   - README 中的“Fully local inference”是其特定部署路径，不能等同于轻量可嵌入模块。

4. **恢复机制不适合直接作为云端任务系统。**
   - `resume_check.py` 通过命令行交互询问 Resume/Restart/Chunk only。
   - Restart 会删除该书工作目录；不适合无人值守云端任务。
   - `manifest_validator.py` 的校验重点是教材元数据字段，并通过 Groq Vision 修复缺失字段，不是知行需要的内容完整性、版本、章节、页码、切片质量验收。
   - 当前阶段可重跑不等于具备任务队列、幂等、断点续传、失败报告和跨机器恢复。

5. **数据模型高度业务特化。**
   - PostgreSQL 表为 textbook_books、textbook_chunks、textbook_images，字段包含 class_number、subject、part、chapter/topic 等。
   - 向量存储使用 Qdrant，Redis 用作 Embedding 缓存。
   - 不建议直接迁移其数据库模型或整体部署。

### 3.3 对知行的判断

- 借鉴：PDF 拆页、MinerU/PyMuPDF 选择、章节页码对齐、图文关联、阶段化处理、manifest。
- 不直接复用：教材元数据模型、学科/年级分类、交互式恢复流程、Qdrant/Redis/PostgreSQL 整套部署。
- 必须重做：跨格式解析、统一书籍包协议、通用章节模型、云端任务编排、质量验收、失败报告、定向返工。
- 结论：**仅模块级借鉴，不作为知行后端底座。**

## 4. P0 验证状态

| 验证项 | 状态 | 说明 |
|---|---|---|
| 固定仓库 commit | 已完成 | 已记录上述 commit |
| 读取目录树和关键配置 | 已完成 | GitHub API 读取 |
| ReadAny 依赖安装 | 未执行 | clone 被当前环境 DNS 阻断 |
| ReadAny Expo 启动 | 未执行 | 同上 |
| ReadAny Android 构建 | 未执行 | 需依赖安装及 Android SDK |
| ReadAny iOS 构建 | 未执行 | 需 macOS/Xcode |
| ReadAny EPUB→对话→引用定位 | 未执行 | 需真机/模拟器端到端 |
| TextSage 依赖安装 | 未执行 | clone 被当前环境 DNS 阻断，且依赖清单缺失 |
| TextSage 真实 PDF 处理 | 未执行 | 需运行环境、服务和测试 PDF |
| TextSage 分阶段重跑 | 仅源码审查 | 现有 CLI 恢复流程依赖人工输入 |

**P0 状态：受执行环境阻塞，未通过。** 不得据此批准直接 Fork 进入开发。

## 5. 下一步建议

### P0-A：解决可运行环境

任选其一：
1. 在可访问 GitHub 的开发机/用户本地环境执行 clone、安装和构建，将完整日志与结果回传；
2. 提供可供本次执行环境访问的源码归档/镜像和依赖缓存，再继续构建验证。

ReadAny 最小验证：
- `pnpm install --frozen-lockfile`
- `pnpm expo:prebuild`（按项目要求执行）
- Android development build
- 导入 EPUB → 打开书籍 → 发起对话 → 流式回答 → 点击引用定位

TextSage 最小验证：
- 补齐/确认依赖安装方式和版本锁定
- 配置 MinerU/PyMuPDF、Groq 或 Ollama、PostgreSQL、Qdrant、Redis
- 使用一份具有目录、页码、图表的真实 PDF
- 记录各阶段输出、失败恢复、耗时、内存和模型下载体积

### P0-B：无需等待运行验证即可开展的协议设计

- 设计知行自己的标准书籍包 Schema，不照搬 TextSage Manifest。
- 设计云端验收状态机和结构化失败报告。
- 设计本地处理阶段依赖图，失败后重跑该阶段及下游阶段。
- 定义云端从原始文件完整重建的策略。
- 定义 Thread/Message/Note 的云端权威与 SQLite 缓存同步协议。

## 6. 重要纠偏

前期文档中“ReadAny 移动端基础成熟”“TextSage 流水线成熟”等表达只能表示源码结构具备参考价值，不表示已经完成构建和运行验证。后续所有结论必须明确区分：
- 源码审查通过；
- 单元测试通过；
- 构建通过；
- 真机/模拟器端到端通过；
- 真实书籍质量评测通过。

只有后几项逐步完成后，才能确认项目具备实际复用价值。


## 7. GitHub 云端 CI 验证补充（2026-11-13）

本节是对固定 ReadAny commit 的补充验证。CI 运行的是上游源码，不代表知行改造版已经完成验证。

### 第 3 次运行：Lint 阻断

- Run：43358621013
- Workflow commit：32495f6e590f1ad2622af5ac8d279c7eae6b6605
- Core tests：通过
- Mobile app tests：通过
- Mobile app lint：失败，Biome 报告 191 errors、78 warnings
- Reader build、Expo config：因 Lint 失败而跳过
- Android APK：构建过程中被取消，未完成

结论：将整个移动端包作为 Lint 范围仍会遇到大量上游既有诊断。不能据此判断测试或 Android 工程不可运行，也不应批量改动上游源码来制造绿色状态。

### CI 策略调整

- 将上游 Lint 调整为非阻断诊断项，仍执行并保留结果。
- Core tests、Mobile app tests、Reader build、Expo config 和 Android APK 构建继续作为主要验证项。
- 同一分支的并发运行改为排队，避免新运行自动取消正在执行的验证。
- Workflow 修订 commit：b82608ef75458f0cdd797a4dcbb7126fe81a62e8。

### 第 4 次运行：当前状态

- Run：43359000578
- Workflow commit：b82608ef75458f0cdd797a4dcbb7126fe81a62e8
- 依赖安装：通过
- Core tests：通过
- Mobile app tests：通过
- Lint advisory step：已执行，步骤未阻断后续任务
- Reader build：通过
- Expo config：通过
- Android APK：Gradle assembleDebug 正在执行；最终结果和 APK Artifact 待补充

运行链接：https://github.com/dujiu1024-dotcom/read-book/actions/runs/43359000578

注意：当前仅是上游源码在 GitHub Linux runner 上的构建验证。APK 成功仍不等于真机安装、启动、导入 EPUB、发起对话和引用定位端到端通过。


## 8. 自动化测试覆盖审查补充（2026-11-13）

- 固定版本目录树共发现 99 个测试文件：core 85、app-expo 7、CLI 7。文件数不等于测试用例数或覆盖率。
- 根目录 `pnpm test` 实际运行 core 测试；CI 另行运行 app-expo 测试。
- 已检查 Thread/Message 查询、Chat Store、RAG Search、Chat Memory 和 Reading Context 关键测试。
- Thread/Message 测试主要验证本地 SQLite CRUD；没有证明知行的一书一 Thread 云端唯一约束、跨设备并发和 Message 幂等。
- RAG 测试使用 Mock 数据库/Embedding，不能证明真实中文书籍检索和引用准确性。
- Chat Memory 测试覆盖摘要滑动窗口，不覆盖知行的来源可追溯认知记忆。
- app-expo 当前发现 7 个测试文件，主要覆盖键盘布局、阅读排版/字体、TTS 和主题；未发现 BookChatScreen 端到端测试。
- 固定版本目录树中未发现 Detox、Maestro、Appium、Playwright 等 E2E 框架配置。
- 详细审查与放行规则见 [ReadAny 自动化测试覆盖审查](readany-test-coverage-audit.md)。

### 当前结论

CI 第 4 次运行的 Core 测试、Expo App 测试、Reader 构建和 Expo 配置步骤均已通过；Android Debug APK 的 Gradle 构建仍在执行且尚无 Artifact。即使 APK 成功生成，也还需要真机安装、中文 EPUB 阅读、对话、流式响应、引用回跳和异常恢复验证。

**当前仍不满足进入知行业务开发的放行条件。**


## 9. 第 4 次 CI 最终结果与验证范围调整（2026-11-13）

Run：43359000578  
Workflow commit：b82608ef75458f0cdd797a4dcbb7126fe81a62e8  
运行链接：https://github.com/dujiu1024-dotcom/read-book/actions/runs/43359000578

最终结果：两个 Job 均 completed / success。

### Quality Job

- 依赖安装：成功。
- Core tests：成功。
- Expo App tests：成功。
- Mobile app lint advisory：执行完成；该步骤为非阻断诊断项。
- Reader 资源构建：成功。
- Expo 公共配置检查：成功。

### Android Build Job

- 依赖安装：成功。
- Reader 资源构建：成功。
- Expo Android prebuild：成功。
- Gradle assembleDebug：成功。
- APK Artifact 上传：成功。

Artifact：
- 名称：readany-android-debug-fce44689e1377df1ae99a35e8e71d5e8b3a639d1
- Artifact ID：14007664552
- 大小：151,465,105 bytes（约 144.4 MiB）
- 创建时间：2026-11-13 03:56:31 UTC
- 到期时间：2026-11-20 03:56:19 UTC
- SHA-256：75efda262d7fef500d467d1f3f0ac9acfb48f0a72493b02da8d220cc3adb16d4
- 下载：通过上述 Actions 运行页面的 Artifacts 区域获取。

### 结果解释

本次证明固定 ReadAny commit 在 GitHub Linux Runner 上可以完成依赖安装、Core/App 自动化测试、Reader 构建、Expo 配置检查和 Android Debug APK 构建。

本次不证明：
- APK 已在真实设备安装或运行。
- EPUB 阅读、对话、流式响应和引用回跳完整链路通过。
- 中文真实书籍 RAG 质量达标。
- ReadAny 可直接迁移到微信小程序。
- 知行云端服务端已经实现或通过测试。

### 用户确认后的验证范围调整

用户明确表示当前不需要 Android/iOS 真机验证，未来可能采用微信小程序或服务号。因此：
- Android/iOS 真机验证从当前阶段计划中暂停，不再作为当前放行条件。
- APK 构建保留为 ReadAny 上游工程证据，不继续投入真机测试。
- 不再把 React Native / Expo 视为知行已确定的用户端技术路线。
- 后续优先验证平台无关的领域模型、API 契约、身份映射、Thread/Message 幂等与断线恢复、传输层抽象、Citation 定位和 RAG 真实书籍质量。
- 微信小程序优先作为主入口候选，服务号作为辅助入口候选；实际账号资质、接口权限、审核规则和运行能力仍未验证。
- 详细修订见 docs/validation-strategy.md 第 8 节。

当前结论：ReadAny 上游工程构建验证通过；知行产品核心和目标入口尚未通过验证；仍不批准直接进入知行业务代码开发。
