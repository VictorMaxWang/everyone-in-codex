import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

const LOCAL_FILE_SIGNATURE = 0x04034b50;
const CENTRAL_FILE_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxEntries: 20_000,
  maxFileBytes: 384 * 1024 * 1024,
  maxTotalBytes: 2 * 1024 * 1024 * 1024,
});

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function normalizeLimits(value = {}) {
  const result = {};
  for (const [name, fallback] of Object.entries(DEFAULT_LIMITS)) {
    const candidate = value[name] ?? fallback;
    if (!Number.isSafeInteger(candidate) || candidate < 1) throw new Error("zip_limit_invalid");
    result[name] = candidate;
  }
  return Object.freeze(result);
}

function findEndOfCentralDirectory(buffer) {
  const lowerBound = Math.max(0, buffer.length - 65_557);
  for (let offset = buffer.length - 22; offset >= lowerBound; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== END_SIGNATURE) continue;
    const commentLength = buffer.readUInt16LE(offset + 20);
    if (offset + 22 + commentLength === buffer.length) return offset;
  }
  throw new Error("zip_directory_missing");
}

function safeEntryName(rawName, expectedRootName) {
  if (
    !rawName
    || rawName.includes("\0")
    || rawName.includes("\\")
    || rawName.startsWith("/")
    || /^[A-Za-z]:/u.test(rawName)
  ) {
    throw new Error("zip_path_invalid");
  }
  const directory = rawName.endsWith("/");
  const withoutSlash = directory ? rawName.slice(0, -1) : rawName;
  const segments = withoutSlash.split("/");
  if (
    segments.length === 0
    || segments[0] !== expectedRootName
    || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))
  ) {
    throw new Error("zip_path_invalid");
  }
  return Object.freeze({
    rawName,
    relativePath: segments.slice(1).join(path.sep),
    directory,
  });
}

function parseEntries(buffer, expectedRootName, limits) {
  const endOffset = findEndOfCentralDirectory(buffer);
  const disk = buffer.readUInt16LE(endOffset + 4);
  const centralDisk = buffer.readUInt16LE(endOffset + 6);
  const entriesOnDisk = buffer.readUInt16LE(endOffset + 8);
  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    disk !== 0
    || centralDisk !== 0
    || entriesOnDisk !== entryCount
    || entryCount === 0xffff
    || centralSize === 0xffffffff
    || centralOffset === 0xffffffff
    || entryCount > limits.maxEntries
    || centralOffset + centralSize > endOffset
  ) {
    throw new Error(entryCount > limits.maxEntries ? "zip_entry_limit" : "zip_directory_invalid");
  }

  const entries = [];
  const names = new Set();
  let cursor = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (cursor + 46 > endOffset || buffer.readUInt32LE(cursor) !== CENTRAL_FILE_SIGNATURE) {
      throw new Error("zip_directory_invalid");
    }
    const versionMadeBy = buffer.readUInt16LE(cursor + 4);
    const flags = buffer.readUInt16LE(cursor + 8);
    const compression = buffer.readUInt16LE(cursor + 10);
    const checksum = buffer.readUInt32LE(cursor + 16);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const diskStart = buffer.readUInt16LE(cursor + 34);
    const externalAttributes = buffer.readUInt32LE(cursor + 38);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > endOffset || diskStart !== 0 || [compressedSize, uncompressedSize, localOffset].includes(0xffffffff)) {
      throw new Error("zip_directory_invalid");
    }
    if ((flags & 0x0001) !== 0 || (flags & ~(0x0008 | 0x0800)) !== 0) {
      throw new Error("zip_flags_unsupported");
    }
    if (compression !== 0 && compression !== 8) throw new Error("zip_compression_unsupported");
    const rawName = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);
    const name = safeEntryName(rawName, expectedRootName);
    const nameKey = rawName.toLowerCase();
    if (names.has(nameKey)) throw new Error("zip_entry_duplicate");
    names.add(nameKey);

    const unixMode = (externalAttributes >>> 16) & 0xffff;
    const fileType = unixMode & 0o170000;
    if (fileType === 0o120000) throw new Error("zip_link_forbidden");
    if (fileType !== 0 && fileType !== 0o040000 && fileType !== 0o100000) {
      throw new Error("zip_special_file_forbidden");
    }
    if (name.directory !== (fileType === 0o040000 || rawName.endsWith("/"))) {
      throw new Error("zip_entry_type_invalid");
    }
    if (!name.directory) {
      if (uncompressedSize > limits.maxFileBytes) throw new Error("zip_file_limit");
      totalBytes += uncompressedSize;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > limits.maxTotalBytes) {
        throw new Error("zip_total_limit");
      }
    }
    entries.push(Object.freeze({
      ...name,
      checksum,
      compressedSize,
      uncompressedSize,
      compression,
      localOffset,
    }));
    cursor = next;
  }
  if (cursor !== centralOffset + centralSize) throw new Error("zip_directory_invalid");
  return Object.freeze({ entries: Object.freeze(entries), totalBytes });
}

