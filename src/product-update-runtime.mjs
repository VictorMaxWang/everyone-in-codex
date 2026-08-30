import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rmdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PRODUCT_RELEASE_REPOSITORY,
  parseProductDistributionManifest,
  parseSha256Sums,
  parseStableProductRelease,
} from "./product-distribution.mjs";
import { extractVerifiedZip } from "./safe-zip.mjs";

const GITHUB_API_ORIGIN = "https://api.github.com";
const ALLOWED_ASSET_HOSTS = new Set([
  "github.com",
  "release-assets.githubusercontent.com",
  "objects.githubusercontent.com",
]);
const TEXT_RESPONSE_LIMIT = 2 * 1024 * 1024;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function boundedJson(response) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > TEXT_RESPONSE_LIMIT) {
    throw new Error("product_update_response_too_large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > TEXT_RESPONSE_LIMIT) {
    throw new Error("product_update_response_too_large");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error("product_update_response_invalid", { cause: error });
  }
}

async function githubJson(fetchImpl, url, signal) {
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "error",
    signal,
    headers: {
      accept: "application/vnd.github+json",
      "user-agent": "everyone-in-codex-updater",
      "x-github-api-version": "2022-11-28",
    },
  });
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("product_update_rate_limited");
  }
  if (!response.ok) throw new Error(`product_update_api_failed:${response.status}`);
  return boundedJson(response);
}

