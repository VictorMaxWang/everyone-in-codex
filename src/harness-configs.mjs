import { createHash, randomBytes, randomInt } from "node:crypto";
import { createServer } from "node:net";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const CAPABILITY_ENV_BY_HARNESS = Object.freeze({
  pi: "EVERYONE_CODEX_PI_LEASE_CAPABILITY",
  omp: "EVERYONE_CODEX_OMP_LEASE_CAPABILITY",
  "deepseek-harness": "EVERYONE_CODEX_DSH_LEASE_CAPABILITY",
  grok: "EVERYONE_CODEX_GROK_LEASE_CAPABILITY",
});
const REASONING_LEVELS = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function requireAbsolutePath(value, label) {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} 必须是绝对路径`);
  }
  return path.resolve(value);
}

function pathKey(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function normalizeGatewayBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("external_gateway_url_invalid");
  }
  if (
    url.protocol !== "http:"
    || url.hostname !== "127.0.0.1"
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("external_gateway_url_invalid");
  }
  url.pathname = "/v1";
  return url.href.replace(/\/$/, "");
}

function normalizeGatewayBaseUrls(values) {
  if (!values || typeof values !== "object" || Array.isArray(values)) {
    throw new Error("external_gateway_urls_invalid");
  }
  try {
    return Object.freeze(Object.fromEntries(
      Object.keys(CAPABILITY_ENV_BY_HARNESS).map((harnessId) => [
        harnessId,
        normalizeGatewayBaseUrl(values[harnessId]),
      ]),
    ));
  } catch {
    throw new Error("external_gateway_urls_invalid");
  }
}

function normalizeModels(models) {
  if (!Array.isArray(models) || models.length === 0) {
    throw new Error("external_catalog_models_invalid");
  }
  const seen = new Set();
  return models.map((model) => {
    const id = String(model?.id ?? "").trim();
    if (!id || seen.has(id)) {
      throw new Error("external_catalog_models_invalid");
    }
    seen.add(id);
    const contextWindow = Number(model.context_window ?? model.contextWindow);
    const inputModalities = Array.isArray(model.input_modalities)
      ? model.input_modalities.filter((entry) => new Set(["text", "image"]).has(entry))
      : ["text"];
    const reasoningLevels = Array.isArray(model.supported_reasoning_levels)
      ? model.supported_reasoning_levels
        .map((entry) => (
          typeof entry === "string"
            ? entry
            : typeof entry?.effort === "string"
              ? entry.effort
              : null
        ))
        .filter((entry) => REASONING_LEVELS.has(entry))
      : [];
    // 外部 Harness 统一只暴露到 max；Gateway 再按目标模型把 Pro 的 max 映射回 ultra。
    const projectedReasoningLevels = [...new Set(
      reasoningLevels.map((level) => (level === "ultra" ? "max" : level)),
    )];
    return Object.freeze({
      id,
      displayName: String(model.display_name ?? model.name ?? id),
      ...(Number.isInteger(contextWindow) && contextWindow > 0 ? { contextWindow } : {}),
      inputModalities: inputModalities.length > 0 ? inputModalities : ["text"],
      reasoningLevels: projectedReasoningLevels,
    });
  });
}

function jsonModel(model) {
  return {
    id: model.id,
    name: model.displayName,
    reasoning: model.reasoningLevels.length > 0,
    ...(model.reasoningLevels.length > 0
      ? {
        thinkingLevelMap: Object.fromEntries(
          model.reasoningLevels.map((level) => [level, level]),
        ),
      }
      : {}),
    input: model.inputModalities,
    ...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
  };
}

function renderPi(baseUrl, models) {
  return `${JSON.stringify({
    providers: {
      "everyone-in-codex": {
        baseUrl,
        api: "openai-responses",
        apiKey: `$${CAPABILITY_ENV_BY_HARNESS.pi}`,
        authHeader: true,
        models: models.map(jsonModel),
      },
    },
  }, null, 2)}\n`;
}

function yamlModelLines(models, indentation = "      ") {
  return models.flatMap((model) => [
    `${indentation}- id: ${JSON.stringify(model.id)}`,
    `${indentation}  name: ${JSON.stringify(model.displayName)}`,
    `${indentation}  reasoning: ${model.reasoningLevels.length > 0}`,
    ...(model.reasoningLevels.length > 0
      ? [
        `${indentation}  thinkingLevelMap:`,
        ...model.reasoningLevels.map((level) => (
          `${indentation}    ${level}: ${level}`
        )),
      ]
      : []),
    `${indentation}  input: [${model.inputModalities.map(JSON.stringify).join(", ")}]`,
    ...(model.contextWindow
      ? [`${indentation}  contextWindow: ${model.contextWindow}`]
      : []),
  ]);
}

function renderOmp(baseUrl, models) {
  return [
    "providers:",
    "  everyone-in-codex:",
    `    baseUrl: ${JSON.stringify(baseUrl)}`,
    "    api: openai-responses",
    `    apiKey: ${CAPABILITY_ENV_BY_HARNESS.omp}`,
    "    authHeader: true",
    "    models:",
    ...yamlModelLines(models),
    "",
  ].join("\n");
}

function renderDsh(baseUrl, models) {
  const modelLines = models.flatMap((model) => [
    `        - id: ${JSON.stringify(model.id)}`,
    `          name: ${JSON.stringify(model.displayName)}`,
    ...(model.contextWindow ? [`          contextWindow: ${model.contextWindow}`] : []),
    ...(model.reasoningLevels.length > 0
      ? [
        "          reasoningEfforts:",
        ...model.reasoningLevels.map((level) => (
          level === "off" ? "            off:" : `            ${level}: ${level}`
        )),
      ]
      : []),
  ]);
  return [
    "llm-pi-ai:",
    "  providers:",
    "    everyone-in-codex:",
    '      displayName: "Everyone in Codex"',
    `      apiKeyEnv: ${CAPABILITY_ENV_BY_HARNESS["deepseek-harness"]}`,
    "      api: openai-responses",
    `      baseURL: ${JSON.stringify(baseUrl)}`,
    "      models:",
    ...modelLines,
    "",
  ].join("\n");
}

function tomlString(value) {
  // JSON 字符串的基本转义与 TOML basic string 在这些输入上一致。
  return JSON.stringify(String(value));
}

function grokTransportModelId(upstreamModelId) {
  return `everyone-in-codex~${Buffer.from(upstreamModelId, "utf8").toString("base64url")}`;
}

function renderGrok(baseUrl, models) {
  const lines = [];
  for (const model of models) {
    const transportModelId = grokTransportModelId(model.id);
    lines.push(
      ...(lines.length > 0 ? [""] : []),
      `[model.${tomlString(transportModelId)}]`,
      `model = ${tomlString(model.id)}`,
      `base_url = ${tomlString(baseUrl)}`,
      `name = ${tomlString(model.displayName)}`,
      `env_key = ${tomlString(CAPABILITY_ENV_BY_HARNESS.grok)}`,
      'api_backend = "responses"',
      'extra_headers = { "x-everyone-codex-harness" = "grok" }',
      ...(model.contextWindow ? [`context_window = ${model.contextWindow}`] : []),
    );
  }
  return `${lines.join("\n")}\n`;
}

async function assertDirectoryChainSafe(directory) {
  const resolved = requireAbsolutePath(directory, "Harness config root");
  const root = path.parse(resolved).root;
  let current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") break;
      throw error;
    }
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("harness_config_path_is_reparse_or_not_directory");
    }
  }
  // 只有确认所有已存在祖先都不是 reparse 后，才允许递归创建缺失层级。
  await mkdir(resolved, { recursive: true });
  current = root;
  for (const segment of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new Error("harness_config_path_is_reparse_or_not_directory");
    }
  }
  return resolved;
}

async function writeManagedFile(filePath, contents) {
  await assertDirectoryChainSafe(path.dirname(filePath));
  try {
    await lstat(filePath);
    throw new Error("harness_config_already_exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporary = `${filePath}.new-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  try {
    await rename(temporary, filePath);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return Object.freeze({ path: filePath, sha256: sha256(contents) });
}

