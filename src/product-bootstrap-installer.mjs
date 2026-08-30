import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { parseProductDistributionManifest } from "./product-distribution.mjs";
import { ProductVersionStore } from "./product-state.mjs";
import { fetchLatestProductRelease, stageProductRelease } from "./product-update-runtime.mjs";

async function writeExclusiveOrMatching(filePath, value) {
  try {
    const existing = await readFile(filePath);
    if (!existing.equals(value)) throw new Error("product_install_owned_file_conflict");
    return;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, value, { flag: "wx" });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function migrateConfig(sourcePath, destinationPath) {
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  if (source?.schemaVersion !== 1 || !source.profile || !source.router || !source.webgpt) {
    throw new Error("product_install_config_invalid");
  }
  const migrated = { ...source };
  delete migrated.runtime;
  await writeExclusiveOrMatching(
    destinationPath,
    Buffer.from(`${JSON.stringify(migrated, null, 2)}\n`, "utf8"),
  );
}

/** 首次迁移再次下载同一 GitHub Release，保证生产版本来自实际发布资产。 */
export async function installPublishedProduct({
  bootstrapPackageRoot,
  productRoot,
  configPath,
  validationPolicyPath,
  fetchLatest = fetchLatestProductRelease,
  stageRelease = stageProductRelease,
} = {}) {
  for (const [name, value] of Object.entries({
    bootstrapPackageRoot, productRoot, configPath, validationPolicyPath,
  })) {
    if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error(`product_install_${name}_invalid`);
  }
  const bootstrapManifest = parseProductDistributionManifest(
    JSON.parse(await readFile(path.join(bootstrapPackageRoot, "product-distribution.json"), "utf8")),
  );
  const release = await fetchLatest();
  if (
    release.version !== bootstrapManifest.version
    || release.sourceCommit !== bootstrapManifest.sourceCommit
  ) {
    throw new Error("product_install_release_mismatch");
  }
  const record = await stageRelease({ productRoot, release });
  if (record.version !== release.version || record.sourceCommit !== release.sourceCommit) {
    throw new Error("product_install_staged_record_invalid");
  }
  const versionRoot = path.join(productRoot, "versions", record.directory);
  await Promise.all([
    writeExclusiveOrMatching(
      path.join(productRoot, "bin", "product-launcher.cmd"),
      await readFile(path.join(versionRoot, "scripts", "product-launcher.cmd")),
    ),
    writeExclusiveOrMatching(
      path.join(productRoot, "bin", "product-launcher.ps1"),
      await readFile(path.join(versionRoot, "scripts", "product-launcher.ps1")),
    ),
    migrateConfig(configPath, path.join(productRoot, "fusion.local.json")),
    writeExclusiveOrMatching(
      path.join(productRoot, "validation-policy.local.json"),
      await readFile(validationPolicyPath),
    ),
  ]);
  const store = new ProductVersionStore({ productRoot });
  const current = await store.read();
  const pointer = current
    ? await store.activatePending(record)
    : await store.initialize(record);
  return Object.freeze({
    installed: true,
    version: record.version,
    productRoot,
    launcher: path.join(productRoot, "bin", "product-launcher.cmd"),
    pointerState: pointer.state,
  });
}

function parseArguments(argv) {
  const allowed = new Map([
    ["--package-root", "bootstrapPackageRoot"],
    ["--product-root", "productRoot"],
    ["--config", "configPath"],
    ["--validation-policy", "validationPolicyPath"],
  ]);
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = allowed.get(argv[index]);
    const value = argv[index + 1];
    if (!key || !value || !path.isAbsolute(value) || Object.hasOwn(result, key)) {
      throw new Error("product_install_arguments_invalid");
    }
    result[key] = path.resolve(value);
  }
  if (Object.keys(result).length !== allowed.size) throw new Error("product_install_arguments_invalid");
  return result;
}

async function main() {
  try {
    const result = await installPublishedProduct(parseArguments(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error).slice(0, 500)}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
