# 标准书籍包与云端验收协议（V1 草案）

> 状态：协议草案，待评审；不代表已有处理工具或云端服务实现。
> 目标：定义管理员 PC 本地初加工产物与云端权威处理服务之间的稳定交换边界。
> 原则：原始文件不可丢；每次处理版本不可变；云端独立验收；失败可定位、可重跑；本地结果只是可选输入，不是最终事实。

## 1. 核心原则

1. 原始文件是重建依据。本地解析文本、切片和向量均可丢弃并重建；原始文件及其哈希必须保留。
2. 每次处理生成独立 Revision。不覆盖已发布版本；失败返工创建新的 processing attempt。
3. 云端掌握最终解释权。云端可复用通过校验的本地阶段产物，也可补处理或从源文件完整重做。
4. 协议与内部数据库解耦。本地工具和云端服务只交换标准包，不共享数据库表结构。
5. 每个阶段记录输入哈希、输出哈希、处理器版本、规则版本、耗时和状态。
6. 技术验收通过不等于版权审核通过，更不等于自动公开上架。

## 2. 标准目录结构

- manifest.json
- source/：原始 EPUB、PDF 或 TXT 文件
- content/book.json：书目元数据
- content/chapters.json：章节树和定位
- content/chunks.jsonl：逐行 JSON 切片
- assets/：可选图片和页面渲染资源
- embeddings/：可选向量文件
- validation/local-report.json：可选本地自检报告

约束：

- 原始文件名由 manifest 指定，云端不得依赖固定文件名。
- embeddings 为可选输入，云端必须保留重新生成能力。
- 本地自检报告只作参考，不作为云端验收通过的证据。
- ZIP 包禁止路径穿越、软链接逃逸和可执行脚本自动运行。

## 3. manifest 最小字段

    {
      "schema_name": "read-book-package",
      "schema_version": "1.0.0",
      "package_id": "uuid",
      "created_at": "2026-11-13T00:00:00Z",
      "source": {
        "file": "source/original.epub",
        "format": "epub",
        "sha256": "hex",
        "size_bytes": 123456
      },
      "book": {
        "title": "书名",
        "authors": ["作者"],
        "language": "zh-CN",
        "isbn": null,
        "edition": null,
        "translator": null,
        "publisher": null
      },
      "processing": {
        "processor_name": "read-book-processor",
        "processor_version": "0.1.0",
        "rules_version": "0.1.0",
        "parser": "parser-name",
        "parser_version": "1.2.3"
      },
      "artifacts": {
        "book": "content/book.json",
        "chapters": "content/chapters.json",
        "chunks": "content/chunks.jsonl",
        "embeddings": null,
        "local_report": "validation/local-report.json"
      },
      "counts": {
        "chapters": 12,
        "chunks": 860,
        "assets": 0
      }
    }

说明：

- schema_version 使用语义化版本；不兼容字段变化升级主版本。
- package_id 标识一次打包，不等于 book_id 或 book_revision_id。
- source.sha256 是原始文件内容哈希，云端必须重新计算。
- ISBN、版本、译者等元数据允许为空，不允许模型臆造。
- counts 是包内声明值，云端需自行统计并对比。
- manifest 不存储用户隐私、API Key、模型访问令牌或本机绝对路径。

## 4. 内容文件契约

### book.json

最小字段：title、authors、language、description（可空）、identifiers（可空）。可选记录 metadata_confidence 和 metadata_sources。

### chapters.json

每个章节包含：

- chapter_id：包内稳定 ID
- parent_chapter_id：可空
- title、level、order_index
- start_locator、end_locator
- page_start、page_end：适用时填写
- source_heading：原文标题，可选

章节 ID 在同一个 package 内稳定；重新处理后可以变化，后续可通过内容和定位建立新旧版本映射。

### chunks.jsonl

每行一个切片对象，最小字段：

- chunk_id、chapter_id、chapter_title、order_index
- content、content_sha256
- locator_type、start_locator、end_locator
- page_number：可空
- paragraph_start、paragraph_end：可空
- parser_version、chunker_version

定位格式建议：

| 格式 | 定位方式 |
|---|---|
| EPUB | CFI 或稳定文本锚点 |
| PDF | 物理页码 + 页内文本范围；可附印刷页码 |
| TXT | 字符偏移或段落序号 |
| 其他 | 显式声明 locator_type，不得伪装成通用页码 |

不得只存切片文本而丢失来源定位。向量不是原文证据，Citation 必须回到 chunk 和原始版本。

### embeddings（可选）

每批向量必须提供 embedding_model、embedding_model_version、embedding_dimension、normalization、distance_metric、preprocessing_version、chunk_id 映射、文件格式和校验哈希。

云端仅在模型、版本、维度、归一化和预处理均兼容时考虑复用。否则重新向量化，不得将不同模型产生的向量混合到同一索引空间。

