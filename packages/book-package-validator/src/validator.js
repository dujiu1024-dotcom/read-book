import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import manifestSchema from "../schemas/manifest.schema.json" with { type: "json" };
import bookSchema from "../schemas/book.schema.json" with { type: "json" };
import assetSchema from "../schemas/asset.schema.json" with { type: "json" };
import chaptersSchema from "../schemas/chapters.schema.json" with { type: "json" };
import chunkSchema from "../schemas/chunk.schema.json" with { type: "json" };
import embeddingSchema from "../schemas/embedding-manifest.schema.json" with { type: "json" };
import localReportSchema from "../schemas/local-report.schema.json" with { type: "json" };
import issueSchema from "../schemas/validation-issue.schema.json" with { type: "json" };
import processingSchema from "../schemas/processing-contract.schema.json" with { type: "json" };
import { preflightZip } from "./zip-safety.js";

const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
for (const schema of [issueSchema, manifestSchema, bookSchema, assetSchema, chaptersSchema, chunkSchema, embeddingSchema, localReportSchema, processingSchema]) ajv.addSchema(schema);
const validators = {
  manifest: ajv.getSchema(manifestSchema.$id), book: ajv.getSchema(bookSchema.$id), asset: ajv.getSchema(assetSchema.$id),
  chapters: ajv.getSchema(chaptersSchema.$id), chunk: ajv.getSchema(chunkSchema.$id),
  embedding: ajv.getSchema(embeddingSchema.$id), localReport: ajv.getSchema(localReportSchema.$id),
  processing: ajv.getSchema(processingSchema.$id),
};
const defaultLimits = { maxEntries: 20_000, maxFileBytes: 128 * 1024 * 1024, maxTotalBytes: 512 * 1024 * 1024, maxCompressionRatio: 200 };