function tryListen(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const onError = (error) => reject(error);
    server.once("error", onError);
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      server.off("error", onError);
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

/** 为 DSH 选择当时空闲的随机回环高位端口；真正 bind 仍由 DSH 完成。 */
export async function reserveLoopbackPort() {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const candidate = randomInt(49_152, 65_536);
    try {
      return await tryListen(candidate);
    } catch (error) {
      if (error?.code !== "EADDRINUSE" && error?.code !== "EACCES") throw error;
    }
  }
  throw new Error("loopback_high_port_unavailable");
}

/**
 * 发布四个 Harness 专用配置。文件只引用 capability 环境变量名，
 * 不包含任何 lease capability 值。
 */
export async function publishHarnessConfigs({
  root,
  gatewayBaseUrls,
  models,
  loopbackPortAllocator = reserveLoopbackPort,
} = {}) {
  const safeRoot = await assertDirectoryChainSafe(root);
  const normalizedModels = normalizeModels(models);
  const baseUrls = normalizeGatewayBaseUrls(gatewayBaseUrls);
  if (typeof loopbackPortAllocator !== "function") {
    throw new Error("loopback_port_allocator_invalid");
  }
  const dshPort = Number(await loopbackPortAllocator());
  if (!Number.isInteger(dshPort) || dshPort < 49_152 || dshPort > 65_535) {
    throw new Error("loopback_high_port_invalid");
  }

  const directories = Object.freeze({
    pi: path.join(safeRoot, "pi"),
    omp: path.join(safeRoot, "omp"),
    dsh: path.join(safeRoot, "dsh"),
    grok: path.join(safeRoot, "grok"),
  });
  const files = [];
  try {
    files.push(await writeManagedFile(
      path.join(directories.pi, "models.json"),
      renderPi(baseUrls.pi, normalizedModels),
    ));
    files.push(await writeManagedFile(
      path.join(directories.omp, "models.yml"),
      renderOmp(baseUrls.omp, normalizedModels),
    ));
    files.push(await writeManagedFile(
      path.join(directories.dsh, "settings.yaml"),
      renderDsh(baseUrls["deepseek-harness"], normalizedModels),
    ));
    files.push(await writeManagedFile(
      path.join(directories.grok, "config.toml"),
      renderGrok(baseUrls.grok, normalizedModels),
    ));
  } catch (error) {
    await restoreHarnessConfigs(
      { schemaVersion: 1, root: safeRoot, files },
      { expectedRoot: safeRoot },
    );
    throw error;
  }

  return Object.freeze({
    environment: Object.freeze({
      CODEXHOST_PI_DATA_DIR: directories.pi,
      CODEXHOST_OMP_DATA_DIR: directories.omp,
      CODEXHOST_DSH_HOME: directories.dsh,
      CODEXHOST_GROK_HOME: directories.grok,
      // Grok ACP 1.0.13 的 initialize 元数据会漏掉磁盘自定义模型，Host 用同一份
      // 无凭据目录补全选择器；真正请求仍由 Grok 按 config.toml 走 Responses。
      CODEXHOST_GROK_MODELS_JSON: JSON.stringify(normalizedModels.map((model) => ({
        ...model,
        id: grokTransportModelId(model.id),
        upstreamId: model.id,
      }))),
      CODEXHOST_DEEPSEEK_HARNESS_ENDPOINT: `http://127.0.0.1:${dshPort}/`,
    }),
    ownership: Object.freeze({
      schemaVersion: 1,
      root: safeRoot,
      files: Object.freeze(files),
    }),
  });
}

