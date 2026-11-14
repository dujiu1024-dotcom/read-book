import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const sqlitePackage = fileURLToPath(new URL("./node_modules/@sqlite.org/sqlite-wasm", import.meta.url));
const localHostUrl = process.env.READ_BOOK_HOST_URL || "http://127.0.0.1:9787";
const localAuthToken = process.env.READ_BOOK_LOCAL_TOKEN || "local-dev-token";
// 移动端真机访问时只暴露前端端口：/local-host 由 Vite 转发到本机服务，
// generationApiBaseUrl 用 same-origin 在浏览器里解析为 location.origin + "/local-host"。
const publicHostUrl = process.env.READ_BOOK_PUBLIC_HOST_URL || localHostUrl;
const sameOriginProxy = process.env.READ_BOOK_HOST_PROXY === "1";
// 手机通过局域网 IP 访问时，http:// 不是安全上下文，浏览器不提供 OPFS/SQLite。
// 用自签名 HTTPS（只监听局域网）即可获得完整功能；证书路径由环境变量传入，不落仓库。
const httpsKeyPath = process.env.READ_BOOK_HTTPS_KEY;
const httpsCertPath = process.env.READ_BOOK_HTTPS_CERT;
const httpsConfig = httpsKeyPath && httpsCertPath
  ? { key: readFileSync(httpsKeyPath), cert: readFileSync(httpsCertPath) }
  : undefined;
// 可选：接入正式书籍服务（Book API）。两者同时提供时，页面进入真实书籍模式。
const bookApiUrl = process.env.READ_BOOK_BOOK_API_URL || "";
const bookRevisionId = process.env.READ_BOOK_BOOK_REVISION_ID || "";

function localHostConfig() {
  return {
    name: "read-book-local-host-config",
    transformIndexHtml() {
      const config = JSON.stringify({
        generationApiBaseUrl: publicHostUrl,
        memoryProxyUrl: publicHostUrl,
        localDataSetId: "local-read-book-dataset",
        allowLocalBookGeneration: true,
        ...(bookApiUrl && bookRevisionId ? { apiBaseUrl: bookApiUrl, bookRevisionId } : {}),
      });
      return [{
        tag: "script",
        injectTo: "head-prepend",
        children: "window.READ_BOOK_CONFIG = " + config + ";\n" +
          "if (window.READ_BOOK_CONFIG.generationApiBaseUrl === 'same-origin') {\n" +
          "  window.READ_BOOK_CONFIG.generationApiBaseUrl = location.origin + '/local-host';\n" +
          "  window.READ_BOOK_CONFIG.memoryProxyUrl = location.origin + '/local-host';\n" +
          "}\n" +
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
    ...(httpsConfig ? { https: httpsConfig } : {}),
    fs: { allow: [repositoryRoot] },
    ...(sameOriginProxy ? {
      proxy: {
        "/local-host": {
          target: localHostUrl,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/local-host/, ""),
        },
      },
    } : {}),
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
