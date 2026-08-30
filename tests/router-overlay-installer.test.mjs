import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { prepareRouterOverlay } from "../src/router-overlay-installer.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("Router overlay 只从精确 baseline 建备份并经 git apply 物化", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-router-prepare-"));
  const routerRoot = path.join(root, "router");
  const sourcePath = path.join(routerRoot, "src", "feature.mjs");
  const newPath = path.join(routerRoot, "src", "new.mjs");
  const backupDirectory = path.join(root, "backup");
  const lockPath = path.join(root, "lock.json");
  const patchPath = path.join(root, "feature.patch");
  const before = "export const version = 2;\n";
  const after = "export const version = 3;\n";
  const added = "export const added = true;\n";
  await mkdir(path.dirname(sourcePath), { recursive: true });
  await writeFile(sourcePath, before);
  await writeFile(patchPath, "fixture patch\n");
  await writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    baselineTree: "a".repeat(40),
    patchSha256: sha256("fixture patch\n"),
    managedFiles: ["src/feature.mjs", "src/new.mjs"],
    baselineFileSha256: { "src/feature.mjs": sha256(before), "src/new.mjs": null },
    managedFileSha256: { "src/feature.mjs": sha256(after), "src/new.mjs": sha256(added) },
  }));
  const calls = [];
  const result = await prepareRouterOverlay({
    routerRoot,
    backupDirectory,
    lockPath,
    patchPath,
    runGit: async (args) => {
      calls.push(args);
      if (!args.includes("--check")) {
        await writeFile(sourcePath, after);
        await writeFile(newPath, added);
      }
    },
  });

  assert.equal(result.alreadyPatched, false);
  assert.equal(await readFile(path.join(backupDirectory, "src", "feature.mjs"), "utf8"), before);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].includes("--check"), true);
  assert.equal(calls[1].includes("--check"), false);
});

test("Router overlay 在运行 git 前拒绝被替换的 patch", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-router-patch-digest-"));
  const routerRoot = path.join(root, "router");
  const filePath = path.join(routerRoot, "feature.mjs");
  const lockPath = path.join(root, "lock.json");
  const patchPath = path.join(root, "feature.patch");
  await mkdir(routerRoot, { recursive: true });
  await writeFile(filePath, "before\n");
  await writeFile(patchPath, "tampered\n");
  await writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    patchSha256: sha256("expected\n"),
    managedFiles: ["feature.mjs"],
    baselineFileSha256: { "feature.mjs": sha256("before\n") },
    managedFileSha256: { "feature.mjs": sha256("after\n") },
  }));
  let gitCalls = 0;
  await assert.rejects(
    prepareRouterOverlay({
      routerRoot,
      backupDirectory: path.join(root, "backup"),
      lockPath,
      patchPath,
      runGit: async () => { gitCalls += 1; },
    }),
    /router_overlay_patch_digest_mismatch/,
  );
  assert.equal(gitCalls, 0);
});
