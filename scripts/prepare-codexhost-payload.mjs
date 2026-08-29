#!/usr/bin/env node

import path from "node:path";
import { pathToFileURL } from "node:url";

const rootIndex = process.argv.indexOf("--root");
if (rootIndex === -1 || !process.argv[rootIndex + 1]) {
  throw new Error("prepare-codexhost-payload requires --root <materialized-codexhost>");
}
const upstreamRoot = path.resolve(process.argv[rootIndex + 1]);
const payloadModule = await import(
  pathToFileURL(path.join(upstreamRoot, "scripts", "release", "prepare-payload.mjs"))
);
const targetsModule = await import(
  pathToFileURL(path.join(upstreamRoot, "scripts", "release", "targets.mjs"))
);

// 只生成上游已验证的payload，不进入本计划明确排除的Inno Setup安装器阶段。
const result = await payloadModule.prepareReleasePayload({
  target: targetsModule.releaseTarget("windows-x64"),
  root: upstreamRoot,
});
process.stdout.write(`${JSON.stringify({ ok: true, payload: result.payloadRoot })}\n`);
