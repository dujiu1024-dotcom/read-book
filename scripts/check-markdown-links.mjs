import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const ignored = new Set([".git", "node_modules", "dist", "coverage", ".next", ".cache"]);
const markdown = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) markdown.push(full);
  }
}
function stripCodeFences(text) {
  return text.replace(/^\\s*\\x60{3}[^\\n]*\\n[\\s\\S]*?^\\s*\\x60{3}\\s*$/gm, "").replace(/\\x60[^\\x60]*\\x60/g, "");
}
function resolveTarget(source, raw) {
  const target = raw.trim().replace(/^<|>$/g, "");
  if (!target || target.startsWith("#") || /^(https?:|mailto:|tel:|data:)/i.test(target)) return null;
  const clean = decodeURIComponent(target.split("#")[0].split("?")[0]);
  if (!clean) return null;
  return clean.startsWith("/") ? path.resolve(root, clean.slice(1)) : path.resolve(path.dirname(source), clean);
}
const failures = [];
await walk(root);
for (const source of markdown) {
  const content = stripCodeFences(await (await import("node:fs/promises")).readFile(source, "utf8"));
  const links = [...content.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)];
  for (const match of links) {
    const raw = match[1].replace(/\s+["'][^"']*["']\s*$/, "").trim();
    let target;
    try { target = resolveTarget(source, raw); }
    catch { failures.push({ source: path.relative(root, source), target: raw, reason: "invalid URI encoding" }); continue; }
    if (!target) continue;
    let exists = false;
    try {
      const info = await stat(target);
      exists = info.isFile() || info.isDirectory();
    } catch {}
    if (!exists) failures.push({ source: path.relative(root, source), target: raw, reason: "target does not exist" });
  }
}
const report = { status: failures.length ? "failed" : "passed", markdown_files: markdown.length, broken_links: failures.length, failures };
if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else {
  process.stdout.write("Markdown files: " + report.markdown_files + "\n");
  for (const failure of failures) process.stdout.write(failure.source + " -> " + failure.target + " (" + failure.reason + ")\n");
  process.stdout.write("Broken internal links: " + failures.length + "\n");
}
if (failures.length) process.exitCode = 1;
