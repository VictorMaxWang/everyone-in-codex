import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const CONTRACT_VERSION = 1;

export function assertCodexAppServerSchema(document) {
  const patchKind = document?.definitions?.v2?.PatchChangeKind;
  const variants = Array.isArray(patchKind?.oneOf) ? patchKind.oneOf : [];
  const byType = new Map(variants.map((variant) => [variant?.properties?.type?.enum?.[0], variant]));
  if (
    !byType.has("add")
    || !byType.has("delete")
    || !byType.has("update")
    || !Object.hasOwn(byType.get("update")?.properties ?? {}, "move_path")
  ) {
    throw new Error("codex_app_server_patch_schema_incompatible");
  }
  const serialized = JSON.stringify(document);
  for (const required of [
    "item/commandExecution/requestApproval",
    "item/fileChange/requestApproval",
    "commandActions",
  ]) {
    if (!serialized.includes(required)) {
      throw new Error("codex_app_server_preview_schema_incompatible");
    }
  }
  return true;
}

async function writeJsonAtomic(filePath, value) {
  const temporary = `${filePath}.new-${process.pid}-${randomUUID()}`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

/** 在启动 CodexHost 前用当前 Codex CLI 的 experimental schema 做失败关闭门禁。 */
export async function verifyCodexAppServerSchema({
  codexExecutable,
  stateRoot,
  execFileImpl = execFileAsync,
} = {}) {
  const markerPath = path.join(stateRoot, "codex-app-server-schema.json");
  const { stdout } = await execFileImpl(codexExecutable, ["--version"], {
    windowsHide: true,
    encoding: "utf8",
  });
  const codexVersion = String(stdout).trim();
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker.contractVersion === CONTRACT_VERSION && marker.codexVersion === codexVersion) {
      return Object.freeze({ verified: true, cached: true, codexVersion });
    }
  } catch (error) {
    if (error?.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }

  await mkdir(stateRoot, { recursive: true });
  const outputDirectory = path.join(stateRoot, `schema-${randomUUID()}`);
  await mkdir(outputDirectory, { recursive: false });
  try {
    await execFileImpl(codexExecutable, [
      "app-server",
      "generate-json-schema",
      "--experimental",
      "--out",
      outputDirectory,
    ], { windowsHide: true, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 });
    const schema = JSON.parse(await readFile(
      path.join(outputDirectory, "codex_app_server_protocol.schemas.json"),
      "utf8",
    ));
    assertCodexAppServerSchema(schema);
    await writeJsonAtomic(markerPath, { contractVersion: CONTRACT_VERSION, codexVersion });
    return Object.freeze({ verified: true, cached: false, codexVersion });
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}
