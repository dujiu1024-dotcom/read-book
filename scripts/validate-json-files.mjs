import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const ignored = new Set([".git", "node_modules", "dist", "coverage", ".next", ".cache"]);
const failures = [];
let jsonFiles = 0;
let jsonlFiles = 0;
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile()) {
      if (entry.name.endsWith(".json")) {
        jsonFiles += 1;
        try { JSON.parse(await readFile(full, "utf8")); }
        catch (error) { failures.push({ file: full, reason: error.message }); }
      } else if (entry.name.endsWith(".jsonl")) {
        jsonlFiles += 1;
        const lines = (await readFile(full, "utf8")).split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].trim()) continue;
          try { JSON.parse(lines[index]); }
          catch (error) { failures.push({ file: full, line: index + 1, reason: error.message }); }
        }
      }
    }
  }
}
await walk(process.cwd());
const report = { status: failures.length ? "failed" : "passed", json_files: jsonFiles, jsonl_files: jsonlFiles, failures };
process.stdout.write(JSON.stringify(report, null, 2) + "\n");
if (failures.length) process.exitCode = 1;
