const GITHUB_API = "https://api.github.com";
const RAW_GITHUB = "https://raw.githubusercontent.com";
const MAX_FILE_CHARACTERS = 2_000_000;
const MAX_BOOK_CHARACTERS = 16_000_000;
const CONCURRENCY = 5;
const SOURCE_CACHE_NAME = "read-book-github-corpus-v1";
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

async function gitBlobSha(bytes) {
  const header = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchVerifiedText(fetchImpl, url, label, expectedSha) {
  const response = await request(fetchImpl, url, label);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const actualSha = await gitBlobSha(bytes);
  if (actualSha.toLowerCase() !== expectedSha.toLowerCase()) {
    throw new Error(label + " Git Blob SHA 校验失败；拒绝混用不同来源版本的缓存内容。");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(label + " 不是有效 UTF-8 文本，拒绝导入。");
  }
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
function makeUnit({ id, chapter, title, text, locator, sourceUrl, sourcePath, sourceSha, order }) {
  return { id, chapter, title, text, locator, order, source: {
    repository: sourcePath.startsWith("儒藏/") ? "garychowcmu/daizhigev20" : "ruguoaaa/gushi",
    path: sourcePath, url: sourceUrl, revision: sourceSha || null
  }};
}
async function loadChuanxiLu(fetchImpl) {
  const repository = "garychowcmu/daizhigev20";
  const path = "儒藏/语录/传习录.txt";
  const apiPath = path.split("/").map(encodeURIComponent).join("/");
  const metadataUrl = GITHUB_API + "/repos/" + repository + "/contents/" + apiPath + "?ref=master";
  const metadata = await (await request(fetchImpl, metadataUrl, "《传习录》来源元数据")).json();
  if (metadata.type !== "file" || !/^[a-f0-9]{40}$/i.test(metadata.sha || "") ||
      typeof metadata.download_url !== "string" ||
      !metadata.download_url.startsWith(RAW_GITHUB + "/" + repository + "/")) {
    throw new Error("《传习录》来源元数据不完整或下载地址不可信。");
  }
  const url = metadata.download_url;
  const raw = await fetchVerifiedText(fetchImpl, url, "《传习录》正文", metadata.sha);
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
        sourceUrl: "https://github.com/" + repository + "/blob/" + metadata.sha + "/" + path.split("/").map(encodeURIComponent).join("/"),
        sourcePath: path, sourceSha: metadata.sha, order
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
    if (typeof url !== "string" || !url.startsWith(RAW_GITHUB + "/ruguoaaa/gushi/") ||
        !/^[a-f0-9]{40}$/i.test(file.sha || "") || typeof file.path !== "string" ||
        !file.path.startsWith(directory + "/")) {
      throw new Error("GitHub 返回了非预期的正文来源信息：" + file.name);
    }
    const raw = await fetchVerifiedText(fetchImpl, url, file.name, file.sha);
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
        sourceUrl: "https://github.com/ruguoaaa/gushi/blob/" + article.file.sha + "/" + article.file.path.split("/").map(encodeURIComponent).join("/"),
        sourcePath: article.file.path, sourceSha: article.file.sha, order
      }));
    });
  }
  if (!units.length) throw new Error(book.title + "未提取到正文段落。");
  return units;
}
async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function uuidFromHash(hash) {
  const chars = hash.slice(0, 32).split("");
  chars[12] = "5";
  chars[16] = ((Number.parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const hex = chars.join("");
  return hex.slice(0, 8) + "-" + hex.slice(8, 12) + "-" + hex.slice(12, 16) + "-" + hex.slice(16, 20) + "-" + hex.slice(20, 32);
}

async function sourceFingerprint(units) {
  const sourceIdentity = units.map((unit) => unit.source.repository + "/" + unit.source.path + ":" + unit.source.revision).join("\n");
  return sha256Hex(sourceIdentity);
}

function createCacheAwareFetch(fetchImpl, cacheStorage) {
  let fallbackCount = 0;
  return {
    get fallbackCount() { return fallbackCount; },
    async fetch(url, options) {
      const cacheable = typeof url === "string" &&
        (url.startsWith(GITHUB_API + "/repos/") || url.startsWith(RAW_GITHUB + "/"));
      let cache = null;
      if (cacheable && cacheStorage?.open) {
        try { cache = await cacheStorage.open(SOURCE_CACHE_NAME); } catch { cache = null; }
      }
      try {
        const response = await fetchImpl(url, options);
        if (response.ok && cache) {
          void cache.put(url, response.clone()).catch(() => {});
        } else if (!response.ok && cache) {
          try {
            const cached = await cache.match(url);
            if (cached) { fallbackCount += 1; return cached; }
          } catch {}
        }
        return response;
      } catch (error) {
        if (cache) {
          try {
            const cached = await cache.match(url);
            if (cached) { fallbackCount += 1; return cached; }
          } catch {}
        }
        throw error;
      }
    }
  };
}

export function createGithubCorpusProvider({ fetchImpl = globalThis.fetch, cacheStorage = globalThis.caches } = {}) {
  if (typeof fetchImpl !== "function") throw new TypeError("GitHub 语料 Provider 需要 fetch 实现。");
  const sourceFetch = createCacheAwareFetch(fetchImpl, cacheStorage);
  return Object.freeze({
    async loadBookRevision(bookRevisionId) {
      const key = requiredText(bookRevisionId, "BookRevision ID").replace(/^github-corpus-/, "");
      const book = GITHUB_CORPUS_BOOKS.find((item) => item.key === key);
      if (!book) throw new Error("不支持的 GitHub 语料书目：" + key);
      const units = key === "chuanxilu" ? await loadChuanxiLu(sourceFetch.fetch.bind(sourceFetch)) : await loadMaoXuanVolume(sourceFetch.fetch.bind(sourceFetch), VOLUMES.find((item) => item.key === key));
      const sourceSnapshotSha256 = await sourceFingerprint(units);
      const bookRevisionId = uuidFromHash(sourceSnapshotSha256);
      await Promise.all(units.map(async (unit) => {
        const unitIdentity = [
          bookRevisionId, unit.source.repository, unit.source.path,
          unit.source.revision, unit.locator, String(unit.order),
        ].join("\n");
        unit.id = uuidFromHash(await sha256Hex(unitIdentity));
      }));
      return {
        bookRevisionId,
        title: book.title, author: book.author,
        initialMainlineUnitId: units[0].id, units,
        sourceMetadata: {
          sourceSnapshotSha256,
          kind: "public-github-source", repository: book.source,
          sourceUrl: key === "chuanxilu" ? "https://github.com/garychowcmu/daizhigev20" : "https://github.com/ruguoaaa/gushi",
          attribution: "正文按需从公开 GitHub 仓库读取。公开可访问不等于已确认再分发许可；本模式不将正文复制进 read-book 仓库。",
          loadedAt: new Date().toISOString(), unitCount: units.length,
          cacheFallbackCount: sourceFetch.fallbackCount,
          cacheEnabled: Boolean(cacheStorage?.open)
        }
      };
    }
  });
}
