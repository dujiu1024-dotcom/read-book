import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const here = new URL(".", import.meta.url);
const sqlitePackage = fileURLToPath(new URL("./node_modules/@sqlite.org/sqlite-wasm", import.meta.url));

export default defineConfig({
  root: fileURLToPath(here),
  resolve: {
    alias: [{ find: "@sqlite.org/sqlite-wasm", replacement: sqlitePackage }],
  },
  server: { host: "0.0.0.0" },
  worker: { format: "es" },
  build: { outDir: "dist", emptyOutDir: true },
});