/** 只删除指纹仍匹配的融合层配置，不递归删除 Harness 运行时产生的未知内容。 */
export async function restoreHarnessConfigs(ownership, { expectedRoot } = {}) {
  const root = requireAbsolutePath(ownership?.root, "Harness ownership root");
  const requiredRoot = requireAbsolutePath(expectedRoot, "Expected Harness ownership root");
  if (
    ownership?.schemaVersion !== 1
    || !Array.isArray(ownership.files)
    || pathKey(root) !== pathKey(requiredRoot)
  ) {
    throw new Error("harness_config_ownership_invalid");
  }
  const allowedRelativePaths = new Set([
    path.join("pi", "models.json").toLowerCase(),
    path.join("omp", "models.yml").toLowerCase(),
    path.join("dsh", "settings.yaml").toLowerCase(),
    path.join("grok", "config.toml").toLowerCase(),
  ]);
  const seen = new Set();
  const removed = [];
  const preserved = [];
  for (const entry of ownership.files) {
    const filePath = requireAbsolutePath(entry?.path, "Harness ownership path");
    const relative = path.relative(root, filePath);
    if (
      relative === ""
      || relative.startsWith("..")
      || path.isAbsolute(relative)
      || !allowedRelativePaths.has(relative.toLowerCase())
      || seen.has(relative.toLowerCase())
      || !/^[a-f0-9]{64}$/.test(entry?.sha256 ?? "")
    ) {
      throw new Error("harness_config_ownership_invalid");
    }
    seen.add(relative.toLowerCase());
    try {
      const info = await lstat(filePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        preserved.push(filePath);
        continue;
      }
      const contents = await readFile(filePath);
      if (sha256(contents) !== entry.sha256) {
        preserved.push(filePath);
        continue;
      }
      await unlink(filePath);
      removed.push(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return Object.freeze({ removed, preserved });
}
