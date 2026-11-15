# 公开书源核验记录（2026-11-15）

本目录记录“书籍采集”项目已核验的外部书源。它是采集登记，不代表所有来源文件已镜像到本仓库。

## 本轮结论

### 可直接作为重点书目登记的相关书籍

| 书名 | 作者 | 对应主题 | 语言/年份 | 全文状态 | 许可与处理 |
|---|---|---|---|---|---|
| [Reality Lost: Markets of Attention, Misinformation and Manipulation](https://doi.org/10.1007/978-3-030-00813-0) | Vincent F. Hendricks；Mads Vestergaard | 传播、宣传操纵、人性、营销、注意力经济 | 英语；2019 | 出版社提供完整 PDF/EPUB | CC BY 4.0；允许复制、分享和改编，须署名并标注修改 |
| [Social Engineering: How Crowdmasters, Phreaks, Hackers, and Trolls Created a New Form of Manipulative Communication](https://doi.org/10.7551/mitpress/12984.001.0001) | Robert W. Gehl；Sean T. Lawson | 人性、传播、宣传操纵、社会工程、欺骗 | 英语；2022 | MIT Press Direct to Open 提供开放获取版本 | MIT Press 通用 OA 条款为 CC BY-NC-ND 4.0（除非该书另有说明）；仅考虑原样、非商业分享，不改编 |
| [Media and Propaganda in an Age of Disinformation](https://doi.org/10.4324/9781003474760) | Nelson Ribeiro、Barbie Zelizer（编） | 传播、宣传、舆论操纵、虚假信息、政治传播 | 英语；2025 | 出版社和高校知识库提供完整版本；UCP 记录约 6.13 MB | CC BY-NC-ND 4.0；原样、非商业分享，不改编 |

### 高相关章节

| 章节 | 来源 | 主题 | 获取与许可 |
|---|---|---|---|
| Social Engineering | [The InfoSec Handbook](https://link.springer.com/chapter/10.1007/978-1-4302-6383-8_15) | 社会工程、信息搜集、欺骗 | Springer 标注 Open Access；具体许可须以章节 PDF 的版权页为准 |
| Phishing and Social Engineering in the Age of LLMs | [Springer chapter](https://link.springer.com/chapter/10.1007/978-3-031-54827-7_8) | 网络钓鱼、社会工程、AI 欺骗 | Springer 标注 Open Access；具体许可须以章节 PDF 的版权页为准 |

### 高相关但目前不能采集全文的书籍

| 书名 | 作者 | 主题 | 当前状态 |
|---|---|---|---|
| [The Psychology of Fraud, Persuasion and Scam Techniques](https://www.routledge.com/The-Psychology-of-Fraud-Persuasion-and-Scam-Techniques-Understanding-What-Makes-Us-Vulnerable/Dove/p/book/9781032966472) | Martina Dove | 诈骗心理、说服、认知偏差、杀猪盘 | 2026 第二版商业出版；登记元数据和官方地址 |
| [Understanding Social Engineering Based Scams](https://link.springer.com/book/10.1007/978-1-4939-6457-4) | Markus Jakobsson（编） | 诈骗、BEC、钓鱼、爱情诈骗、说服 | 订阅/购买内容；仅有部分预览和章节入口 |
| [White-Collar and Financial Crimes](https://www.ucpress.edu/books/white-collar-and-financial-crimes/paper) | Jennifer C. Noble | 白领犯罪、金融诈骗、庞氏骗局、洗钱 | 商业出版；登记元数据和官方地址 |
| [Introduction to Cyberdeception](https://link.springer.com/book/10.1007/978-3-319-41187-3) | Neil C. Rowe；Julian Rrushi | 网络欺骗、冒充、伪装、社会工程 | 订阅/购买内容；有章节预览 |
| [Social Engineering and Human Hacking](https://link.springer.com/book/10.1007/978-3-662-72084-4) | Erfan Koza；Asiye Öztürk；Michael Willer | 人性操纵、社会工程、钓鱼与防御 | Springer 独家授权商业出版；未发现开放全文 |

## 大型全文与检索来源

| 来源 | 与目标主题的关系 | 许可/访问边界 | 本项目处理 |
|---|---|---|---|
| [Institutional Books Corpus](https://institutional.org/institutional-books/) | 约 98.3 万册、254 种语言；覆盖德语、法语、西班牙语、俄语；分类中有心理学、法律、社会科学、政治学 | 项目说明为公版图书语料；逐册仍需保留原始来源与元数据 | 作为多语言公版书发现入口，不整库镜像 |
| [Harvard Library Public Domain Corpus](https://library.harvard.edu/services-tools/harvard-library-datasets) | 约 100 万册公版图书，可发现心理学、社会科学、商业史等旧版著作 | 需申请访问；官方限制非营利、教育和研究用途 | 只记录来源，不将受限数据复制到公开仓库 |
| [PleIAs Common Corpus](https://huggingface.co/datasets/PleIAs/common_corpus) | 多语言图书、报刊、科学和法律文本；支持逐文档语言、标题、作者、许可与来源追溯 | 数据集宣称仅含公版或自由许可文本，但必须逐文档检查 license 字段 | 后续筛选目标主题书籍，不整库镜像 |
| [BYOB Public-Domain Book Corpus](https://huggingface.co/datasets/disco-jack-basement/byob-pd-book-corpus) | 多语言文学、哲学、科学作品；约 36.3GB，英语占比较高 | 数据集 CC0；来源包括 Gutenberg、Standard Ebooks、Internet Archive、Wikisource；明确排除俄语 | 不整库复制；按目录寻找与主题直接相关的公版单本 |
| [CLiGS Textbox](https://github.com/cligs/textbox) | 法语、西班牙语、意大利语、葡萄牙语文学文本 | 原文公版；标注/元数据 CC BY；意大利小说标注另有 NC-SA-BY 限制 | 作为外文原文补充语料，不视为人性/商业/诈骗专题书库 |
| [CLiGS CoNSSA](https://github.com/cligs/conssa) | 358 部 1880—1939 年西班牙小说，约 2670 万 token | 原文 Public Domain Mark；TEI 标注和元数据 CC BY 4.0 | 作为西班牙语文学语料，不列入目标主题核心书单 |
| [Directory of Open Access Books](https://www.doabooks.org/) | 开放学术专著发现目录，适合按主题查找人性、商业、传播、产品与营销书籍 | 每本书按出版社页面逐本核验许可 | 后续按主题和语言检索，当前未完成逐本筛选 |

## 采集决策

1. 先把三本高相关开放获取专著纳入核心书目。
2. 《Reality Lost》为 CC BY 4.0，优先获取完整 PDF/EPUB 原件。
3. 《Social Engineering》和《Media and Propaganda in an Age of Disinformation》均有开放获取版本，但属于 CC BY-NC-ND 4.0；如需镜像，只能原样、非商业分享，不得改编。不得把它们转换成重新排版的全文 Markdown 后再发布。
4. 订阅或商业出版的书只保存书目、摘要性说明和官方获取链接，不保存未授权全文或章节。
5. 大型语料库只作为发现入口。按单本书的作者、标题、版本、来源和许可筛选，不能把整个语料库的许可推定为每一本书的许可。
6. 文学语料虽然具有多语言价值，但不应误标为目标主题专著。

## 本轮尚未完成

- 本轮没有将 PDF/EPUB 二进制原件上传到 GitHub。当前连接器的文件写入能力仅支持 UTF-8 文本；本轮网络运行环境也无法直接克隆外部 Git 仓库或下载二进制文件。
- 因此本次提交只包含书源核验记录和书目元数据，不宣称已经把三本书的完整原文存入仓库。
- 后续需使用支持二进制文件的上传通道，将许可允许的原始 PDF/EPUB 放入 `library/originals/`，并记录 SHA-256、文件大小、原始下载地址和许可文件。
