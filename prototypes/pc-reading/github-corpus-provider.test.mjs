import test from "node:test";
import assert from "node:assert/strict";
import { createGithubCorpusProvider, GITHUB_CORPUS_BOOKS } from "./github-corpus-provider.js";

test("exposes six separately selectable corpus revisions", () => {
  assert.deepEqual(GITHUB_CORPUS_BOOKS.map((book) => book.key), ["chuanxilu", "maoxuan-1", "maoxuan-2", "maoxuan-3", "maoxuan-4", "maoxuan-5"]);
});

test("loads Chuanxi Lu into ordered units with volume labels and source locators", async () => {
  const source = ["传习录", "卷上", "徐爱引言", "先生于大学格物诸说。", "", "卷中", "答顾东桥书。", "卷下", "门人陆澄录。"].join("\n");
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify({
      type: "file", sha: "0123456789abcdef0123456789abcdef01234567",
      download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
    }), { status: 200 });
    return new Response(source, { status: 200 });
  }});
  const revision = await provider.loadBookRevision("github-corpus-chuanxilu");
  assert.equal(revision.title, "传习录");
  assert.match(revision.bookRevisionId, /^github-corpus-chuanxilu-[a-f0-9]{20}$/);
  assert.equal(revision.sourceMetadata.sourceSnapshotSha256.length, 64);
  assert.ok(revision.units.length >= 4);
  assert.equal(revision.units[0].chapter, "卷上");
  assert.ok(revision.units.some((unit) => unit.chapter === "卷中"));
  assert.ok(revision.units.some((unit) => unit.chapter === "卷下"));
  assert.match(revision.units[0].locator, /传习录\.txt#line-/);
  assert.match(revision.units[0].source.url, /github\.com/);
});

test("loads a Mao Xuan volume independently and preserves article order", async () => {
  const files = [
    { type: "file", name: "02、第二篇.md", path: "docs/第二卷/02、第二篇.md", sha: "2222222222222222222222222222222222222222", download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/02.md" },
    { type: "file", name: "01、第一篇.md", path: "docs/第二卷/01、第一篇.md", sha: "1111111111111111111111111111111111111111", download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/01.md" },
    { type: "file", name: "README.md", path: "docs/第二卷/README.md", sha: "3333333333333333333333333333333333333333", download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/README.md" }
  ];
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify(files), { status: 200 });
    return new Response("# 正文\n\n这是第一段。\n\n这是第二段。", { status: 200 });
  }});
  const revision = await provider.loadBookRevision("github-corpus-maoxuan-2");
  assert.equal(revision.title, "毛泽东选集 第二卷");
  assert.match(revision.bookRevisionId, /^github-corpus-maoxuan-2-[a-f0-9]{20}$/);
  assert.ok(revision.units.every((unit) => unit.chapter.startsWith("第二卷 / ")));
  assert.match(revision.units[0].chapter, /第一篇/);
  assert.ok(revision.units.some((unit) => /第二篇/.test(unit.chapter)));
});

test("rejects unknown corpus identifiers and empty source files", async () => {
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify({
      type: "file", sha: "0123456789abcdef0123456789abcdef01234567",
      download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
    }), { status: 200 });
    return new Response("", { status: 200 });
  }});
  await assert.rejects(() => provider.loadBookRevision("github-corpus-unknown"), /不支持/);
  await assert.rejects(() => provider.loadBookRevision("github-corpus-chuanxilu"), /来源文件为空/);
});
