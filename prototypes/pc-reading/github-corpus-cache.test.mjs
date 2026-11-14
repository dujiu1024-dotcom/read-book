import test from "node:test";
import assert from "node:assert/strict";
import { createGithubCorpusProvider } from "./github-corpus-provider.js";

async function gitBlobSha(text) {
  const bytes = new TextEncoder().encode(text);
  const header = new TextEncoder().encode("blob " + bytes.byteLength + "\0");
  const payload = new Uint8Array(header.byteLength + bytes.byteLength);
  payload.set(header, 0);
  payload.set(bytes, header.byteLength);
  const digest = await crypto.subtle.digest("SHA-1", payload);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}



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
  const rawSource = ["传习录", "卷上", "徐爱引言", "原文第一段。", "卷中", "原文第二段。", "卷下", "原文第三段。"].join("\n");
  const metadata = {
    type: "file",
    sha: await gitBlobSha(rawSource),
    download_url: "https://raw.githubusercontent.com/garychowcmu/daizhigev20/master/source.txt"
  };
  const onlineProvider = createGithubCorpusProvider({
    cacheStorage,
    fetchImpl: async (url) => String(url).includes("/contents/")
      ? new Response(JSON.stringify(metadata), { status: 200 })
      : new Response(rawSource, { status: 200 })
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
