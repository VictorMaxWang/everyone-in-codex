import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const PROFILE_NAME = "everyone-in-codex";
const PROFILE_FILE = `${PROFILE_NAME}.config.toml`;
const CATALOG_FILE = "codex2-models.json";
const RECEIPT_FILE = "profile-ownership.json";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function normalizeGatewayBaseUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("gateway_must_be_plain_loopback_http");
  }
  if (url.pathname !== "/") throw new Error("gateway_base_url_must_not_include_a_path");
  return url.origin;
}

function normalizeModels(models) {
  if (!Array.isArray(models)) throw new TypeError("models must be an array");
  const seen = new Set();
  return models.map((model) => {
    if (!model || typeof model.id !== "string" || !model.id || seen.has(model.id)) {
      throw new Error("models_must_have_unique_non_empty_ids");
    }
    seen.add(model.id);
    return { ...model };
  });
}

function tomlString(value) {
  return JSON.stringify(String(value).replaceAll("\\", "/"));
}

function profileContents(gatewayOrigin, catalogPath) {
  return [
    "# 由 Everyone in Codex 管理；模型选择继续由 Codex UI 决定。",
    'model_provider = "everyone-in-codex"',
    `model_catalog_json = ${tomlString(catalogPath)}`,
    "",
    "[model_providers.everyone-in-codex]",
    'name = "Everyone in Codex"',
    `base_url = "${gatewayOrigin}/v1"`,
    'wire_api = "responses"',
    "requires_openai_auth = false",
    'env_key = "EVERYONE_CODEX_LEASE_CAPABILITY"',
    "",
  ].join("\n");
}

async function assertRegularFileOrMissing(filePath) {
  try {
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("managed_path_is_not_a_regular_file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export class ProfileManager {
  constructor({ codexHome, stateDir, profileName = PROFILE_NAME }) {
    if (!path.isAbsolute(codexHome) || !path.isAbsolute(stateDir)) {
      throw new TypeError("codexHome and stateDir must be absolute paths");
    }
    if (profileName !== PROFILE_NAME) {
      throw new Error("unsupported_profile_name");
    }

    this.codexHome = path.resolve(codexHome);
    this.stateDir = path.resolve(stateDir);
    this.profilePath = path.join(this.codexHome, PROFILE_FILE);
    this.catalogPath = path.join(this.stateDir, CATALOG_FILE);
    this.receiptPath = path.join(this.stateDir, RECEIPT_FILE);
  }

  async publish({ gatewayBaseUrl, models }) {
    const gatewayOrigin = normalizeGatewayBaseUrl(gatewayBaseUrl);
    const normalizedModels = normalizeModels(models);
    const profile = profileContents(gatewayOrigin, this.catalogPath);
    const catalog = `${JSON.stringify({ version: 1, models: normalizedModels }, null, 2)}\n`;

    await mkdir(this.codexHome, { recursive: true });
    await mkdir(this.stateDir, { recursive: true });
    await Promise.all([
      assertRegularFileOrMissing(this.profilePath),
      assertRegularFileOrMissing(this.catalogPath),
      assertRegularFileOrMissing(this.receiptPath),
    ]);

    const currentReceipt = await this.#loadAndVerifyOwnership();
    if (!currentReceipt && (
      await exists(this.profilePath)
      || await exists(this.catalogPath)
      || await exists(this.receiptPath)
    )) {
      throw new Error("profile_ownership_conflict");
    }

    const fingerprints = {
      profile: sha256(profile),
      catalog: sha256(catalog),
    };
    if (
      currentReceipt
      && currentReceipt.profileSha256 === fingerprints.profile
      && currentReceipt.catalogSha256 === fingerprints.catalog
    ) {
      return this.#publicReceipt(fingerprints);
    }

    const receipt = {
      version: 1,
      owner: PROFILE_NAME,
      profilePath: this.profilePath,
      catalogPath: this.catalogPath,
      profileSha256: fingerprints.profile,
      catalogSha256: fingerprints.catalog,
    };
    await this.#transactionalReplace({
      [this.profilePath]: profile,
      [this.catalogPath]: catalog,
      [this.receiptPath]: `${JSON.stringify(receipt, null, 2)}\n`,
    });

    return this.#publicReceipt(fingerprints);
  }

  async restore() {
    const receipt = await this.#loadAndVerifyOwnership();
    if (!receipt) return { restored: false, removed: [] };

    const nonce = randomBytes(8).toString("hex");
    const targets = [this.profilePath, this.catalogPath, this.receiptPath];
    const quarantined = [];
    try {
      // 先移入同目录隔离名，确保冲突时不会出现“只删一半”的恢复结果。
      for (const target of targets) {
        const quarantine = `${target}.restore-${nonce}`;
        await rename(target, quarantine);
        quarantined.push([target, quarantine]);
      }
      for (const [, quarantine] of quarantined) {
        await rm(quarantine, { force: true });
      }
    } catch (error) {
      for (const [target, quarantine] of quarantined.reverse()) {
        if (await exists(quarantine)) await rename(quarantine, target);
      }
      throw error;
    }

    return { restored: true, removed: [this.profilePath, this.catalogPath] };
  }

  #publicReceipt(fingerprints) {
    return Object.freeze({
      profilePath: this.profilePath,
      catalogPath: this.catalogPath,
      fingerprints: Object.freeze({ ...fingerprints }),
    });
  }

  async #loadAndVerifyOwnership() {
    const receiptExists = await exists(this.receiptPath);
    const profileExists = await exists(this.profilePath);
    const catalogExists = await exists(this.catalogPath);
    if (!receiptExists) return null;
    if (!profileExists || !catalogExists) throw new Error("profile_ownership_conflict");

    let receipt;
    try {
      receipt = await readJson(this.receiptPath);
    } catch {
      throw new Error("profile_ownership_conflict");
    }
    if (
      receipt?.version !== 1
      || receipt?.owner !== PROFILE_NAME
      || path.resolve(receipt?.profilePath ?? "") !== this.profilePath
      || path.resolve(receipt?.catalogPath ?? "") !== this.catalogPath
    ) {
      throw new Error("profile_ownership_conflict");
    }

    const [profile, catalog] = await Promise.all([
      readFile(this.profilePath, "utf8"),
      readFile(this.catalogPath, "utf8"),
    ]);
    if (sha256(profile) !== receipt.profileSha256 || sha256(catalog) !== receipt.catalogSha256) {
      throw new Error("profile_ownership_conflict");
    }
    return receipt;
  }

  async #transactionalReplace(files) {
    const nonce = randomBytes(8).toString("hex");
    const entries = Object.entries(files);
    const staged = [];
    const backups = [];
    const installed = [];

    try {
      for (const [target, contents] of entries) {
        const temporary = `${target}.new-${nonce}`;
        await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
        staged.push([target, temporary]);
      }
      for (const [target] of entries) {
        if (await exists(target)) {
          const backup = `${target}.old-${nonce}`;
          await rename(target, backup);
          backups.push([target, backup]);
        }
      }
      for (const [target, temporary] of staged) {
        await rename(temporary, target);
        installed.push(target);
      }
      for (const [, backup] of backups) await rm(backup, { force: true });
    } catch (error) {
      for (const target of installed.reverse()) await rm(target, { force: true });
      for (const [target, backup] of backups.reverse()) {
        if (await exists(backup)) await rename(backup, target);
      }
      for (const [, temporary] of staged) await rm(temporary, { force: true });
      throw error;
    }
  }
}
