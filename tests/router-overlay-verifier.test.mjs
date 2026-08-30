import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyRouterOverlay } from "../src/router-overlay-verifier.mjs";

test("Router overlay 只接受锁内逐文件匹配的 cohort", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "eic-router-overlay-"));
  const routerRoot = path.join(root, "router");
  const filePath = path.join(routerRoot, "src", "feature.mjs");
  const lockPath = path.join(root, "lock.json");
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, "export const ready = true;\n");
  const hash = createHash("sha256").update(await readFile(filePath)).digest("hex");
  await writeFile(lockPath, JSON.stringify({
    schemaVersion: 1,
    managedFiles: ["src/feature.mjs"],
    managedFileSha256: { "src/feature.mjs": hash },
  }));

  assert.deepEqual(await verifyRouterOverlay({ routerRoot, lockPath }), {
    verified: true,
    managedFiles: 1,
  });
  await writeFile(filePath, "export const ready = false;\n");
  await assert.rejects(
    verifyRouterOverlay({ routerRoot, lockPath }),
    /router_overlay_mismatch:src\/feature\.mjs/,
  );
});
