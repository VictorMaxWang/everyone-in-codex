import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { ProfileManager } from "../src/profile-manager.mjs";

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

test("命名 Profile 发布和恢复不改变基础 config", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "everyone-profile-"));
  const codexHome = path.join(root, "codex-2");
  const stateDir = path.join(root, "state");
  const baseConfigPath = path.join(codexHome, "config.toml");
  const baseConfig = "model = \"user-selected-model\"\n[features]\napps = true\n";
  await writeFile(baseConfigPath, baseConfig, { encoding: "utf8", flag: "wx" }).catch(async (error) => {
    if (error?.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(codexHome, { recursive: true });
    await writeFile(baseConfigPath, baseConfig, "utf8");
  });

  const manager = new ProfileManager({ codexHome, stateDir });
  const receipt = await manager.publish({
    gatewayBaseUrl: "http://127.0.0.1:45678",
    models: [{ id: "zai-api-cn/glm-5.3-flash", context_window: 1_000_000 }],
  });

  assert.equal(await readFile(baseConfigPath, "utf8"), baseConfig);
  assert.equal(path.basename(receipt.profilePath), "everyone-in-codex.config.toml");
  assert.equal(path.basename(receipt.catalogPath), "codex2-models.json");
  assert.equal(JSON.stringify(receipt).includes("capability"), false);

  const profile = await readFile(receipt.profilePath, "utf8");
  assert.match(profile, /^model_provider = "everyone-in-codex"$/m);
  assert.equal(
    profile.includes(`model_catalog_json = "${receipt.catalogPath.replaceAll("\\", "/")}"`),
    true,
  );
  assert.match(profile, /base_url = "http:\/\/127\.0\.0\.1:45678\/v1"/);
  assert.match(profile, /env_key = "EVERYONE_CODEX_LEASE_CAPABILITY"/);
  assert.doesNotMatch(profile, /^model\s*=/m);

  const catalog = JSON.parse(await readFile(receipt.catalogPath, "utf8"));
  assert.deepEqual(catalog.models.map((model) => model.id), ["zai-api-cn/glm-5.3-flash"]);

  const restored = await manager.restore();
  assert.deepEqual(restored, { restored: true, removed: [receipt.profilePath, receipt.catalogPath] });
  assert.equal(await exists(receipt.profilePath), false);
  assert.equal(await exists(receipt.catalogPath), false);
  assert.equal(await readFile(baseConfigPath, "utf8"), baseConfig);

  await rm(root, { recursive: true, force: true });
});

test("文件被外部修改后 restore 失败关闭且不删除任何受管文件", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "everyone-profile-conflict-"));
  const codexHome = path.join(root, "codex-2");
  const stateDir = path.join(root, "state");
  const manager = new ProfileManager({ codexHome, stateDir });
  const receipt = await manager.publish({
    gatewayBaseUrl: "http://127.0.0.1:45678",
    models: [{ id: "provider/allowed" }],
  });
  await writeFile(receipt.profilePath, "# external owner changed this file\n", "utf8");

  await assert.rejects(manager.restore(), /profile_ownership_conflict/);
  assert.equal(await exists(receipt.profilePath), true);
  assert.equal(await exists(receipt.catalogPath), true);

  await rm(root, { recursive: true, force: true });
});
