const SOURCE_PAGES = [
  { page: "王阳明集/卷01", section: "传习录上", volume: "上" },
  { page: "王阳明集/卷02", section: "传习录中", volume: "中" },
  { page: "王阳明集/卷03", section: "传习录下", volume: "下" }
];

function plainTextFromSection(html, sectionTitle, Parser = globalThis.DOMParser) {
  if (typeof Parser !== "function") throw new Error("当前环境不支持 HTML 文档解析。");
  const document = new Parser().parseFromString(html, "text/html");
  const root = document.querySelector(".mw-parser-output") || document.body;
  const headings = [...root.querySelectorAll("h2,h3,h4,h5,h6")];
  const normalize = (value) => value.replace(/[◎○●\\s]/g, "").replace(/编辑/g, "");
  const start = headings.find((heading) => normalize(heading.textContent || "").includes(normalize(sectionTitle)));
  if (!start) throw new Error("维基文库页面未找到章节：" + sectionTitle);
  const startLevel = Number(start.tagName.slice(1));
  const wrapper = start.parentElement;
  const blocks = [];
  for (let node = wrapper?.nextElementSibling; node; node = node.nextElementSibling) {
    const nestedHeadings = [...node.querySelectorAll("h2,h3,h4,h5,h6")];
    const directHeading = /^H[2-6]$/.test(node.tagName) ? node : null;
    const nextHeading = directHeading || nestedHeadings[0];
    if (nextHeading && Number(nextHeading.tagName.slice(1)) <= startLevel) break;
    const clone = node.cloneNode(true);
    clone.querySelectorAll(".mw-editsection,.reference,.reflist,.navbox,.metadata,.noprint").forEach((item) => item.remove());
    const value = (clone.textContent || "").replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ").trim();
    if (value) blocks.push(value);
  }
  const text = blocks.join("\n\n").trim();
  if (text.length < 1000) throw new Error("章节正文长度异常，拒绝把不完整页面作为整本书导入：" + sectionTitle);
  return text;
}

export async function importChuanxiLuFromWikisource({
  fetchImpl = globalThis.fetch,
  Parser = globalThis.DOMParser
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("当前环境不支持网络请求。");
  const sections = [];
  for (const source of SOURCE_PAGES) {
    const url = new URL("https://zh.wikisource.org/w/api.php");
    url.search = new URLSearchParams({
      action: "parse",
      page: source.page,
      prop: "text",
      format: "json",
      formatversion: "2",
      origin: "*"
    }).toString();
    const response = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error("维基文库请求失败（HTTP " + response.status + "）：" + source.page);
    const payload = await response.json();
    if (payload?.error || !payload?.parse) throw new Error("维基文库未返回有效页面：" + source.page);
    const html = typeof payload.parse.text === "string" ? payload.parse.text : payload.parse.text?.["*"];
    if (typeof html !== "string") throw new Error("维基文库页面正文格式无效：" + source.page);
    const text = plainTextFromSection(html, source.section, Parser);
    const title = "《传习录》" + source.volume + "卷";
    sections.push({
      title,
      text,
      source: {
        page: source.page,
        section: source.section,
        revid: payload.parse.revid || null,
        url: payload.parse.revid
          ? "https://zh.wikisource.org/w/index.php?title=" + encodeURIComponent(source.page) + "&oldid=" + payload.parse.revid
          : "https://zh.wikisource.org/zh-hans/" + encodeURIComponent(source.page)
      }
    });
  }
  const combined = sections.map((section) => section.title + "\n\n" + section.text).join("\n\n");
  if (combined.length < 10000) throw new Error("《传习录》合并正文长度异常，拒绝导入疑似不完整文本。");
  return {
    fileName: "传习录-维基文库原文.txt",
    bytes: new TextEncoder().encode(combined),
    sourceMetadata: {
      sourceType: "wikisource",
      sourceName: "维基文库《王阳明集》",
      sourceRecords: sections.map((section) => section.source),
      retrievedAt: new Date().toISOString(),
      attribution: "文本提取自维基文库页面；保留来源与修订号。重新分发前应核对页面许可及具体文本版本。",
      completenessNote: "仅提取各页中标题为《传习录》上、中、下的章节；导入后仍需对照底本检查缺文、异文、标点与章节边界。"
    },
    sections: sections.map(({ title, text, source }) => ({ title, characterCount: text.length, source }))
  };
}