function issue(code, message, extra = {}) {
  return { issue_code: code, severity: "error", stage: "package_inspection", artifact: null, record_id: null, chapter_id: null, page_number: null, message, evidence: null, suggested_action: null, retryable: false, ...extra };
}
function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function validRelativePath(value) {
  if (typeof value !== "string" || !value || value.includes("\\") || value.includes("\0") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value.split("/").every((part) => part && part !== "." && part !== "..");
}
function parseJson(files, filePath, issues, code = "JSON_INVALID") {
  const bytes = files.get(filePath);
  if (!bytes) { issues.push(issue("PACKAGE_FILE_MISSING", "Required package file is missing: " + filePath, { artifact: filePath })); return null; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch (error) { issues.push(issue(code, "Cannot parse JSON file: " + filePath, { artifact: filePath, evidence: { reason: error.message } })); return null; }
}
function checkSchema(validator, value, filePath, issues, code = "SCHEMA_INVALID") {
  if (!validator || !validator(value)) {
    for (const error of validator?.errors || []) issues.push(issue(code, filePath + " " + error.instancePath + " " + error.message, { artifact: filePath, evidence: { keyword: error.keyword, params: error.params } }));
    return false;
  }
  return true;
}
async function readDirectory(root, limits) {
  const files = new Map();
  let total = 0;
  async function visit(current, prefix = "") {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const relative = prefix ? prefix + "/" + entry.name : entry.name;
      if (!validRelativePath(relative)) throw new Error("Package contains an unsafe path: " + relative);
      const full = path.join(current, entry.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error("Package directory contains a symbolic link: " + relative);
      if (entry.isDirectory()) { await visit(full, relative); continue; }
      if (!entry.isFile()) throw new Error("Package contains a non-regular file: " + relative);
      if (stat.size > limits.maxFileBytes) throw new Error("Package file exceeds maximum size: " + relative);
      total += stat.size;
      if (total > limits.maxTotalBytes || files.size >= limits.maxEntries) throw new Error("Package exceeds configured size or file-count limit");
      files.set(relative, new Uint8Array(await readFile(full)));
    }
  }
  await visit(root);
  return files;
}
async function readEntries(inputPath, limits) {
  const stat = await lstat(inputPath);
  if (stat.isSymbolicLink()) throw new Error("Package root cannot be a symbolic link");
  if (stat.isDirectory()) return readDirectory(inputPath, limits);
  if (!stat.isFile()) throw new Error("Package input must be a directory or ZIP file");
  if (stat.size > limits.maxTotalBytes) throw new Error("ZIP file exceeds maximum compressed size");
  return preflightZip(new Uint8Array(await readFile(inputPath)), limits);
}
function requirePrefix(value, prefix, label, issues) {
  if (typeof value === "string" && !value.startsWith(prefix)) issues.push(issue("PACKAGE_PATH_NAMESPACE_INVALID", label + " must be under " + prefix, { artifact: value }));
}
function checkPackagePath(value, label, files, issues, required = true) {
  if (value === null && !required) return;
  if (!validRelativePath(value)) { issues.push(issue("PACKAGE_PATH_INVALID", label + " is not a safe relative path", { artifact: String(value) })); return; }
  if (!files.has(value)) issues.push(issue("PACKAGE_FILE_MISSING", label + " points to a missing file: " + value, { artifact: value }));
}
function validateChapterTree(chapters, issues) {
  const byId = new Map();
  const siblingOrder = new Set();
  for (const chapter of chapters) {
    if (byId.has(chapter.chapter_id)) issues.push(issue("CHAPTER_ID_DUPLICATE", "Duplicate chapter_id: " + chapter.chapter_id, { artifact: "content/chapters.json", chapter_id: chapter.chapter_id }));
    byId.set(chapter.chapter_id, chapter);
    const key = (chapter.parent_chapter_id || "root") + ":" + chapter.order_index;
    if (siblingOrder.has(key)) issues.push(issue("CHAPTER_ORDER_DUPLICATE", "Duplicate chapter order_index among siblings", { artifact: "content/chapters.json", chapter_id: chapter.chapter_id }));
    siblingOrder.add(key);
  }
  for (const chapter of chapters) {
    if (chapter.parent_chapter_id && !byId.has(chapter.parent_chapter_id)) issues.push(issue("CHAPTER_PARENT_MISSING", "Parent chapter does not exist: " + chapter.parent_chapter_id, { artifact: "content/chapters.json", chapter_id: chapter.chapter_id }));
    if (chapter.page_start && chapter.page_end && chapter.page_end < chapter.page_start) issues.push(issue("CHAPTER_PAGE_RANGE_INVALID", "Chapter page_end precedes page_start", { chapter_id: chapter.chapter_id }));
    const seen = new Set([chapter.chapter_id]);
    let parent = chapter.parent_chapter_id;
    while (parent) {
      if (seen.has(parent)) { issues.push(issue("CHAPTER_PARENT_CYCLE", "Chapter parent chain contains a cycle", { chapter_id: chapter.chapter_id })); break; }
      seen.add(parent);
      parent = byId.get(parent)?.parent_chapter_id || null;
    }
  }
}
function validateChunks(files, filePath, chapters, issues) {
  const bytes = files.get(filePath);
  if (!bytes) return [];
  const lines = new TextDecoder("utf-8", { fatal: true }).decode(bytes).split(/\r?\n/);
  const ids = new Set();
  const orderKeys = new Set();
  const chapterMap = new Map(chapters.map((chapter) => [chapter.chapter_id, chapter]));
  const chapterIds = new Set(chapters.map((chapter) => chapter.chapter_id));
  const chunks = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim()) continue;
    let chunk;
    try { chunk = JSON.parse(lines[index]); }
    catch (error) { issues.push(issue("CHUNK_JSON_INVALID", "Invalid JSONL record at line " + (index + 1), { artifact: filePath, record_id: String(index + 1), evidence: { reason: error.message } })); continue; }
    if (!checkSchema(validators.chunk, chunk, filePath + ":" + (index + 1), issues, "CHUNK_SCHEMA_INVALID")) continue;
    if (ids.has(chunk.chunk_id)) issues.push(issue("CHUNK_ID_DUPLICATE", "Duplicate chunk_id: " + chunk.chunk_id, { artifact: filePath, record_id: chunk.chunk_id }));
    ids.add(chunk.chunk_id);
    const orderKey = chunk.chapter_id + ":" + chunk.order_index;
    if (orderKeys.has(orderKey)) issues.push(issue("CHUNK_ORDER_DUPLICATE", "Duplicate chunk order_index within chapter", { artifact: filePath, record_id: chunk.chunk_id, chapter_id: chunk.chapter_id }));
    orderKeys.add(orderKey);
    if (!chapterIds.has(chunk.chapter_id)) issues.push(issue("CHUNK_CHAPTER_MISSING", "Chunk references an unknown chapter", { artifact: filePath, record_id: chunk.chunk_id, chapter_id: chunk.chapter_id }));
    else if (chunk.chapter_title !== chapterMap.get(chunk.chapter_id).title) issues.push(issue("CHUNK_CHAPTER_TITLE_MISMATCH", "Chunk chapter_title does not match chapters.json", { artifact: filePath, record_id: chunk.chunk_id, chapter_id: chunk.chapter_id }));
    if (sha256(Buffer.from(chunk.content, "utf8")) !== chunk.content_sha256.toLowerCase()) issues.push(issue("CHUNK_CONTENT_HASH_MISMATCH", "Chunk content hash does not match", { artifact: filePath, record_id: chunk.chunk_id, chapter_id: chunk.chapter_id }));
    chunks.push(chunk);
  }
  return chunks;
}
function compareMetadata(manifest, book, issues) {
  for (const field of ["title", "language"]) if (manifest.book[field] !== book[field]) issues.push(issue("BOOK_METADATA_MISMATCH", "manifest.book." + field + " does not match content/book.json", { artifact: "content/book.json" }));
  if (JSON.stringify(manifest.book.authors) !== JSON.stringify(book.authors)) issues.push(issue("BOOK_METADATA_MISMATCH", "manifest.book.authors does not match content/book.json", { artifact: "content/book.json" }));
}

