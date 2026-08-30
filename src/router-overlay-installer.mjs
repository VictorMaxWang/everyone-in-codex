import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { readRouterOverlayLock, verifyRouterOverlay } from "./router-overlay-verifier.mjs";

const execFileAsync = promisify(execFile);
const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = /^[a-f0-9]{64}$/u;

async function digestOrNull(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) return "invalid";
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** 仅对 lock 精确识别的 pre-v0.3 cohort 应用 Router patch。 */
export async function prepareRouterOverlay({
  routerRoot,
  backupDirectory,
  lockPath = path.join(MODULE_ROOT, "locks", "router-v030.lock.json"),
  patchPath,
  patchRoot = path.join(MODULE_ROOT, "patches", "router"),
  runGit = (args) => execFileAsync("git", args, { windowsHide: true, encoding: "utf8" }),
} = {}) {
  if (![routerRoot, backupDirectory, lockPath, patchRoot].every(path.isAbsolute)
    || (patchPath !== undefined && !path.isAbsolute(patchPath))) {
    throw new Error("router_overlay_prepare_path_invalid");
  }
  try {
    const verified = await verifyRouterOverlay({ routerRoot, lockPath });
    return Object.freeze({ prepared: true, alreadyPatched: true, ...verified });
  } catch (error) {
    if (!String(error?.message).startsWith("router_overlay_mismatch:")) throw error;
  }

  const { lock, files } = await readRouterOverlayLock(lockPath);
  let patchSeries;
  if (lock.schemaVersion === 1) {
    const legacyPatch = patchPath ?? path.join(patchRoot, "0001-custom-connections.patch");
    const actualPatchSha256 = createHash("sha256").update(await readFile(legacyPatch)).digest("hex");
    if (!HASH.test(lock.patchSha256 ?? "") || actualPatchSha256 !== lock.patchSha256) {
      throw new Error("router_overlay_patch_digest_mismatch");
    }
    if (
      typeof lock.baselineFileSha256 !== "object"
      || files.some((file) => {
        const expected = lock.baselineFileSha256[file];
        return expected !== null && !HASH.test(expected ?? "");
      })
    ) {
      throw new Error("router_overlay_lock_invalid");
    }
    for (const relative of files) {
      const actual = await digestOrNull(path.resolve(routerRoot, relative));
      if (actual !== lock.baselineFileSha256[relative]) {
        throw new Error(`router_overlay_unknown_tree:${relative}`);
      }
    }
    patchSeries = [{ path: legacyPatch, sha256: lock.patchSha256 }];
  } else {
    if (
      lock.schemaVersion !== 2
      || !Array.isArray(lock.patchSeries)
      || lock.patchSeries.length === 0
      || !/^[a-f0-9]{40}$/u.test(lock.upstreamCommit ?? "")
      || !/^[a-f0-9]{40}$/u.test(lock.baselineTree ?? "")
    ) {
      throw new Error("router_overlay_lock_invalid");
    }
    patchSeries = [];
    for (const entry of lock.patchSeries) {
      if (typeof entry?.file !== "string" || path.basename(entry.file) !== entry.file
        || !entry.file.endsWith(".patch") || !HASH.test(entry.sha256 ?? "")) {
        throw new Error("router_overlay_lock_invalid");
      }
      const candidate = path.join(patchRoot, entry.file);
      const actual = createHash("sha256").update(await readFile(candidate)).digest("hex");
      if (actual !== entry.sha256) throw new Error("router_overlay_patch_digest_mismatch");
      patchSeries.push({ path: candidate, sha256: entry.sha256 });
    }
    const gitText = async (args) => {
      const result = await runGit(args);
      return typeof result === "string" ? result : String(result?.stdout ?? "");
    };
    const prefix = ["-C", path.resolve(routerRoot)];
    const [head, tree, status] = await Promise.all([
      gitText([...prefix, "rev-parse", "HEAD"]),
      gitText([...prefix, "rev-parse", "HEAD^{tree}"]),
      gitText([...prefix, "status", "--porcelain", "--untracked-files=normal"]),
    ]);
    if (
      head.trim() !== lock.upstreamCommit
      || tree.trim() !== lock.baselineTree
      || status.trim() !== ""
    ) {
      throw new Error("router_overlay_unknown_tree");
    }
  }

  const existingBackup = await lstat(backupDirectory).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (existingBackup) throw new Error("router_overlay_backup_exists");
  await mkdir(backupDirectory, { recursive: false });
  for (const relative of files) {
    const source = path.resolve(routerRoot, relative);
    if ((await digestOrNull(source)) === null) continue;
    const target = path.join(backupDirectory, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target);
  }
  await writeFile(path.join(backupDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: 1,
    routerRoot: path.resolve(routerRoot),
    baselineTree: lock.baselineTree,
    patchSeries: patchSeries.map(({ sha256 }) => sha256),
    files,
  }, null, 2)}\n`, { flag: "wx" });

  const prefix = ["-C", path.resolve(routerRoot), "apply"];
  for (const entry of patchSeries) {
    await runGit([...prefix, "--check", "--whitespace=error-all", "--", entry.path]);
    await runGit([...prefix, "--whitespace=error-all", "--", entry.path]);
  }
  const verified = await verifyRouterOverlay({ routerRoot, lockPath });
  return Object.freeze({
    prepared: true,
    alreadyPatched: false,
    backupDirectory,
    ...verified,
  });
}