async function resolveReleaseCommit(fetchImpl, tag, signal) {
  let object = (await githubJson(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/repos/${PRODUCT_RELEASE_REPOSITORY}/git/ref/tags/${encodeURIComponent(tag)}`,
    signal,
  ))?.object;
  for (let depth = 0; depth < 3; depth += 1) {
    if (object?.type === "commit" && /^[a-f0-9]{40}$/u.test(object.sha ?? "")) return object.sha;
    if (
      object?.type !== "tag"
      || typeof object.url !== "string"
      || !object.url.startsWith(`${GITHUB_API_ORIGIN}/repos/${PRODUCT_RELEASE_REPOSITORY}/git/tags/`)
    ) {
      break;
    }
    object = (await githubJson(fetchImpl, object.url, signal))?.object;
  }
  throw new Error("product_update_tag_commit_invalid");
}

/** 只查询 Everyone in Codex 的 latest stable Release，并把 tag 解析到精确 commit。 */
export async function fetchLatestProductRelease({
  fetchImpl = globalThis.fetch,
  signal = AbortSignal.timeout(15_000),
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("product_update_fetch_invalid");
  const raw = await githubJson(
    fetchImpl,
    `${GITHUB_API_ORIGIN}/repos/${PRODUCT_RELEASE_REPOSITORY}/releases/latest`,
    signal,
  );
  const release = parseStableProductRelease(raw);
  const sourceCommit = await resolveReleaseCommit(fetchImpl, release.tag, signal);
  return Object.freeze({ ...release, sourceCommit });
}

function allowedAssetUrl(value, redirected = false) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("product_update_download_redirect_invalid");
  }
  if (
    url.protocol !== "https:"
    || !ALLOWED_ASSET_HOSTS.has(url.hostname)
    || url.username
    || url.password
    || url.hash
    || (!redirected && (url.search || url.hostname !== "github.com"))
  ) {
    throw new Error("product_update_download_redirect_invalid");
  }
  return url;
}

async function downloadReleaseAsset({ fetchImpl, asset, destination, onChunk }) {
  let url = allowedAssetUrl(asset.url);
  let response;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    response = await fetchImpl(url, {
      method: "GET",
      redirect: "manual",
      headers: { accept: "application/octet-stream", "user-agent": "everyone-in-codex-updater" },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirectCount === 5) throw new Error("product_update_download_redirect_invalid");
      url = allowedAssetUrl(new URL(location, url).href, true);
      continue;
    }
    break;
  }
  if (response.status === 429 || (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")) {
    throw new Error("product_update_rate_limited");
  }
  if (!response.ok || !response.body) throw new Error(`product_update_download_failed:${response.status}`);
  const handle = await open(destination, "wx", 0o600);
  const digest = createHash("sha256");
  let received = 0;
  try {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      received += chunk.length;
      if (received > asset.size) throw new Error("product_update_download_size_mismatch");
      digest.update(chunk);
      await handle.write(chunk);
      onChunk?.(chunk.length);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
  if (received !== asset.size || digest.digest("hex") !== asset.digest) {
    await unlink(destination).catch(() => {});
    throw new Error("product_update_download_integrity_failed");
  }
  return Object.freeze({ path: destination, bytes: received, digest: asset.digest });
}

function parseRuntimeManifest(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 16 * 1024 * 1024) {
    throw new Error("runtime_manifest_invalid");
  }
  const entries = new Map();
  const keys = new Set();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})  ([^\\\r\n]+)$/u.exec(line);
    if (!match) throw new Error("runtime_manifest_invalid");
    const relativePath = match[2];
    const segments = relativePath.split("/");
    if (
      path.isAbsolute(relativePath)
      || segments.some((segment) => !segment || segment === "." || segment === ".." || segment.includes(":"))
      || new Set(["MANIFEST.sha256", "product-distribution.json"]).has(relativePath)
    ) {
      throw new Error("runtime_manifest_path_invalid");
    }
    const key = relativePath.toLowerCase();
    if (keys.has(key)) throw new Error("runtime_manifest_duplicate");
    keys.add(key);
    entries.set(relativePath, match[1]);
  }
  if (entries.size === 0) throw new Error("runtime_manifest_invalid");
  return entries;
}

async function listReleaseFiles(rootPath, current = rootPath, result = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error("runtime_manifest_link_forbidden");
    if (entry.isDirectory()) {
      await listReleaseFiles(rootPath, absolute, result);
    } else if (entry.isFile()) {
      const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
      if (!new Set(["MANIFEST.sha256", "product-distribution.json"]).has(relative)) {
        result.push(Object.freeze({ absolute, relative }));
      }
    } else {
      throw new Error("runtime_manifest_special_file_forbidden");
    }
  }
  return result;
}

/** 完整文件 manifest 既校验每个摘要，也拒绝未列出的额外运行文件。 */
export async function verifyRuntimeManifest(rootPath, manifestText) {
  const entries = parseRuntimeManifest(manifestText);
  const files = await listReleaseFiles(rootPath);
  if (files.length !== entries.size) throw new Error("runtime_manifest_file_set_mismatch");
  for (const file of files) {
    const expected = entries.get(file.relative);
    if (!expected || sha256(await readFile(file.absolute)) !== expected) {
      throw new Error("runtime_manifest_integrity_failed");
    }
  }
  return Object.freeze({ fileCount: files.length });
}

async function existingVersionRecord({ versionsRoot, directory, release, digest }) {
  const target = path.join(versionsRoot, directory);
  try {
    const info = await lstat(target);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("product_version_target_invalid");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const manifestText = await readFile(path.join(target, "MANIFEST.sha256"), "utf8");
  const manifest = parseProductDistributionManifest(
    JSON.parse(await readFile(path.join(target, "product-distribution.json"), "utf8")),
  );
  if (
    manifest.version !== release.version
    || manifest.sourceCommit !== release.sourceCommit
    || manifest.runtimeManifestSha256 !== sha256(Buffer.from(manifestText, "utf8"))
  ) {
    throw new Error("product_version_target_conflict");
  }
  await verifyRuntimeManifest(target, manifestText);
  return Object.freeze({
    version: release.version,
    directory,
    digest,
    sourceCommit: release.sourceCommit,
  });
}

/** 下载并验证发布包，然后把不可变版本目录原子放入 product/versions。 */
export async function stageProductRelease({
  productRoot,
  release,
  fetchImpl = globalThis.fetch,
  onProgress,
  now = Date.now,
} = {}) {
  if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
    throw new Error("product_root_invalid");
  }
  const updatesRoot = path.join(productRoot, "updates");
  const versionsRoot = path.join(productRoot, "versions");
  await Promise.all([mkdir(updatesRoot, { recursive: true }), mkdir(versionsRoot, { recursive: true })]);
  const workRoot = path.join(updatesRoot, `.stage-${release.version}-${process.pid}-${now()}`);
  const resolvedWorkRoot = path.resolve(workRoot);
  if (!resolvedWorkRoot.startsWith(`${path.resolve(updatesRoot)}${path.sep}`)) {
    throw new Error("product_stage_path_invalid");
  }
  await mkdir(workRoot, { recursive: false });
  let downloadedBytes = 0;
  const totalBytes = Object.values(release.assets).reduce((sum, asset) => sum + asset.size, 0);
  const progress = (bytes) => {
    downloadedBytes += bytes;
    onProgress?.({ downloadedBytes, totalBytes });
  };
  try {
    const zip = await downloadReleaseAsset({
      fetchImpl,
      asset: release.assets.windows,
      destination: path.join(workRoot, release.assets.windows.name),
      onChunk: progress,
    });
    const checksums = await downloadReleaseAsset({
      fetchImpl,
      asset: release.assets.checksums,
      destination: path.join(workRoot, release.assets.checksums.name),
      onChunk: progress,
    });
    const externalManifest = await downloadReleaseAsset({
      fetchImpl,
      asset: release.assets.manifest,
      destination: path.join(workRoot, release.assets.manifest.name),
      onChunk: progress,
    });
    const checksumMap = parseSha256Sums(await readFile(checksums.path, "utf8"));
    if (
      checksumMap.get(release.assets.windows.name) !== zip.digest
      || checksumMap.get(release.assets.manifest.name) !== externalManifest.digest
    ) {
      throw new Error("product_update_checksum_mismatch");
    }
    const expectedRootName = `everyone-codex-${release.version}-windows-x64`;
    const expanded = await extractVerifiedZip({
      archivePath: zip.path,
      destinationRoot: path.join(workRoot, "expanded"),
      expectedRootName,
    });
    const externalManifestText = await readFile(externalManifest.path, "utf8");
    const packagedManifestText = await readFile(path.join(expanded.rootPath, "MANIFEST.sha256"), "utf8");
    if (externalManifestText !== packagedManifestText) throw new Error("runtime_manifest_asset_mismatch");
    const distribution = parseProductDistributionManifest(
      JSON.parse(await readFile(path.join(expanded.rootPath, "product-distribution.json"), "utf8")),
    );
    if (
      distribution.version !== release.version
      || distribution.sourceCommit !== release.sourceCommit
      || distribution.runtimeManifestSha256 !== sha256(Buffer.from(packagedManifestText, "utf8"))
    ) {
      throw new Error("product_distribution_release_mismatch");
    }
    await verifyRuntimeManifest(expanded.rootPath, packagedManifestText);
    const directory = `${release.version}-${zip.digest.slice(0, 12)}`;
    const existing = await existingVersionRecord({
      versionsRoot,
      directory,
      release,
      digest: zip.digest,
    });
    if (existing) return existing;
    const target = path.join(versionsRoot, directory);
    await rename(expanded.rootPath, target);
    return Object.freeze({
      version: release.version,
      directory,
      digest: zip.digest,
      sourceCommit: release.sourceCommit,
    });
  } finally {
    // workRoot 是上方验证过的 updates 子目录，且只由本次事务创建。
    await rm(workRoot, { recursive: true, force: true }).catch(() => {});
  }
}

function safeActivationEnvironment(source) {
  const allowed = [
    "SystemRoot", "WINDIR", "COMSPEC", "PATH", "PATHEXT", "LOCALAPPDATA",
    "TEMP", "TMP", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)",
  ];
  return Object.fromEntries(allowed.flatMap((name) => source[name] ? [[name, source[name]]] : []));
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function writeLauncherExitSignal({ launcherPid, launcherExecutable, runtimeDescriptorPath, record }) {
  if (
    typeof launcherExecutable !== "string"
    || !path.isAbsolute(launcherExecutable)
    || typeof runtimeDescriptorPath !== "string"
    || !path.isAbsolute(runtimeDescriptorPath)
  ) {
    throw new Error("product_launcher_signal_invalid");
  }
  for (const candidate of [launcherExecutable, runtimeDescriptorPath]) {
    const info = await lstat(candidate);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("product_launcher_signal_invalid");
  }
  const stateRoot = path.dirname(runtimeDescriptorPath);
  const updatesRoot = path.join(stateRoot, "updates");
  await mkdir(updatesRoot, { recursive: true });
  const operationRoot = path.join(
    updatesRoot,
    `update-everyone-${record.version}-${record.digest.slice(0, 12)}-${randomUUID()}`,
  );
  const statusPath = path.join(operationRoot, "status-v1.json");
  const requestPath = path.join(operationRoot, "request-v1.json");
  const helperPath = path.join(operationRoot, "codexhost-updater");
  const lockPath = path.join(updatesRoot, "active-update-v1.lock");
  await mkdir(operationRoot, { recursive: false });
  try {
    await writeJsonAtomic(statusPath, {
      schemaVersion: 1,
      version: record.version,
      installation: "windows-installer",
      phase: "waiting-for-exit",
      updatedAt: Date.now(),
      error: null,
    });
    await writeJsonAtomic(requestPath, {
      schema_version: 1,
      version: record.version,
      wait_pid: launcherPid,
      wait_executable: path.resolve(launcherExecutable),
      status_path: path.resolve(statusPath),
    });
    await writeFile(helperPath, "everyone-in-codex-product-activator\n", { flag: "wx", mode: 0o600 });
    await writeFile(
      lockPath,
      `${JSON.stringify({ ownerPid: process.pid, statusPath: path.resolve(statusPath) })}\n`,
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    return Object.freeze({ lockPath, operationRoot, statusPath, requestPath, helperPath });
  } catch (error) {
    for (const candidate of [lockPath, helperPath, requestPath, statusPath]) {
      await unlink(candidate).catch(() => {});
    }
    await rmdir(operationRoot).catch(() => {});
    throw error;
  }
}

async function removeLauncherExitSignal(signal) {
  if (!signal) return;
  try {
    const lock = JSON.parse(await readFile(signal.lockPath, "utf8"));
    if (path.resolve(lock.statusPath ?? "") !== path.resolve(signal.statusPath)) return;
  } catch {
    return;
  }
  for (const candidate of [signal.lockPath, signal.helperPath, signal.requestPath, signal.statusPath]) {
    await unlink(candidate).catch(() => {});
  }
  await rmdir(signal.operationRoot).catch(() => {});
}

/** 写入单一激活请求；已有 helper 会在旧 Launcher 退出后读取最新 mode。 */
export async function scheduleProductActivation({
  productRoot,
  currentPackageRoot,
  configPath,
  record,
  launcherPid,
  leaseId,
  mode,
  launcherExecutable,
  runtimeDescriptorPath,
  spawnImpl = spawn,
  sourceEnvironment = process.env,
} = {}) {
  if (
    typeof productRoot !== "string"
    || !path.isAbsolute(productRoot)
    || typeof currentPackageRoot !== "string"
    || !path.isAbsolute(currentPackageRoot)
    || typeof configPath !== "string"
    || !path.isAbsolute(configPath)
    || !Number.isSafeInteger(launcherPid)
    || launcherPid < 1
    || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(leaseId ?? "")
    || !new Set(["auto", "manual"]).has(mode)
  ) {
    throw new Error("product_activation_request_invalid");
  }
  const updatesRoot = path.join(productRoot, "updates");
  await mkdir(updatesRoot, { recursive: true });
  const requestPath = path.join(updatesRoot, "activation-request.json");
  const launcherSignal = mode === "manual"
    ? await writeLauncherExitSignal({
        launcherPid,
        launcherExecutable,
        runtimeDescriptorPath,
        record,
      })
    : null;
  try {
    await writeJsonAtomic(requestPath, {
      schemaVersion: 1,
      productRoot: path.resolve(productRoot),
      currentPackageRoot: path.resolve(currentPackageRoot),
      configPath: path.resolve(configPath),
      record,
      launcherPid,
      leaseId,
      mode,
      launcherSignal,
      updatedAt: Date.now(),
    });
    const statePath = path.join(updatesRoot, "activator-state.json");
    try {
      const active = JSON.parse(await readFile(statePath, "utf8"));
      if (Number.isSafeInteger(active?.pid) && processAlive(active.pid)) {
        return Object.freeze({
          scheduled: true,
          reused: true,
          pid: active.pid,
          launcherSignal: launcherSignal !== null,
        });
      }
    } catch {
      // 状态缺失或损坏时启动新的、仍受 activation.lock 保护的 helper。
    }
    const activatorPath = fileURLToPath(new URL("./product-update-activator.mjs", import.meta.url));
    const child = spawnImpl(process.execPath, [activatorPath, "--request", requestPath], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: safeActivationEnvironment(sourceEnvironment),
    });
    if (!Number.isSafeInteger(child.pid) || child.pid < 1) throw new Error("product_activator_start_failed");
    child.unref?.();
    await writeJsonAtomic(statePath, { schemaVersion: 1, pid: child.pid, startedAt: Date.now() });
    return Object.freeze({
      scheduled: true,
      reused: false,
      pid: child.pid,
      launcherSignal: launcherSignal !== null,
    });
  } catch (error) {
    await removeLauncherExitSignal(launcherSignal);
    throw error;
  }
}
