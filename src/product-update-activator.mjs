import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { ProductVersionStore } from "./product-state.mjs";

const execFileAsync = promisify(execFile);
const LEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

function safeEnvironment(source = process.env) {
  const allowed = [
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "LOCALAPPDATA",
    "TEMP", "TMP", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)",
  ];
  return Object.fromEntries(allowed.flatMap((name) => source[name] ? [[name, source[name]]] : []));
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function parseRequest(value, requestPath) {
  if (
    value?.schemaVersion !== 1
    || typeof value.productRoot !== "string"
    || !path.isAbsolute(value.productRoot)
    || typeof value.currentPackageRoot !== "string"
    || !path.isAbsolute(value.currentPackageRoot)
    || typeof value.configPath !== "string"
    || !path.isAbsolute(value.configPath)
    || !Number.isSafeInteger(value.launcherPid)
    || value.launcherPid < 1
    || !LEASE_PATTERN.test(value.leaseId ?? "")
    || !new Set(["auto", "manual"]).has(value.mode)
  ) {
    throw new Error("product_activation_request_invalid");
  }
  const productRoot = path.resolve(value.productRoot);
  const expectedRequest = path.join(productRoot, "updates", "activation-request.json");
  if (path.resolve(requestPath) !== expectedRequest) throw new Error("product_activation_request_path_invalid");
  return Object.freeze({ ...value, productRoot });
}

async function cleanupLauncherSignal(signal) {
  if (!signal || typeof signal !== "object") return;
  const paths = [signal.lockPath, signal.helperPath, signal.requestPath, signal.statusPath];
  if (paths.some((candidate) => typeof candidate !== "string" || !path.isAbsolute(candidate))) return;
  try {
    const lock = JSON.parse(await readFile(signal.lockPath, "utf8"));
    if (path.resolve(lock.statusPath ?? "") !== path.resolve(signal.statusPath)) return;
  } catch {
    return;
  }
  for (const candidate of paths) await unlink(candidate).catch(() => {});
  if (typeof signal.operationRoot === "string" && path.isAbsolute(signal.operationRoot)) {
    await rmdir(signal.operationRoot).catch(() => {});
  }
}

async function waitForProcessExit(pid, { processAlive, pollIntervalMs, maxWaitMs }) {
  const deadline = Date.now() + maxWaitMs;
  while (processAlive(pid)) {
    if (Date.now() >= deadline) throw new Error("product_activation_wait_timeout");
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

function defaultProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function defaultRunRestore(request, sourceEnvironment) {
  const nodePath = path.join(request.currentPackageRoot, "runtime", "node", "node.exe");
  const cliPath = path.join(request.currentPackageRoot, "src", "cli.mjs");
  await execFileAsync(nodePath, [cliPath, "restore", "--lease", request.leaseId], {
    windowsHide: true,
    timeout: 120_000,
    env: {
      ...safeEnvironment(sourceEnvironment),
      EVERYONE_CODEX_CONFIG: request.configPath,
      EVERYONE_CODEX_ROOT: request.currentPackageRoot,
    },
  });
}

function defaultRelaunch(request, spawnImpl, sourceEnvironment) {
  const launcher = path.join(request.productRoot, "bin", "product-launcher.ps1");
  const child = spawnImpl("powershell.exe", [
    "-NoLogo", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "launch",
  ], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: safeEnvironment(sourceEnvironment),
  });
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error("product_relaunch_failed");
  child.unref?.();
  return child.pid;
}

/**
 * 等待当前 CodexHost Launcher 精确退出，再恢复旧 Fusion lease 并切换活动产品指针。
 * helper 自身不持有 Router、OAuth 或 Harness 凭据。
 */
export async function activateProductUpdate({
  requestPath,
  processAlive = defaultProcessAlive,
  runRestore = defaultRunRestore,
  spawnImpl = spawn,
  sourceEnvironment = process.env,
  pollIntervalMs = 1_000,
  maxWaitMs = 7 * 24 * 60 * 60 * 1_000,
} = {}) {
  if (typeof requestPath !== "string" || !path.isAbsolute(requestPath)) {
    throw new Error("product_activation_request_path_invalid");
  }
  let request = parseRequest(JSON.parse(await readFile(requestPath, "utf8")), requestPath);
  await waitForProcessExit(request.launcherPid, { processAlive, pollIntervalMs, maxWaitMs });
  // 用户可能在等待期间点击“立即安装”，因此退出后重新读取 mode。
  request = parseRequest(JSON.parse(await readFile(requestPath, "utf8")), requestPath);
  const lockPath = path.join(request.productRoot, "updates", "activation.lock");
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") return Object.freeze({ activated: false, reason: "already_active" });
    throw error;
  }
  const statusPath = path.join(request.productRoot, "updates", "status-v1.json");
  try {
    await runRestore(request, sourceEnvironment);
    const store = new ProductVersionStore({ productRoot: request.productRoot });
    await store.activatePending(request.record);
    let relaunchedPid = null;
    if (request.mode === "manual") {
      await writeJsonAtomic(statusPath, {
        schemaVersion: 1,
        version: request.record.version,
        phase: "restarting",
        updatedAt: Date.now(),
        error: null,
        record: request.record,
      });
      relaunchedPid = defaultRelaunch(request, spawnImpl, sourceEnvironment);
    } else {
      await writeJsonAtomic(statusPath, {
        schemaVersion: 1,
        version: request.record.version,
        phase: "succeeded",
        updatedAt: Date.now(),
        error: null,
        record: request.record,
      });
    }
    return Object.freeze({ activated: true, mode: request.mode, relaunchedPid });
  } catch (error) {
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      version: request.record?.version ?? "0.0.0",
      phase: "failed",
      updatedAt: Date.now(),
      error: String(error?.message ?? error).slice(0, 500),
    }).catch(() => {});
    throw error;
  } finally {
    await cleanupLauncherSignal(request.launcherSignal);
    await lock.close().catch(() => {});
    await unlink(lockPath).catch(() => {});
    await unlink(path.join(request.productRoot, "updates", "activator-state.json")).catch(() => {});
  }
}

function parseArguments(argv) {
  if (argv.length !== 2 || argv[0] !== "--request" || !path.isAbsolute(argv[1])) {
    throw new Error("product_activator_arguments_invalid");
  }
  return argv[1];
}

async function main() {
  try {
    await activateProductUpdate({ requestPath: parseArguments(process.argv.slice(2)) });
    return 0;
  } catch {
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
