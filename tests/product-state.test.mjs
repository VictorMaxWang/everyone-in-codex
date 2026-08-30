import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ProductVersionStore } from "../src/product-state.mjs";

test("产品指针原子切换、首次启动确认与失败回滚均保留旧版本", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-product-state-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "versions", "0.3.0-old"), { recursive: true });
  await mkdir(path.join(root, "versions", "0.3.1-new"), { recursive: true });
  const store = new ProductVersionStore({ productRoot: root });

  await store.initialize({
    version: "0.3.0",
    directory: "0.3.0-old",
    digest: "a".repeat(64),
    sourceCommit: "1".repeat(40),
  });
  await store.activatePending({
    version: "0.3.1",
    directory: "0.3.1-new",
    digest: "b".repeat(64),
    sourceCommit: "2".repeat(40),
  });
  let pointer = await store.read();
  assert.equal(pointer.state, "pending-first-launch");
  assert.equal(pointer.active.version, "0.3.1");
  assert.equal(pointer.previous.version, "0.3.0");

  await store.rollbackPending("startup_failed");
  pointer = await store.read();
  assert.equal(pointer.state, "active");
  assert.equal(pointer.active.version, "0.3.0");
  assert.equal(pointer.failed.version, "0.3.1");
  assert.equal(pointer.failed.reason, "startup_failed");

  await store.activatePending({
    version: "0.3.1",
    directory: "0.3.1-new",
    digest: "b".repeat(64),
    sourceCommit: "2".repeat(40),
  });
  await store.confirmActive();
  pointer = await store.read();
  assert.equal(pointer.state, "active");
  assert.equal(pointer.active.version, "0.3.1");
  assert.equal(pointer.previous.version, "0.3.0");

  const persisted = JSON.parse(await readFile(path.join(root, "active-version.json"), "utf8"));
  assert.equal(persisted.active.directory, "0.3.1-new");
});

test("产品指针拒绝目录穿越与不存在的版本目录", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-product-state-invalid-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new ProductVersionStore({ productRoot: root });
  await assert.rejects(
    store.initialize({
      version: "0.3.1",
      directory: "..\\outside",
      digest: "a".repeat(64),
      sourceCommit: "1".repeat(40),
    }),
    /product_version_directory_invalid/u,
  );
});
