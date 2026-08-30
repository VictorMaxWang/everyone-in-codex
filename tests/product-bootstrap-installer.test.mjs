import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { installPublishedProduct } from "../src/product-bootstrap-installer.mjs";

const sourceCommit = "1".repeat(40);
const manifest = {
  schemaVersion: 2,
  product: "everyone-in-codex",
  version: "0.3.1",
  channel: "stable",
  target: "windows-x64",
  sourceCommit,
  runtimeManifestSha256: "a".repeat(64),
  upstreams: {
    codexhost: { commit: "2".repeat(40), tree: "3".repeat(40) },
    router: { commit: "4".repeat(40), tree: "5".repeat(40) },
    webgpt: { commit: "6".repeat(40), tree: "7".repeat(40) },
  },
};

test("首次迁移只发布 GitHub 同版本资产，并从本机配置剥离源码 runtime 路径", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-bootstrap-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPackageRoot = path.join(root, "bootstrap");
  const productRoot = path.join(root, "product");
  const configPath = path.join(root, "fusion.local.json");
  const validationPolicyPath = path.join(root, "validation-policy.local.json");
  await mkdir(bootstrapPackageRoot, { recursive: true });
  await writeFile(path.join(bootstrapPackageRoot, "product-distribution.json"), JSON.stringify(manifest));
  await writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    profile: { name: "second" },
    router: { healthUrl: "http://127.0.0.1:4202/health" },
    webgpt: { healthUrl: "http://127.0.0.1:17841/healthz" },
    runtime: { nodeExecutable: "D:\\checkout\\node.exe" },
  }));
  await writeFile(validationPolicyPath, '{"schemaVersion":1}\n');

  const result = await installPublishedProduct({
    bootstrapPackageRoot,
    productRoot,
    configPath,
    validationPolicyPath,
    fetchLatest: async () => ({ version: "0.3.1", sourceCommit }),
    stageRelease: async () => {
      const versionRoot = path.join(productRoot, "versions", "0.3.1-deadbeef0000");
      await mkdir(path.join(versionRoot, "scripts"), { recursive: true });
      await writeFile(path.join(versionRoot, "scripts", "product-launcher.cmd"), "@echo off\n");
      await writeFile(path.join(versionRoot, "scripts", "product-launcher.ps1"), "# launcher\n");
      return {
        version: "0.3.1",
        directory: "0.3.1-deadbeef0000",
        digest: "b".repeat(64),
        sourceCommit,
      };
    },
  });
  assert.equal(result.pointerState, "active");
  const migrated = JSON.parse(await readFile(path.join(productRoot, "fusion.local.json"), "utf8"));
  assert.equal(Object.hasOwn(migrated, "runtime"), false);
  assert.match(await readFile(result.launcher, "utf8"), /echo off/u);
});

test("bootstrap 包与 GitHub Release commit 不一致时不创建产品指针", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-bootstrap-mismatch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bootstrapPackageRoot = path.join(root, "bootstrap");
  await mkdir(bootstrapPackageRoot, { recursive: true });
  await writeFile(path.join(bootstrapPackageRoot, "product-distribution.json"), JSON.stringify(manifest));
  await assert.rejects(
    installPublishedProduct({
      bootstrapPackageRoot,
      productRoot: path.join(root, "product"),
      configPath: path.join(root, "config.json"),
      validationPolicyPath: path.join(root, "policy.json"),
      fetchLatest: async () => ({ version: "0.3.1", sourceCommit: "9".repeat(40) }),
      stageRelease: async () => { throw new Error("must_not_stage"); },
    }),
    /product_install_release_mismatch/u,
  );
});
