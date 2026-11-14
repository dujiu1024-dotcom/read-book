import test from "node:test";
import assert from "node:assert/strict";
import { createGithubCorpusProvider, GITHUB_CORPUS_BOOKS } from "./github-corpus-provider.js";

async function gitBlobSha(text) {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}



test("exposes six separately selectable corpus revisions", () => {
  assert.deepEqual(GITHUB_CORPUS_BOOKS.map((book) => book.key), ["chuanxilu", "maoxuan-1", "maoxuan-2", "maoxuan-3", "maoxuan-4", "maoxuan-5"]);
});

test("loads Chuanxi Lu into ordered units with volume labels and source locators", async () => {
  const source = ["传习录", "卷上", "徐爱引言", "先生于大学格物诸说。", "", "卷中", "答顾东桥书。", "卷下", "门人陆澄录。"].join("\n");
  const sha = await gitBlobSha(source);
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify({
      type: "file", sha,
      download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
    }), { status: 200 });
    return new Response(source, { status: 200 });
  }});
  const revision = await provider.loadBookRevision("github-corpus-chuanxilu");
  assert.equal(revision.title, "传习录");
  assert.match(revision.bookRevisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(revision.sourceMetadata.sourceSnapshotSha256.length, 64);
  assert.match(revision.units[0].id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(revision.units.length >= 4);
  assert.equal(revision.units[0].chapter, "卷上");
  assert.ok(revision.units.some((unit) => unit.chapter === "卷中"));
  assert.ok(revision.units.some((unit) => unit.chapter === "卷下"));
  assert.match(revision.units[0].locator, /传习录\.txt#line-/);
  assert.match(revision.units[0].source.url, /github\.com/);
});

test("loads a Mao Xuan volume independently and preserves article order", async () => {
  const articleText = "# 正文\n\n这是第一段。\n\n这是第二段。";
  const sha = await gitBlobSha(articleText);
  const files = [
    { type: "file", name: "02、第二篇.md", path: "docs/方法论/毛泽东选集/第二卷/02、第二篇.md", sha, download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/02.md" },
    { type: "file", name: "01、第一篇.md", path: "docs/方法论/毛泽东选集/第二卷/01、第一篇.md", sha, download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/01.md" },
    { type: "file", name: "README.md", path: "docs/方法论/毛泽东选集/第二卷/README.md", sha, download_url: "https://raw.githubusercontent.com/ruguoaaa/gushi/main/README.md" }
  ];
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify(files), { status: 200 });
    return new Response(articleText, { status: 200 });
  }});
  const revision = await provider.loadBookRevision("github-corpus-maoxuan-2");
  assert.equal(revision.title, "毛泽东选集 第二卷");
  assert.match(revision.bookRevisionId, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.ok(revision.units.every((unit) => unit.chapter.startsWith("第二卷 / ")));
  assert.match(revision.units[0].chapter, /第一篇/);
  assert.ok(revision.units.some((unit) => /第二篇/.test(unit.chapter)));
});

test("rejects unknown corpus identifiers and empty source files", async () => {
  const emptySha = await gitBlobSha("");
  const provider = createGithubCorpusProvider({ fetchImpl: async (url) => {
    if (String(url).includes("/contents/")) return new Response(JSON.stringify({
      type: "file", sha: emptySha,
      download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
    }), { status: 200 });
    return new Response("", { status: 200 });
  }});
  await assert.rejects(() => provider.loadBookRevision("github-corpus-unknown"), /不支持/);
  await assert.rejects(() => provider.loadBookRevision("github-corpus-chuanxilu"), /来源文件为空/);
});

test("rejects stale cached bytes when the GitHub directory advertises a different blob SHA", async () => {
  const expected = "原文版本A";
  const advertisedSha = await gitBlobSha(expected);
  const provider = createGithubCorpusProvider({
    fetchImpl: async (url) => String(url).includes("/contents/")
      ? new Response(JSON.stringify({
          type: "file", sha: advertisedSha,
          download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
        }), { status: 200 })
      : new Response("原文版本B", { status: 200 })
  });
  await assert.rejects(
    () => provider.loadBookRevision("github-corpus-chuanxilu"),
    /Git Blob SHA 校验失败/
  );
});
