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

/** Connections 只在本机 Router 管理文件与锁定 cohort 完全一致时启用。 */
export async function verifyRouterOverlay({
  routerRoot,
  lockPath = path.join(MODULE_ROOT, "locks", "router-v030.lock.json"),
} = {}) {
  if (!path.isAbsolute(routerRoot) || !path.isAbsolute(lockPath)) {
    throw new Error("router_overlay_path_invalid");
  }
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  if (
    lock?.schemaVersion !== 1
    || !Array.isArray(lock.managedFiles)
    || typeof lock.managedFileSha256 !== "object"
  ) {
    throw new Error("router_overlay_lock_invalid");
  }
  const root = path.resolve(routerRoot);
  for (const relative of lock.managedFiles) {
    const expected = lock.managedFileSha256[relative];
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
  return Object.freeze({ verified: true, managedFiles: lock.managedFiles.length });
}
