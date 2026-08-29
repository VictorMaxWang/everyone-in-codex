import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const DEFAULT_STABILITY_ATTEMPTS = 3;

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is not valid JSON`, { cause: error });
  }
}

function modelId(model) {
  return typeof model?.id === "string"
    ? model.id
    : typeof model?.slug === "string"
      ? model.slug
      : null;
}

function extractModels(document) {
  const candidates = Array.isArray(document)
    ? document
    : Array.isArray(document?.models)
      ? document.models
      : Array.isArray(document?.data)
        ? document.data
        : [];

  return candidates
    .map((model) => ({ ...model, id: modelId(model) }))
    .filter((model) => model.id);
}

function extractVisible(document) {
  const candidates = Array.isArray(document?.visible)
    ? document.visible
    : Array.isArray(document?.models)
      ? document.models
      : [];

  return candidates
    .map((entry) => (typeof entry === "string" ? entry : modelId(entry)))
    .filter(Boolean);
}

function isNativeOpenAiModel(id) {
  // Provider 前缀是外部路由身份的一部分；只排除没有 Provider 的原生 GPT 条目。
  return !id.includes("/") && /^(?:gpt|o\d|chatgpt)-/i.test(id);
}

function isWebGptModel(id) {
  return id.startsWith("chatgpt-web/");
}

function revisionFor(...texts) {
  return createHash("sha256").update(texts.join("\u0000")).digest("hex");
}

export class RouterCatalogBridge {
  constructor({
    mergedModelsPath,
    modelPickerPath,
    routerModelsUrl,
    fetchImpl = globalThis.fetch,
    readTextFile = (filePath) => readFile(filePath, "utf8"),
    stabilityAttempts = DEFAULT_STABILITY_ATTEMPTS,
  }) {
    if (!mergedModelsPath || !modelPickerPath || !routerModelsUrl) {
      throw new TypeError("mergedModelsPath, modelPickerPath and routerModelsUrl are required");
    }
    if (typeof fetchImpl !== "function" || typeof readTextFile !== "function") {
      throw new TypeError("fetchImpl and readTextFile must be functions");
    }

    this.mergedModelsPath = mergedModelsPath;
    this.modelPickerPath = modelPickerPath;
    this.routerModelsUrl = routerModelsUrl;
    this.fetchImpl = fetchImpl;
    this.readTextFile = readTextFile;
    this.stabilityAttempts = Math.max(1, Number(stabilityAttempts) || DEFAULT_STABILITY_ATTEMPTS);
  }

  async activate(target) {
    const kind = target?.kind
      ?? (target?.target === "codex"
        ? "codex"
        : target?.target === "external"
          ? "external-harness"
          : null);
    if (kind !== "codex" && kind !== "external-harness") {
      throw new TypeError("target must select codex or external-harness");
    }

    const snapshot = await this.#readStableSnapshot();
    const response = await this.fetchImpl(this.routerModelsUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response?.ok) {
      throw new Error("router_models_unavailable");
    }

    const liveModels = extractModels(await response.json());
    const liveIds = new Set(liveModels.map((model) => model.id));
    const byId = new Map(extractModels(snapshot.merged).map((model) => [model.id, model]));
    const models = extractVisible(snapshot.picker)
      .filter((id) => liveIds.has(id) && byId.has(id))
      .filter((id) => !isNativeOpenAiModel(id))
      .filter((id) => kind === "codex" || !isWebGptModel(id))
      .map((id) => Object.freeze({ ...byId.get(id) }));

    return Object.freeze({
      consumer: Object.freeze({
        kind,
        ...(typeof target?.harnessId === "string" ? { harnessId: target.harnessId } : {}),
      }),
      models: Object.freeze(models),
      allowedModelIds: Object.freeze(models.map((model) => model.id)),
      catalogRevision: snapshot.revision,
    });
  }

  async #readStableSnapshot() {
    for (let attempt = 0; attempt < this.stabilityAttempts; attempt += 1) {
      const firstMerged = await this.readTextFile(this.mergedModelsPath);
      const firstPicker = await this.readTextFile(this.modelPickerPath);
      const secondMerged = await this.readTextFile(this.mergedModelsPath);
      const secondPicker = await this.readTextFile(this.modelPickerPath);

      if (firstMerged === secondMerged && firstPicker === secondPicker) {
        return {
          merged: parseJson(firstMerged, "merged-models"),
          picker: parseJson(firstPicker, "model-picker"),
          revision: revisionFor(firstMerged, firstPicker),
        };
      }
    }

    throw new Error("catalog_unstable");
  }
}
