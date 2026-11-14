const GITHUB_API = "https://api.github.com";
const RAW_GITHUB = "https://raw.githubusercontent.com";
const MAX_FILE_CHARACTERS = 2_000_000;
const MAX_BOOK_CHARACTERS = 16_000_000;
const CONCURRENCY = 5;
const VOLUMES = [
  { key: "maoxuan-1", title: "毛泽东选集 第一卷", volume: "第一卷", path: "第一卷" },
  { key: "maoxuan-2", title: "毛泽东选集 第二卷", volume: "第二卷", path: "第二卷" },
  { key: "maoxuan-3", title: "毛泽东选集 第三卷", volume: "第三卷", path: "第三卷" },
  { key: "maoxuan-4", title: "毛泽东选集 第四卷", volume: "第四卷", path: "第四卷" },
  { key: "maoxuan-5", title: "毛泽东选集 第五卷", volume: "第五卷", path: "第五卷" },
];
export const GITHUB_CORPUS_BOOKS = Object.freeze([
  { key: "chuanxilu", title: "传习录", author: "王阳明", source: "garychowcmu/daizhigev20" },
  ...VOLUMES.map(({ key, title }) => ({ key, title, author: "毛泽东", source: "ruguoaaa/gushi" })),
]);
function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(label + " 不能为空。");
  return value.trim();
}
function readableMarkdown(value) {
  return String(value || "")
    .replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*(?:\r?\n|$)/, "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "（图片：$1）")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1（$2）")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/\*\*(.*?)\*\*/gs, "$1")
    .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, "$1")
    .replace(/\x60([^\x60]+)\x60/g, "$1")
    .replace(/\r\n/g, "\n")
    .trim();
}
function splitLongParagraph(text, maxLength = 1600) {
  if (text.length <= maxLength) return [text];
  const sentences = text.split(/(?<=[。！？；.!?])\s*/);
  const parts = [];
  let current = "";
  for (const sentence of sentences) {
    if (!sentence) continue;
    if (current && current.length + sentence.length > maxLength) {
      parts.push(current); current = "";
    }
    if (sentence.length > maxLength) {
      if (current) parts.push(current);
      current = "";
      for (let offset = 0; offset < sentence.length; offset += maxLength) parts.push(sentence.slice(offset, offset + maxLength));
    } else current += sentence;
  }
  if (current) parts.push(current);
  return parts;
}
function paragraphsFromText(raw) {
  const normalized = readableMarkdown(raw);
  const blocks = normalized.split(/\n(?:\s*\n)+/).map((item) => item.trim()).filter(Boolean);
  const sourceBlocks = blocks.length > 1 ? blocks : normalized.split(/\n+/).map((item) => item.trim()).filter(Boolean);
  return sourceBlocks.flatMap((item) => splitLongParagraph(item)).filter(Boolean);
}
async function request(fetchImpl, url, label) {
  const response = await fetchImpl(url, { headers: { Accept: "application/vnd.github+json" } });
  if (!response.ok) throw new Error(label + "读取失败（HTTP " + response.status + "）。");
  return response;
}
async function mapConcurrent(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
function numberedSort(left, right) {
  const a = Number(left.name.match(/^(\d+)/)?.[1] || 999999);
  const b = Number(right.name.match(/^(\d+)/)?.[1] || 999999);
  return a - b || left.name.localeCompare(right.name, "zh-CN");
}
function makeUnit({ id, chapter, title, text, locator, sourceUrl, sourcePath, order }) {
  return { id, chapter, title, text, locator, order, source: {
    repository: sourcePath.startsWith("儒藏/") ? "garychowcmu/daizhigev20" : "ruguoaaa/gushi",
    path: sourcePath, url: sourceUrl, revision: "main-or-master"
  }};
}
async function loadChuanxiLu(fetchImpl) {
  const repository = "garychowcmu/daizhigev20";
  const path = "儒藏/语录/传习录.txt";
  const url = RAW_GITHUB + "/" + repository + "/master/" + path.split("/").map(encodeURIComponent).join("/");
  const raw = await (await request(fetchImpl, url, "《传习录》")).text();
  if (!raw.trim()) throw new Error("《传习录》来源文件为空。");
  if (raw.length > MAX_BOOK_CHARACTERS) throw new Error("《传习录》超过单书读取上限。");
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const units = [];
  let volume = "卷上";
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].replace(/^[　\s]+|[　\s]+$/g, "");
    if (!line) continue;
    const heading = line.match(/^卷([上中下])$/);
    if (heading) { volume = "卷" + heading[1]; continue; }
    for (const part of splitLongParagraph(line, 1200)) {
      const order = units.length;
      units.push(makeUnit({
        id: "chuanxilu-" + String(order + 1).padStart(5, "0"),
        chapter: volume, title: volume + " · 第" + (order + 1) + "段", text: part,
        locator: path + "#line-" + (lineIndex + 1),
        sourceUrl: "https://github.com/" + repository + "/blob/master/" + path.split("/").map(encodeURIComponent).join("/"),
        sourcePath: path, order
      }));
    }
  }
  if (!units.length) throw new Error("《传习录》未提取到正文段落。");
  return units;
}
async function loadMaoXuanVolume(fetchImpl, book) {
  const directory = "docs/方法论/毛泽东选集/" + book.path;
  const encodedPath = directory.split("/").map(encodeURIComponent).join("/");
  const listingUrl = GITHUB_API + "/repos/ruguoaaa/gushi/contents/" + encodedPath + "?ref=main";
  const listing = await (await request(fetchImpl, listingUrl, book.title + "目录")).json();
  if (!Array.isArray(listing)) throw new Error(book.title + "目录响应格式错误。");
  const files = listing.filter((entry) => entry.type === "file" && /\.md$/i.test(entry.name) && entry.name.toLowerCase() !== "readme.md").sort(numberedSort);
  if (!files.length) throw new Error(book.title + "没有找到 Markdown 正文文件。");
  let totalCharacters = 0;
  const articles = await mapConcurrent(files, CONCURRENCY, async (file) => {
    const url = file.download_url;
    if (typeof url !== "string" || !url.startsWith(RAW_GITHUB + "/ruguoaaa/gushi/")) throw new Error("GitHub 返回了非预期的正文下载地址：" + file.name);
    const raw = await (await request(fetchImpl, url, file.name)).text();
    if (!raw.trim()) throw new Error(file.name + " 正文为空。");
    if (raw.length > MAX_FILE_CHARACTERS) throw new Error(file.name + " 超过单篇读取上限。");
    totalCharacters += raw.length;
    if (totalCharacters > MAX_BOOK_CHARACTERS) throw new Error(book.title + " 超过单书读取上限。");
    return { file, title: file.name.replace(/^\d+[、.．\s]*/, "").replace(/\.md$/i, ""), blocks: paragraphsFromText(raw), url };
  });
  const units = [];
  for (const article of articles) {
    article.blocks.forEach((text, paragraphIndex) => {
      const order = units.length;
      units.push(makeUnit({
        id: book.key + "-" + article.file.name.replace(/\.md$/i, "").replace(/[^\p{L}\p{N}-]+/gu, "-") + "-p" + String(paragraphIndex + 1).padStart(4, "0"),
        chapter: book.volume + " / " + article.title,
        title: article.title + " · 第" + (paragraphIndex + 1) + "段",
        text, locator: article.file.path + "#paragraph-" + (paragraphIndex + 1),
        sourceUrl: article.url, sourcePath: article.file.path, order
      }));
    });
  }
  if (!units.length) throw new Error(book.title + "未提取到正文段落。");
  return units;
}
export function createGithubCorpusProvider({ fetchImpl = globalThis.fetch } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub 语料 Provider 需要 fetch 实现。");
  return Object.freeze({
    async loadBookRevision(bookRevisionId) {
      const key = requiredText(bookRevisionId, "BookRevision ID").replace(/^github-corpus-/, "");
      const book = GITHUB_CORPUS_BOOKS.find((item) => item.key === key);
      if (!book) throw new Error("不支持的 GitHub 语料书目：" + key);
      const units = key === "chuanxilu" ? await loadChuanxiLu(fetchImpl) : await loadMaoXuanVolume(fetchImpl, VOLUMES.find((item) => item.key === key));
      return {
        bookRevisionId: "github-corpus-" + key, title: book.title, author: book.author,
        initialMainlineUnitId: units[0].id, units,
        sourceMetadata: {
          kind: "public-github-source", repository: book.source,
          sourceUrl: key === "chuanxilu" ? "https://github.com/garychowcmu/daizhigev20" : "https://github.com/ruguoaaa/gushi",
          attribution: "正文按需从公开 GitHub 仓库读取。公开可访问不等于已确认再分发许可；本模式不将正文复制进 read-book 仓库。",
          loadedAt: new Date().toISOString(), unitCount: units.length
        }
      };
    }
  });
}