## 5. 上传与版本对象

建议云端对象：

- ingestion_batch：一次上传请求
- book_revision：不可变的书籍内容版本
- processing_attempt：某个 revision 的一次处理/验收尝试
- processing_stage_run：单阶段执行记录
- processing_artifact：阶段输入、输出及对象存储引用
- validation_issue：机器可读的问题项

关键标识：

- batch_id：上传批次
- book_id：书目逻辑 ID
- revision_id：不可变内容版本 ID
- attempt_id：一次处理尝试 ID
- stage_run_id：一次阶段执行 ID

同一 package_id + source hash 的重复上传应幂等返回已有批次，或明确要求新建 revision，不应产生不可控重复数据。

## 6. 云端处理状态机

Revision 总状态：

    uploaded
      → validating_package
      → queued
      → processing
      → quality_check
      → accepted
      → pending_rights_review
      → publishable
      → published

异常分支：

    validating_package → rejected
    processing → retryable_failed
    processing → failed
    quality_check → needs_rework

重要约束：

- 修改原始文件或任何影响解析的输入时，必须新建 revision。
- 同一 revision 的失败重试可创建新的 attempt。
- 处理器/规则版本变化若会改变结果，应创建新的 attempt 并记录版本；是否升级为新 revision 由发布策略决定。
- accepted 仅表示技术验收通过，不代表版权审核通过。
- published revision 不可原地修改；修订必须创建新 revision。

## 7. 处理阶段与依赖

建议第一版阶段：

1. package_inspection：ZIP 安全检查、manifest Schema、路径与文件存在性。
2. source_verification：源文件哈希、格式、大小、完整性。
3. metadata_normalization：元数据清洗、版本识别、来源记录。
4. parse：EPUB/PDF/TXT 对应解析器。
5. normalize：文本编码、乱码、空白、重复页眉页脚、段落顺序处理。
6. structure：章节树、标题层级、页码与定位映射。
7. chunk：正式切片和定位。
8. embedding：按云端模型生成或兼容复用向量。
9. index_build：关键词索引与向量索引构建。
10. quality_check：统计、抽样回查、召回测试。
11. rights_review：来源和授权证据人工审核。
12. publish：发布书籍版本和检索索引。

依赖规则：

- parse 失败，后续 normalize、structure、chunk、embedding、index、quality 均不得继续。
- 元数据警告不一定阻断解析，但版本不明确时不得发布。
- embedding 失败可允许进入待补向量状态，但不能标记完整检索验收通过。
- rights_review 不通过时禁止 publish，即使质量检查全部通过。

## 8. 质量验收项目

| 类别 | 检查项 | 结果级别 |
|---|---|---|
| 包完整性 | manifest、源文件、必需产物、哈希 | 失败可阻断 |
| 元数据 | 标题、作者、语言、版本一致性 | 警告或阻断 |
| 文本质量 | 空内容、乱码、重复、异常字符比例 | 警告或阻断 |
| 结构质量 | 章节缺失、顺序错乱、层级异常 | 警告或阻断 |
| 定位质量 | chunk 能否回查源文件 | 失败可阻断 |
| 切片质量 | 长度分布、空 chunk、重复 chunk、边界 | 警告或阻断 |
| 向量质量 | 模型兼容、维度、缺失比例 | 按检索模式阻断 |
| 检索质量 | 标注问题的召回与引用支持情况 | 需达到评测阈值 |
| 权利审核 | 来源、许可/授权证据、使用范围 | 发布前强制通过 |

第一轮先用真实 EPUB/PDF/TXT 样本建立基线，再冻结阈值。不得凭经验随意设置未经测量的准确率门槛。

## 9. 失败报告格式

云端失败报告必须机器可读，至少包含：

    {
      "report_version": "1.0.0",
      "batch_id": "uuid",
      "revision_id": "uuid",
      "attempt_id": "uuid",
      "overall_status": "needs_rework",
      "summary": {"error_count": 1, "warning_count": 2},
      "issues": [{
        "issue_code": "CHUNK_LOCATOR_MISSING",
        "severity": "error",
        "stage": "chunk",
        "artifact": "content/chunks.jsonl",
        "record_id": "chunk-001",
        "chapter_id": "chapter-03",
        "page_number": 17,
        "message": "切片缺少可回查原文的定位信息",
        "evidence": {"chunk_id": "chunk-001"},
        "suggested_action": "重新执行定位映射和切片"
      }],
      "created_at": "2026-11-13T00:00:00Z"
    }

错误代码稳定、可检索；message 面向人类，issue_code 面向程序。报告不能只返回“处理失败”或一段无法解析的堆栈。

## 10. 定向返工策略

本地工具读取云端报告后，按依赖图计算重跑范围：

