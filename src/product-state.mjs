import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { compareProductVersions } from "./product-distribution.mjs";

const DIRECTORY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;

function normalizeRecord(value) {
  if (!value || typeof value !== "object" || !DIRECTORY_PATTERN.test(value.directory ?? "")) {
    throw new Error("product_version_directory_invalid");
  }
  if (
    !SHA256_PATTERN.test(value.digest ?? "")
    || !GIT_OBJECT_PATTERN.test(value.sourceCommit ?? "")
  ) {
    throw new Error("product_version_record_invalid");
  }
  compareProductVersions(value.version, value.version);
  return Object.freeze({
    version: value.version,
    directory: value.directory,
    digest: value.digest,
    sourceCommit: value.sourceCommit,
  });
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

/**
 * 管理稳定启动器唯一读取的活动版本指针。版本目录永不在这里删除，回滚只交换指针。
 */
export class ProductVersionStore {
  constructor({ productRoot } = {}) {
    if (typeof productRoot !== "string" || !path.isAbsolute(productRoot)) {
      throw new Error("product_root_invalid");
    }
    this.productRoot = path.resolve(productRoot);
    this.versionsRoot = path.join(this.productRoot, "versions");
    this.pointerPath = path.join(this.productRoot, "active-version.json");
  }

  async #existingRecord(value) {
    const record = normalizeRecord(value);
    const versionPath = path.join(this.versionsRoot, record.directory);
    const relative = path.relative(this.versionsRoot, versionPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("product_version_directory_invalid");
    }
    let info;
    try {
      info = await lstat(versionPath);
    } catch (error) {
      if (error?.code === "ENOENT") throw new Error("product_version_directory_missing");
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("product_version_directory_invalid");
    }
    return record;
  }

  async read() {
    let parsed;
    try {
      parsed = JSON.parse(await readFile(this.pointerPath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error("product_pointer_invalid", { cause: error });
    }
    if (
      parsed?.schemaVersion !== 1
      || !new Set(["active", "pending-first-launch"]).has(parsed.state)
      || !parsed.active
    ) {
      throw new Error("product_pointer_invalid");
    }
    const pointer = {
      schemaVersion: 1,
      state: parsed.state,
      active: await this.#existingRecord(parsed.active),
      previous: parsed.previous ? await this.#existingRecord(parsed.previous) : null,
      failed: parsed.failed
        ? Object.freeze({
            ...normalizeRecord(parsed.failed),
            reason: String(parsed.failed.reason ?? "").slice(0, 200),
          })
        : null,
    };
    return Object.freeze(pointer);
  }

  async initialize(value) {
    const active = await this.#existingRecord(value);
    const current = await this.read();
    if (current) {
      if (JSON.stringify(current.active) !== JSON.stringify(active)) {
        throw new Error("product_pointer_already_initialized");
      }
      return current;
    }
    const pointer = { schemaVersion: 1, state: "active", active, previous: null, failed: null };
    await writeJsonAtomic(this.pointerPath, pointer);
    return this.read();
  }

  async activatePending(value) {
    const next = await this.#existingRecord(value);
    const current = await this.read();
    if (!current) throw new Error("product_pointer_missing");
    if (JSON.stringify(current.active) === JSON.stringify(next)) return current;
    const pointer = {
      schemaVersion: 1,
      state: "pending-first-launch",
      active: next,
      previous: current.active,
      failed: current.failed,
    };
    await writeJsonAtomic(this.pointerPath, pointer);
    return this.read();
  }

  async confirmActive() {
    const current = await this.read();
    if (!current) throw new Error("product_pointer_missing");
    if (current.state === "active") return current;
    await writeJsonAtomic(this.pointerPath, { ...current, state: "active" });
    return this.read();
  }

  async rollbackPending(reason = "startup_failed") {
    const current = await this.read();
    if (!current) throw new Error("product_pointer_missing");
    if (current.state !== "pending-first-launch" || !current.previous) return current;
    const pointer = {
      schemaVersion: 1,
      state: "active",
      active: current.previous,
      previous: null,
      failed: { ...current.active, reason: String(reason).slice(0, 200) || "startup_failed" },
    };
    await writeJsonAtomic(this.pointerPath, pointer);
    return this.read();
  }
}
