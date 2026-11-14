import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sqlitePackage = fileURLToPath(new URL("./node_modules/@sqlite.org/sqlite-wasm", import.meta.url));
const localHostUrl = process.env.READ_BOOK_HOST_URL || "http://127.0.0.1:9787";
const localAuthToken = process.env.READ_BOOK_LOCAL_TOKEN || "local-dev-token";
// 可选：接入正式书籍服务（Book API）。两者同时提供时，页面进入真实书籍模式。
const bookApiUrl = process.env.READ_BOOK_BOOK_API_URL || "";
const bookRevisionId = process.env.READ_BOOK_BOOK_REVISION_ID || "";

function localHostConfig() {
  return {
    name: "read-book-local-host-config",
    transformIndexHtml() {
      const config = JSON.stringify({
        generationApiBaseUrl: localHostUrl,
        memoryProxyUrl: localHostUrl,
        localDataSetId: "local-read-book-dataset",
        allowLocalBookGeneration: true,
        ...(bookApiUrl && bookRevisionId ? { apiBaseUrl: bookApiUrl, bookRevisionId } : {}),
      });
      return [{
        tag: "script",
        injectTo: "head-prepend",
        children: "window.READ_BOOK_CONFIG = " + config + ";\n" +
          "window.READ_BOOK_CONFIG.getAccessToken = async () => " + JSON.stringify(localAuthToken) + ";",
      }];
    },
  };
}

export default defineConfig({
  root: fileURLToPath(here),
  plugins: [localHostConfig()],
  resolve: {
    alias: [{ find: "@sqlite.org/sqlite-wasm", replacement: sqlitePackage }],
  },
  server: {
    host: "0.0.0.0",
    fs: { allow: [repositoryRoot] },
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
    },
  },
  optimizeDeps: { exclude: ["@sqlite.org/sqlite-wasm"] },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
});