| 失败阶段 | 最小建议重跑范围 |
|---|---|
| package_inspection | 修复包结构后重新上传验包 |
| source_verification | 检查原文件并重新打包 |
| metadata_normalization | 元数据规范化及下游依赖阶段 |
| parse | parse → normalize → structure → chunk → embedding → index → quality |
| normalize | normalize → structure → chunk → embedding → index → quality |
| structure | structure → chunk → embedding → index → quality |
| chunk | chunk → embedding → index → quality |
| embedding | embedding → index → quality |
| index_build | index_build → quality |
| quality_check | 按 issue 指定阶段；无法定位时重跑完整质量检查 |
| rights_review | 补充授权证据，不重跑解析流水线 |

阶段缓存复用必须满足输入哈希、处理器版本、规则版本和依赖产物哈希一致，且阶段未被标记为不可复用。否则必须重跑。

## 11. API 草案

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | /admin/ingestion-batches | 创建上传批次 |
| POST | /admin/ingestion-batches/{id}/complete | 上传完成，触发云端验包 |
| GET | /admin/ingestion-batches/{id} | 查询批次和验收状态 |
| GET | /admin/ingestion-batches/{id}/report | 获取结构化验收报告 |
| POST | /admin/ingestion-batches/{id}/retry | 根据报告创建新的处理尝试 |
| GET | /admin/books/{book_id}/revisions | 查看书籍版本 |
| POST | /admin/revisions/{revision_id}/rights-review | 提交版权审核结果 |
| POST | /admin/revisions/{revision_id}/publish | 发布通过审核的版本 |

上传可采用预签名对象存储 URL + 分片上传；完成接口必须校验对象大小、哈希和幂等键。分片大小和并发数由部署测试决定。

## 12. 待验证与待确认

- EPUB、PDF、TXT 的标准定位格式和回查实现。
- 本地与云端是否共用同一 Python 处理引擎。
- PDF OCR 的触发条件和成本策略。
- 向量复用的严格兼容判定规则。
- 质量评测集、抽样比例和阈值。
- 版权/来源审核字段、证据类型和审核责任。
- 超大书籍包的分片上传、断点续传和保留策略。

V1 优先冻结包结构、版本标识、阶段状态和失败报告四个契约。质量阈值和具体解析器实现应通过真实样本验证后再冻结。


## 13. V1.0.0 机器可读 Schema 与校验器约定

V1.0.0 JSON Schema 使用 JSON Schema Draft 2020-12，版本化存放于：

`schemas/book-package/1.0.0/`

| 文件 | 校验对象 |
|---|---|
| `manifest.schema.json` | 包清单、源文件、元数据、处理器版本、产物路径和计数 |
| `book.schema.json` | `content/book.json` |
| `chapters.schema.json` | `content/chapters.json`；根节点为章节数组 |
| `chunk.schema.json` | `content/chunks.jsonl` 的每一行 |
| `embeddings.schema.json` | `manifest.artifacts.embeddings` 指向的向量元数据 JSON |
| `local-report.schema.json` | 可选本地自检报告 |
| `failure-report.schema.json` | 云端结构化失败报告 |

约定补充：

- `manifest.artifacts.embeddings` 指向 `embeddings/` 下的元数据 JSON；元数据中的 `file` 字段再指向实际向量文件。若没有向量产物，manifest 中该字段为 null。
- `manifest.artifacts.local_report` 为可选路径；本地报告只提供诊断信息，不改变云端验收结论。
- `chapters.json` 是章节对象数组；每个章节必须包含 chapter_id、parent_chapter_id、title、level、order_index、start_locator 和 end_locator。
- `chunks.jsonl` 每一非空行必须独立符合 chunk Schema；content_sha256 必须是 UTF-8 编码后的 content 字节的 SHA-256。
- manifest 中的 chapters/chunks/assets 计数由校验器重新统计，不信任包内声明值。
- 所有包内路径必须为相对 POSIX 路径；禁止绝对路径、反斜杠路径和路径穿越片段。

### 独立 CLI

入口：`tools/book_package_validator/book_package_validator.py`

支持目录包和 ZIP 包；ZIP 不落盘解压。校验顺序为：

1. 检查包路径、目录/ZIP 条目、重复路径、软链接、加密条目、可执行/脚本文件类型和资源限制。
2. 校验 manifest Schema、源文件存在性、大小和 SHA-256。
3. 校验 book、chapters、chunks、embeddings 元数据及 local-report。
4. 校验 chunk 内容哈希、章节引用完整性、唯一 ID 和 manifest 计数。
5. 输出符合 local-report Schema 的机器可读结果和非零失败退出码。

CLI 资源限制通过参数配置（单文件大小、总解压大小、压缩比、文件数）。当前默认值属于安全保护默认值，不是最终业务限制；应结合真实书籍样本和部署资源测试后再冻结。技术验收通过不代表版权审核或发布通过。
