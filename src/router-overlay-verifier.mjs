import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = /^[a-f0-9]{64}$/u;

function within(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function parseManagedManifest(text) {
  const files = [];
  const hashes = {};
  const keys = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})  ([^\\\r\n]+)$/u.exec(line);
    if (!match || match[2].split("/").some((part) => !part || part === "." || part === "..")) {
      throw new Error("router_overlay_lock_invalid");
    }
    const key = match[2].toLowerCase();
    if (keys.has(key)) throw new Error("router_overlay_lock_invalid");
    keys.add(key);
    files.push(match[2]);
    hashes[match[2]] = match[1];
  }
  return { files, hashes };
}

async function managedFilesFromLock(lock, lockPath) {
  if (lock?.schemaVersion === 1) {
    return { files: lock.managedFiles, hashes: lock.managedFileSha256 };
  }
  const descriptor = lock?.managedManifest;
  if (
    lock?.schemaVersion !== 2
    || typeof descriptor?.file !== "string"
    || path.basename(descriptor.file) !== descriptor.file
    || !HASH.test(descriptor.sha256 ?? "")
    || !Number.isSafeInteger(descriptor.fileCount)
    || descriptor.fileCount < 1
  ) {
    throw new Error("router_overlay_lock_invalid");
  }
  const manifestPath = path.join(path.dirname(lockPath), descriptor.file);
  const bytes = await readFile(manifestPath);
  if (createHash("sha256").update(bytes).digest("hex") !== descriptor.sha256) {
    throw new Error("router_overlay_lock_invalid");
  }
  const parsed = parseManagedManifest(bytes.toString("utf8"));
  if (parsed.files.length !== descriptor.fileCount) throw new Error("router_overlay_lock_invalid");
  return parsed;
}

export async function readRouterOverlayLock(lockPath) {
  if (typeof lockPath !== "string" || !path.isAbsolute(lockPath)) {
    throw new Error("router_overlay_lock_invalid");
  }
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const managed = await managedFilesFromLock(lock, lockPath);
  return Object.freeze({ lock, files: Object.freeze(managed.files), hashes: Object.freeze(managed.hashes) });
}

/** Router 只有在完整生产 patch 的全部管理文件逐字节匹配时才视为可复用。 */
export async function verifyRouterOverlay({
  routerRoot,
  lockPath = path.join(MODULE_ROOT, "locks", "router-v030.lock.json"),
} = {}) {
  if (!path.isAbsolute(routerRoot) || !path.isAbsolute(lockPath)) {
    throw new Error("router_overlay_path_invalid");
  }
  const { files, hashes } = await readRouterOverlayLock(lockPath);
  const managed = { files, hashes };
  if (!Array.isArray(managed.files) || typeof managed.hashes !== "object") {
    throw new Error("router_overlay_lock_invalid");
  }
  const root = path.resolve(routerRoot);
  for (const relative of managed.files) {
    const expected = managed.hashes[relative];
    const candidate = path.resolve(root, relative);
    if (typeof relative !== "string" || !within(candidate, root) || !HASH.test(expected ?? "")) {
      throw new Error("router_overlay_lock_invalid");
    }
    const info = await lstat(candidate).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) {
      throw new Error(`router_overlay_mismatch:${relative}`);
    }
    const actual = createHash("sha256").update(await readFile(candidate)).digest("hex");
    if (actual !== expected) throw new Error(`router_overlay_mismatch:${relative}`);
  }
  return Object.freeze({ verified: true, managedFiles: managed.files.length });
}
