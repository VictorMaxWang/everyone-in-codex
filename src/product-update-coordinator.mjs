import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  compareProductVersions,
  parseProductDistributionManifest,
} from "./product-distribution.mjs";
import {
  fetchLatestProductRelease,
  scheduleProductActivation,
  stageProductRelease,
} from "./product-update-runtime.mjs";

const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000;
const ERROR_MAX_LENGTH = 500;

function boundedError(error) {
  return (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX_LENGTH)
    || "Product update failed";
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

function publicStatus(status) {
  if (!status) return null;
  return Object.freeze({
    version: status.version,
    installation: "windows-installer",
    phase: status.phase,
    updatedAt: status.updatedAt,
    ...(status.downloadedBytes === undefined ? {} : { downloadedBytes: status.downloadedBytes }),
    ...(status.totalBytes === undefined ? {} : { totalBytes: status.totalBytes }),
    error: status.error ?? null,
  });
}

function normalizeContext(value = {}) {
  const launcherPid = value.launcherPid;
  if (launcherPid !== undefined && (!Number.isSafeInteger(launcherPid) || launcherPid < 1)) {
    throw new Error("product_update_launcher_pid_invalid");
  }
  const leaseId = value.leaseId;
  if (leaseId !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(leaseId)) {
    throw new Error("product_update_lease_invalid");
  }
  const launcherExecutable = value.launcherExecutable;
  const runtimeDescriptorPath = value.runtimeDescriptorPath;
  for (const [name, candidate] of Object.entries({ launcherExecutable, runtimeDescriptorPath })) {
    if (candidate !== undefined && (typeof candidate !== "string" || !path.isAbsolute(candidate))) {
      throw new Error(`product_update_${name}_invalid`);
    }
  }
  return Object.freeze({
    launcherPid: launcherPid ?? null,
    leaseId: leaseId ?? null,
    launcherExecutable: launcherExecutable ?? null,
    runtimeDescriptorPath: runtimeDescriptorPath ?? null,
  });
}

/** 产品级更新协调器；它从不读取 CodexHost、Router 或 WebGPT 的上游 Release。 */
export class ProductUpdateCoordinator {
  #stagePromise = null;
  #statusWrite = Promise.resolve();

  constructor({
    productRoot,
    currentManifest,
    packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    configPath = path.join(productRoot ?? "", "fusion.local.json"),
    fetchImpl = globalThis.fetch,
    fetchLatest,
    stageRelease,
    scheduleActivation,
    now = Date.now,
    autoDownload = true,
    checkIntervalMs = CHECK_INTERVAL_MS,
  } = {}) {
    if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
      throw new Error("product_root_invalid");
    }
    if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
      throw new Error("product_package_root_invalid");
    }
    if (typeof configPath !== "string" || !path.isAbsolute(configPath)) {
      throw new Error("product_config_path_invalid");
    }
    this.productRoot = path.resolve(productRoot);
    this.packageRoot = path.resolve(packageRoot);
    this.configPath = path.resolve(configPath);
    this.currentManifest = parseProductDistributionManifest(currentManifest);
    this.fetchLatest = fetchLatest ?? (() => fetchLatestProductRelease({ fetchImpl }));
    this.stageRelease = stageRelease ?? ((input) => stageProductRelease({
      ...input,
      productRoot: this.productRoot,
      fetchImpl,
      now,
    }));
    this.scheduleActivation = scheduleActivation ?? ((input) => scheduleProductActivation({
      ...input,
      productRoot: this.productRoot,
      currentPackageRoot: this.packageRoot,
      configPath: this.configPath,
    }));
    if (
      typeof this.fetchLatest !== "function"
      || typeof this.stageRelease !== "function"
      || typeof this.scheduleActivation !== "function"
      || typeof now !== "function"
      || !Number.isSafeInteger(checkIntervalMs)
      || checkIntervalMs < 1
    ) {
      throw new Error("product_update_dependency_invalid");
    }
    this.now = now;
    this.autoDownload = autoDownload === true;
    this.checkIntervalMs = checkIntervalMs;
    this.updatesRoot = path.join(this.productRoot, "updates");
    this.cachePath = path.join(this.updatesRoot, "release-cache-v1.json");
    this.statusPath = path.join(this.updatesRoot, "status-v1.json");
  }

  async #readJson(filePath) {
    try {
      return JSON.parse(await readFile(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      return null;
    }
  }

  async #writeStatus(value) {
    const status = {
      schemaVersion: 1,
      version: value.version,
      phase: value.phase,
      updatedAt: this.now(),
      ...(value.downloadedBytes === undefined ? {} : { downloadedBytes: value.downloadedBytes }),
      ...(value.totalBytes === undefined ? {} : { totalBytes: value.totalBytes }),
      error: value.error ?? null,
      ...(value.record ? { record: value.record } : {}),
    };
    this.#statusWrite = this.#statusWrite
      .catch(() => {})
      .then(() => writeJsonAtomic(this.statusPath, status));
    await this.#statusWrite;
    return status;
  }

  async #latest() {
    const cached = await this.#readJson(this.cachePath);
    if (
      cached?.schemaVersion === 1
      && Number.isSafeInteger(cached.checkedAt)
      && this.now() - cached.checkedAt >= 0
      && this.now() - cached.checkedAt < this.checkIntervalMs
      && cached.release?.version
    ) {
      return cached.release;
    }
    const release = await this.fetchLatest();
    await writeJsonAtomic(this.cachePath, { schemaVersion: 1, checkedAt: this.now(), release });
    return release;
  }

  async #stage(release) {
    if (this.#stagePromise) return this.#stagePromise;
    this.#stagePromise = (async () => {
      await this.#writeStatus({ version: release.version, phase: "downloading" });
      try {
        const record = await this.stageRelease({
          release,
          onProgress: (progress) => {
            void this.#writeStatus({
              version: release.version,
              phase: "downloading",
              downloadedBytes: progress.downloadedBytes,
              totalBytes: progress.totalBytes,
            });
          },
        });
        await this.#writeStatus({ version: release.version, phase: "waiting-for-exit", record });
        return record;
      } catch (error) {
        await this.#writeStatus({
          version: release.version,
          phase: "failed",
          error: boundedError(error),
        });
        throw error;
      }
    })().finally(() => {
      this.#stagePromise = null;
    });
    return this.#stagePromise;
  }

  async #stageAndSchedule(release, context, mode) {
    const record = await this.#stage(release);
    if (context.launcherPid && context.leaseId) {
      await this.scheduleActivation({ ...context, record, mode });
    }
    return record;
  }

  async check(contextValue = {}) {
    const context = normalizeContext(contextValue);
    const status = publicStatus(await this.#readJson(this.statusPath));
    try {
      const release = await this.#latest();
      const updateAvailable = compareProductVersions(
        this.currentManifest.version,
        release.version,
      ) < 0;
      if (updateAvailable && this.autoDownload) {
        void this.#stageAndSchedule(release, context, "auto").catch(() => {});
      }
      return Object.freeze({
        currentVersion: this.currentManifest.version,
        installation: "windows-installer",
        latestVersion: release.version,
        updateAvailable,
        installationAvailable: updateAvailable,
        releaseNotes: release.releaseNotes ?? null,
        releaseNotesUrl: release.releaseNotesUrl ?? null,
        status,
        error: null,
      });
    } catch (error) {
      return Object.freeze({
        currentVersion: this.currentManifest.version,
        installation: "windows-installer",
        latestVersion: null,
        updateAvailable: false,
        installationAvailable: false,
        releaseNotes: null,
        releaseNotesUrl: null,
        status,
        error: boundedError(error),
      });
    }
  }

  async start(contextValue = {}) {
    const context = normalizeContext(contextValue);
    if (!context.launcherPid || !context.leaseId) throw new Error("product_update_context_incomplete");
    const release = await this.#latest();
    if (compareProductVersions(this.currentManifest.version, release.version) >= 0) {
      throw new Error("product_update_not_available");
    }
    await this.#stageAndSchedule(release, context, "manual");
    return Object.freeze({ status: publicStatus(await this.#readJson(this.statusPath)) });
  }

  async status() {
    await this.#statusWrite.catch(() => {});
    return Object.freeze({ status: publicStatus(await this.#readJson(this.statusPath)) });
  }
}