export async function validatePackage(inputPath, options = {}) {
  const limits = { ...defaultLimits, ...options };
  const issues = [];
  let files;
  try { files = await readEntries(inputPath, limits); }
  catch (error) { issues.push(issue("PACKAGE_ARCHIVE_UNSAFE", error.message)); return { status: "invalid", summary: { error_count: 1, warning_count: 0 }, counts: null, issues }; }
  const allowedRoots = new Set(["manifest.json", "source", "content", "assets", "embeddings", "validation"]);
  for (const filePath of files.keys()) if (!allowedRoots.has(filePath.split("/")[0])) issues.push(issue("PACKAGE_ROOT_ENTRY_UNEXPECTED", "Unexpected top-level package path: " + filePath, { artifact: filePath }));
  const manifest = parseJson(files, "manifest.json", issues);
  if (!manifest || !checkSchema(validators.manifest, manifest, "manifest.json", issues, "MANIFEST_SCHEMA_INVALID")) return { status: "invalid", summary: { error_count: issues.length, warning_count: 0 }, counts: null, issues };
  requirePrefix(manifest.source.file, "source/", "manifest.source.file", issues);
  requirePrefix(manifest.artifacts.book, "content/", "manifest.artifacts.book", issues);
  requirePrefix(manifest.artifacts.chapters, "content/", "manifest.artifacts.chapters", issues);
  requirePrefix(manifest.artifacts.chunks, "content/", "manifest.artifacts.chunks", issues);
  if (manifest.artifacts.assets) requirePrefix(manifest.artifacts.assets, "content/", "manifest.artifacts.assets", issues);
  if (manifest.artifacts.embeddings) requirePrefix(manifest.artifacts.embeddings, "embeddings/", "manifest.artifacts.embeddings", issues);
  if (manifest.artifacts.local_report) requirePrefix(manifest.artifacts.local_report, "validation/", "manifest.artifacts.local_report", issues);
  for (const [value, label, required] of [
    [manifest.source.file, "manifest.source.file", true], [manifest.artifacts.book, "manifest.artifacts.book", true],
    [manifest.artifacts.chapters, "manifest.artifacts.chapters", true], [manifest.artifacts.chunks, "manifest.artifacts.chunks", true], [manifest.artifacts.assets, "manifest.artifacts.assets", false],
    [manifest.artifacts.embeddings, "manifest.artifacts.embeddings", false], [manifest.artifacts.local_report, "manifest.artifacts.local_report", false],
  ]) checkPackagePath(value, label, files, issues, required);
  if (manifest.source.file && files.has(manifest.source.file)) {
    const source = files.get(manifest.source.file);
    if (source.byteLength !== manifest.source.size_bytes) issues.push(issue("SOURCE_SIZE_MISMATCH", "Original source size does not match manifest", { artifact: manifest.source.file }));
    if (sha256(source) !== manifest.source.sha256.toLowerCase()) issues.push(issue("SOURCE_HASH_MISMATCH", "Original source SHA-256 does not match manifest", { artifact: manifest.source.file }));
    if (path.extname(manifest.source.file).slice(1).toLowerCase() !== manifest.source.format) issues.push(issue("SOURCE_FORMAT_MISMATCH", "Source extension does not match declared format", { artifact: manifest.source.file }));
  }
  const book = parseJson(files, manifest.artifacts.book, issues);
  const chapters = parseJson(files, manifest.artifacts.chapters, issues);
  if (book && checkSchema(validators.book, book, manifest.artifacts.book, issues, "BOOK_SCHEMA_INVALID")) compareMetadata(manifest, book, issues);
  if (chapters && checkSchema(validators.chapters, chapters, manifest.artifacts.chapters, issues, "CHAPTERS_SCHEMA_INVALID")) validateChapterTree(chapters, issues);
  const chunks = chapters ? validateChunks(files, manifest.artifacts.chunks, chapters, issues) : [];
  if (chapters && manifest.counts.chapters !== chapters.length) issues.push(issue("CHAPTER_COUNT_MISMATCH", "manifest chapter count does not match chapters.json"));
  if (manifest.counts.chunks !== chunks.length) issues.push(issue("CHUNK_COUNT_MISMATCH", "manifest chunk count does not match chunks.jsonl"));
  const assetPaths = [...files.keys()].filter((filePath) => filePath.startsWith("assets/") && !filePath.endsWith("/"));
  const assetCount = assetPaths.length;
  if (manifest.artifacts.assets && files.has(manifest.artifacts.assets)) {
    const assets = parseJson(files, manifest.artifacts.assets, issues);
    if (assets && checkSchema(validators.asset, assets, manifest.artifacts.assets, issues, "ASSET_SCHEMA_INVALID")) {
      const assetIds = new Set();
      const declaredPaths = new Set();
      for (const asset of assets) {
        if (!validRelativePath(asset.path) || !asset.path.startsWith("assets/")) {
          issues.push(issue("ASSET_PATH_INVALID", "Asset path must be a safe path under assets/", { artifact: manifest.artifacts.assets, record_id: asset.asset_id }));
          continue;
        }
        if (assetIds.has(asset.asset_id)) issues.push(issue("ASSET_ID_DUPLICATE", "Duplicate asset_id: " + asset.asset_id, { record_id: asset.asset_id }));
        if (declaredPaths.has(asset.path)) issues.push(issue("ASSET_PATH_DUPLICATE", "Duplicate asset path: " + asset.path, { artifact: asset.path }));
        assetIds.add(asset.asset_id);
        declaredPaths.add(asset.path);
        if (!files.has(asset.path)) issues.push(issue("ASSET_FILE_MISSING", "Asset file is missing: " + asset.path, { artifact: asset.path, record_id: asset.asset_id }));
        else {
          const bytes = files.get(asset.path);
          if (bytes.byteLength !== asset.size_bytes) issues.push(issue("ASSET_SIZE_MISMATCH", "Asset size does not match manifest", { artifact: asset.path, record_id: asset.asset_id }));
          if (sha256(bytes) !== asset.sha256.toLowerCase()) issues.push(issue("ASSET_HASH_MISMATCH", "Asset SHA-256 does not match manifest", { artifact: asset.path, record_id: asset.asset_id }));
        }
      }
      for (const assetPath of assetPaths) if (!declaredPaths.has(assetPath)) issues.push(issue("ASSET_UNDECLARED", "Asset file has no descriptor: " + assetPath, { artifact: assetPath }));
      if (assets.length !== assetCount) issues.push(issue("ASSET_DESCRIPTOR_COUNT_MISMATCH", "Asset descriptor count does not match assets/ files"));
    }
  } else if (assetCount > 0) {
    issues.push(issue("ASSET_MANIFEST_MISSING", "assets/ files exist but manifest.artifacts.assets is null or missing"));
  }
  if (manifest.counts.assets !== assetCount) issues.push(issue("ASSET_COUNT_MISMATCH", "manifest asset count does not match assets/ files"));
  if (manifest.artifacts.embeddings && files.has(manifest.artifacts.embeddings)) {
    const embedding = parseJson(files, manifest.artifacts.embeddings, issues);
    if (embedding && checkSchema(validators.embedding, embedding, manifest.artifacts.embeddings, issues, "EMBEDDING_SCHEMA_INVALID")) {
      checkPackagePath(embedding.vector_file, "embedding.vector_file", files, issues);
      requirePrefix(embedding.vector_file, "embeddings/", "embedding.vector_file", issues);
      if (files.has(embedding.vector_file) && sha256(files.get(embedding.vector_file)) !== embedding.sha256.toLowerCase()) issues.push(issue("EMBEDDING_HASH_MISMATCH", "Embedding vector file hash does not match", { artifact: embedding.vector_file }));
      const chunkIds = new Set(chunks.map((chunk) => chunk.chunk_id));
      for (const chunkId of embedding.chunk_ids) if (!chunkIds.has(chunkId)) issues.push(issue("EMBEDDING_CHUNK_MISSING", "Embedding manifest references unknown chunk_id: " + chunkId, { record_id: chunkId }));
    }
  }
  if (manifest.artifacts.local_report && files.has(manifest.artifacts.local_report)) {
    const report = parseJson(files, manifest.artifacts.local_report, issues);
    if (report && checkSchema(validators.localReport, report, manifest.artifacts.local_report, issues, "LOCAL_REPORT_SCHEMA_INVALID")) {
      const reportErrors = report.issues.filter((item) => item.severity === "error").length;
      const reportWarnings = report.issues.filter((item) => item.severity === "warning").length;
      if (report.summary.error_count !== reportErrors || report.summary.warning_count !== reportWarnings) {
        issues.push(issue("LOCAL_REPORT_SUMMARY_MISMATCH", "Local report summary counts do not match its issue list", { artifact: manifest.artifacts.local_report }));
      }
      if (report.overall_status === "valid" && reportErrors > 0) {
        issues.push(issue("LOCAL_REPORT_STATUS_MISMATCH", "Local report cannot be valid while error issues exist", { artifact: manifest.artifacts.local_report }));
      }
    }
  }
  const errorCount = issues.filter((item) => item.severity === "error").length;
  return { status: errorCount ? "invalid" : "valid", summary: { error_count: errorCount, warning_count: issues.filter((item) => item.severity === "warning").length },
    counts: { files: files.size, chapters: chapters?.length ?? 0, chunks: chunks.length, assets: assetCount, total_bytes: [...files.values()].reduce((sum, item) => sum + item.byteLength, 0) },
    package_id: manifest.package_id, issues };
}

