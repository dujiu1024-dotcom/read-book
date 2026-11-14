import { unzipSync } from "fflate";

function safeArchivePath(name) {
  if (typeof name !== "string" || !name || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
    throw new Error("ZIP contains an absolute or malformed path");
  }
  const trimmed = name.endsWith("/") ? name.slice(0, -1) : name;
  const segments = trimmed.split("/");
  if (!trimmed || segments.some((part) => !part || part === "." || part === "..")) {
    throw new Error("ZIP contains a path traversal or empty path segment");
  }
  return trimmed;
}

export function preflightZip(input, limits = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const maxEntries = limits.maxEntries ?? 20_000;
  const maxFileBytes = limits.maxFileBytes ?? 128 * 1024 * 1024;
  const maxTotalBytes = limits.maxTotalBytes ?? 512 * 1024 * 1024;
  const maxCompressionRatio = limits.maxCompressionRatio ?? 200;
  const minimum = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= minimum; offset -= 1) {
    if (new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("ZIP end-of-central-directory record is missing");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const disk = view.getUint16(eocd + 4, true);
  const centralDisk = view.getUint16(eocd + 6, true);
  const diskEntries = view.getUint16(eocd + 8, true);
  const entryCount = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || centralDisk !== 0 || diskEntries !== entryCount) throw new Error("Multi-disk ZIP archives are not supported");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) throw new Error("ZIP64 archives are not supported by this validator");
  if (entryCount > maxEntries || centralOffset + centralSize > eocd) throw new Error("ZIP central directory exceeds configured limits or is malformed");
  const seen = new Set();
  const metadata = [];
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > centralOffset + centralSize || view.getUint32(cursor, true) !== 0x02014b50) throw new Error("ZIP central directory entry is malformed");
    const madeBy = view.getUint16(cursor + 4, true) >>> 8;
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    const entryEnd = cursor + 46 + nameLength + extraLength + commentLength;
    if (entryEnd > centralOffset + centralSize) throw new Error("ZIP entry metadata exceeds central directory");
    const name = new TextDecoder("utf-8", { fatal: true }).decode(bytes.slice(cursor + 46, cursor + 46 + nameLength));
    const path = safeArchivePath(name);
    const directory = name.endsWith("/");
    const folded = path.toLocaleLowerCase("en-US");
    if (seen.has(folded)) throw new Error("ZIP contains duplicate or case-colliding paths: " + path);
    seen.add(folded);
    if ((flags & 1) !== 0) throw new Error("Encrypted ZIP entries are not accepted");
    if (![0, 8].includes(method)) throw new Error("ZIP compression method is not supported");
    const unixMode = externalAttributes >>> 16;
    if (madeBy === 3 && (unixMode & 0o170000) === 0o120000) throw new Error("ZIP symbolic links are not accepted");
    if (!directory && uncompressedSize > maxFileBytes) throw new Error("ZIP entry exceeds maximum file size: " + path);
    if (!directory && uncompressedSize > 0 && uncompressedSize / Math.max(compressedSize, 1) > maxCompressionRatio) throw new Error("ZIP entry exceeds maximum compression ratio: " + path);
    if (!directory) totalBytes += uncompressedSize;
    if (totalBytes > maxTotalBytes) throw new Error("ZIP exceeds maximum total uncompressed size");
    metadata.push({ path, directory, uncompressedSize });
    cursor = entryEnd;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("ZIP central directory size does not match its entries");
  const extracted = unzipSync(bytes);
  const files = new Map();
  for (const entry of metadata) {
    if (entry.directory) continue;
    const content = extracted[entry.path];
    if (!(content instanceof Uint8Array) || content.byteLength !== entry.uncompressedSize) throw new Error("ZIP entry failed integrity/size verification: " + entry.path);
    files.set(entry.path, content);
  }
  return files;
}