function inflateEntry(buffer, entry, limits) {
  if (entry.localOffset + 30 > buffer.length || buffer.readUInt32LE(entry.localOffset) !== LOCAL_FILE_SIGNATURE) {
    throw new Error("zip_local_header_invalid");
  }
  const localFlags = buffer.readUInt16LE(entry.localOffset + 6);
  const localCompression = buffer.readUInt16LE(entry.localOffset + 8);
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const nameStart = entry.localOffset + 30;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (
    localFlags !== (localFlags & (0x0008 | 0x0800))
    || localCompression !== entry.compression
    || dataEnd > buffer.length
    || buffer.toString("utf8", nameStart, nameStart + nameLength) !== entry.rawName
  ) {
    throw new Error("zip_local_header_invalid");
  }
  const compressed = buffer.subarray(dataStart, dataEnd);
  let output;
  try {
    output = entry.compression === 0
      ? Buffer.from(compressed)
      : inflateRawSync(compressed, { maxOutputLength: limits.maxFileBytes });
  } catch (error) {
    throw new Error("zip_inflate_failed", { cause: error });
  }
  if (output.length !== entry.uncompressedSize || crc32(output) !== entry.checksum) {
    throw new Error("zip_entry_integrity_failed");
  }
  return output;
}

async function assertRealDirectory(directoryPath) {
  const info = await lstat(directoryPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("zip_destination_invalid");
}

/**
 * 在一个全新的 staging 目录中安全展开 ZIP。路径、条目类型和展开上限全部先验证，
 * 任何失败都会只清理由本次调用创建的精确目录。
 */
export async function extractVerifiedZip({
  archivePath,
  destinationRoot,
  expectedRootName,
  limits: limitOverrides,
} = {}) {
  if (
    typeof archivePath !== "string"
    || !path.isAbsolute(archivePath)
    || typeof destinationRoot !== "string"
    || !path.isAbsolute(destinationRoot)
    || typeof expectedRootName !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/u.test(expectedRootName)
  ) {
    throw new Error("zip_input_invalid");
  }
  const limits = normalizeLimits(limitOverrides);
  const archiveInfo = await lstat(archivePath);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > limits.maxArchiveBytes) {
    throw new Error("zip_archive_invalid");
  }
  const resolvedDestination = path.resolve(destinationRoot);
  const parent = path.dirname(resolvedDestination);
  if (resolvedDestination === parent || path.parse(resolvedDestination).root === resolvedDestination) {
    throw new Error("zip_destination_invalid");
  }
  const buffer = await readFile(archivePath);
  const parsed = parseEntries(buffer, expectedRootName, limits);
  let created = false;
  try {
    await mkdir(resolvedDestination, { recursive: false });
    created = true;
    await assertRealDirectory(resolvedDestination);
    const rootPath = path.join(resolvedDestination, expectedRootName);
    await mkdir(rootPath, { recursive: false });
    await assertRealDirectory(rootPath);
    let fileCount = 0;
    for (const entry of parsed.entries) {
      if (!entry.relativePath) continue;
      const target = path.join(rootPath, entry.relativePath);
      const relative = path.relative(rootPath, target);
      if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("zip_path_invalid");
      if (entry.directory) {
        await mkdir(target, { recursive: true });
        await assertRealDirectory(target);
        continue;
      }
      await mkdir(path.dirname(target), { recursive: true });
      await assertRealDirectory(path.dirname(target));
      const handle = await open(target, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
      try {
        await handle.writeFile(inflateEntry(buffer, entry, limits));
      } finally {
        await handle.close();
      }
      fileCount += 1;
    }
    return Object.freeze({ rootPath, fileCount, totalBytes: parsed.totalBytes });
  } catch (error) {
    if (created) {
      // resolvedDestination 已验证为非根路径，且只可能由本次调用创建。
      await rm(resolvedDestination, { recursive: true, force: true }).catch(() => {});
    }
    throw error;
  }
}
