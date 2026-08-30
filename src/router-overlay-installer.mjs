import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { verifyRouterOverlay } from "./router-overlay-verifier.mjs";

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
  patchPath = path.join(MODULE_ROOT, "patches", "router", "0001-custom-connections.patch"),
  runGit = (args) => execFileAsync("git", args, { windowsHide: true, encoding: "utf8" }),
} = {}) {
  if (![routerRoot, backupDirectory, lockPath, patchPath].every(path.isAbsolute)) {
    throw new Error("router_overlay_prepare_path_invalid");
  }
  try {
    const verified = await verifyRouterOverlay({ routerRoot, lockPath });
    return Object.freeze({ prepared: true, alreadyPatched: true, ...verified });
  } catch (error) {
    if (!String(error?.message).startsWith("router_overlay_mismatch:")) throw error;
  }

  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const actualPatchSha256 = createHash("sha256").update(await readFile(patchPath)).digest("hex");
  if (!HASH.test(lock.patchSha256 ?? "") || actualPatchSha256 !== lock.patchSha256) {
    throw new Error("router_overlay_patch_digest_mismatch");
  }
  const files = lock.managedFiles;
  if (
    !Array.isArray(files)
    || typeof lock.baselineFileSha256 !== "object"
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
    patchSha256: lock.patchSha256,
    files,
  }, null, 2)}\n`, { flag: "wx" });

  const prefix = ["-C", path.resolve(routerRoot), "apply"];
  await runGit([...prefix, "--check", "--whitespace=error-all", "--", patchPath]);
  await runGit([...prefix, "--whitespace=error-all", "--", patchPath]);
  const verified = await verifyRouterOverlay({ routerRoot, lockPath });
  return Object.freeze({
    prepared: true,
    alreadyPatched: false,
    backupDirectory,
    ...verified,
  });
}
