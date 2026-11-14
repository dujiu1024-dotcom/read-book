import test from "node:test";
import assert from "node:assert/strict";
import { createGithubCorpusProvider } from "./github-corpus-provider.js";

function memoryCacheStorage() {
  const entries = new Map();
  const cache = {
    async match(key) { return entries.get(String(key))?.clone() || null; },
    async put(key, response) { entries.set(String(key), response.clone()); }
  };
  return { entries, async open() { return cache; } };
}

test("uses cached source metadata and text when GitHub is offline", async () => {
  const cacheStorage = memoryCacheStorage();
  const metadata = {
    type: "file",
    sha: "0123456789abcdef0123456789abcdef01234567",
    download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
  };
  const onlineProvider = createGithubCorpusProvider({
    cacheStorage,
    fetchImpl: async (url) => String(url).includes("/contents/")
      ? new Response(JSON.stringify(metadata), { status: 200 })
      : new Response(["传习录", "卷上", "徐爱引言", "原文第一段。", "卷中", "原文第二段。", "卷下", "原文第三段。"].join("\n"), { status: 200 })
  });
  const online = await onlineProvider.loadBookRevision("github-corpus-chuanxilu");
  assert.equal(online.sourceMetadata.cacheFallbackCount, 0);
  assert.equal(cacheStorage.entries.size, 2);

  const offlineProvider = createGithubCorpusProvider({
    cacheStorage,
    fetchImpl: async () => { throw new Error("offline"); }
  });
  const offline = await offlineProvider.loadBookRevision("github-corpus-chuanxilu");
  assert.equal(offline.bookRevisionId, online.bookRevisionId);
  assert.equal(offline.sourceMetadata.cacheFallbackCount, 2);
  assert.deepEqual(offline.units.map((unit) => unit.text), online.units.map((unit) => unit.text));
});
