#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { cp, lstat, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function publishPayload(sourceRoot, outputName) {
  const buildRoot = path.join(repositoryRoot, ".build", "codexhost");
  if (!/^payload-v[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(outputName)) {
    throw new Error("prepare-codexhost-payload output name is invalid");
  }
  const destination = path.join(buildRoot, outputName);
  const suffix = `${process.pid}-${randomUUID().replaceAll("-", "")}`;
  const partial = path.join(buildRoot, `${outputName}.partial-${suffix}`);
  const previous = path.join(buildRoot, `${outputName}.previous-${suffix}`);
  let previousMoved = false;
  let published = false;

  await mkdir(buildRoot, { recursive: true });
  try {
    await cp(sourceRoot, partial, { recursive: true, errorOnExist: true, force: false });
    if (await exists(destination)) {
      await rename(destination, previous);
      previousMoved = true;
    }
    await rename(partial, destination);
    published = true;
    // 旧 payload 只是可重建的构建产物；清理被杀软短暂占用时不回滚新版本。
    if (previousMoved) await rm(previous, { recursive: true, force: true }).catch(() => {});
    return destination;
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    if (previousMoved && !published && !(await exists(destination)) && await exists(previous)) {
      await rename(previous, destination);
    }
    throw error;
  }
}

const rootIndex = process.argv.indexOf("--root");
if (rootIndex === -1 || !process.argv[rootIndex + 1]) {
  throw new Error("prepare-codexhost-payload requires --root <materialized-codexhost>");
}
const outputIndex = process.argv.indexOf("--output-name");
if (outputIndex === -1 || !process.argv[outputIndex + 1]) {
  throw new Error("prepare-codexhost-payload requires --output-name <payload-vVERSION>");
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
// 发布到融合层固定读取位置；目录切换失败时保留上一份完整 payload。
const publishedPayload = await publishPayload(result.payloadRoot, process.argv[outputIndex + 1]);
process.stdout.write(`${JSON.stringify({ ok: true, payload: publishedPayload })}\n`);