export function validateProcessingContract(contract) {
  const issues = [];
  if (!checkSchema(validators.processing, contract, "processing-contract.json", issues, "PROCESSING_CONTRACT_INVALID")) return issues;
  const expectedStages = ["package_inspection","source_verification","metadata_normalization","parse","normalize","structure","chunk","embedding","index_build","quality_check","rights_review","publish"];
  const stages = new Map(contract.stages.map((stage) => [stage.stage, stage]));
  for (const expected of expectedStages) if (!stages.has(expected)) issues.push(issue("PROCESSING_STAGE_MISSING", "Required processing stage is missing: " + expected, { artifact: "processing-contract.json" }));
  for (const stage of contract.stages) {
    if (!stage.retry_scope.includes(stage.stage)) issues.push(issue("PROCESSING_RETRY_SCOPE_INVALID", stage.stage + " retry scope must include itself", { artifact: "processing-contract.json" }));
    for (const dependency of stage.depends_on) if (!stages.has(dependency)) issues.push(issue("PROCESSING_DEPENDENCY_UNKNOWN", stage.stage + " depends on unknown stage " + dependency, { artifact: "processing-contract.json" }));
    for (const target of stage.retry_scope) if (!stages.has(target)) issues.push(issue("PROCESSING_RETRY_SCOPE_UNKNOWN", stage.stage + " retry scope contains unknown stage " + target, { artifact: "processing-contract.json" }));
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(stageName) {
    if (visiting.has(stageName)) { issues.push(issue("PROCESSING_DEPENDENCY_CYCLE", "Processing stage dependency graph contains a cycle at " + stageName, { artifact: "processing-contract.json" })); return; }
    if (visited.has(stageName)) return;
    visiting.add(stageName);
    for (const dependency of stages.get(stageName)?.depends_on || []) if (stages.has(dependency)) visit(dependency);
    visiting.delete(stageName);
    visited.add(stageName);
  }
  for (const stageName of stages.keys()) visit(stageName);
  const revisionStates = new Set(contract.revision_states);
  const attemptStates = new Set(contract.attempt_states);
  for (const transition of contract.revision_transitions) {
    if (!revisionStates.has(transition.from) || !revisionStates.has(transition.to)) issues.push(issue("REVISION_TRANSITION_STATE_UNKNOWN", "Revision transition references an unknown state", { evidence: transition }));
  }
  for (const transition of contract.attempt_transitions) {
    if (!attemptStates.has(transition.from) || !attemptStates.has(transition.to)) issues.push(issue("ATTEMPT_TRANSITION_STATE_UNKNOWN", "Attempt transition references an unknown state", { evidence: transition }));
  }
  const revisionOutgoing = new Set(contract.revision_transitions.map((item) => item.from));
  for (const terminal of ["published","rejected","failed"]) if (revisionOutgoing.has(terminal)) issues.push(issue("REVISION_TERMINAL_STATE_HAS_EXIT", "Terminal revision state must not have outgoing transitions: " + terminal));
  const attemptOutgoing = new Set(contract.attempt_transitions.map((item) => item.from));
  for (const terminal of ["succeeded","failed","cancelled"]) if (attemptOutgoing.has(terminal)) issues.push(issue("ATTEMPT_TERMINAL_STATE_HAS_EXIT", "Terminal attempt state must not have outgoing transitions: " + terminal));
  const requiredGates = ["package_schema_valid","source_integrity_verified","chapter_tree_valid","chunk_references_valid","content_hashes_valid","quality_policy_passed","rights_review_approved"];
  const gateMap = new Map(contract.acceptance_gates.map((gate) => [gate.gate_id, gate]));
  for (const gateId of requiredGates) if (!gateMap.has(gateId)) issues.push(issue("ACCEPTANCE_GATE_MISSING", "Required acceptance gate is missing: " + gateId));
  for (const gate of contract.acceptance_gates) {
    if (requiredGates.includes(gate.gate_id) && !gate.required) issues.push(issue("ACCEPTANCE_GATE_NOT_REQUIRED", "Required gate is marked optional: " + gate.gate_id));
    if (gate.gate_id === "rights_review_approved" && gate.applies_to.includes("accept")) issues.push(issue("RIGHTS_GATE_SCOPE_INVALID", "Rights approval must gate publication, not package acceptance."));
  }
  return issues;
}
