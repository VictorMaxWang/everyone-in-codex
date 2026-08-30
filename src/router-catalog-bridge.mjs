import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { selectCodex2NativeModels } from "./codex2-native-catalog.mjs";

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

function isWebGptModel(id) {
  return id.startsWith("chatgpt-web/");
}

function isNativeOpenAiModel(id) {
  return !id.includes("/") && /^(?:gpt|o\d|chatgpt)-/i.test(id);
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
    nativeCatalog = null,
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
    // 原生目录由 Codex 2 调用方显式注入，桥接层不自行寻找任何 Profile。
    this.nativeCatalog = nativeCatalog;
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
    const routedModels = extractVisible(snapshot.picker)
      .filter((id) => liveIds.has(id) && byId.has(id))
      // 原生条目只信任 Codex 2 独立目录，不能被 Router picker 旁路注入。
      .filter((id) => !isNativeOpenAiModel(id))
      .map((id) => Object.freeze({
        ...byId.get(id),
        source: isWebGptModel(id) ? "webgpt" : "router-provider",
      }));
    const nativeModels = this.nativeCatalog
      ? selectCodex2NativeModels(this.nativeCatalog)
      : [];
    const models = Object.freeze([...routedModels, ...nativeModels]);
    const catalogRevision = revisionFor(snapshot.revision, JSON.stringify(nativeModels));

    return Object.freeze({
      consumer: Object.freeze({
        kind,
        ...(typeof target?.harnessId === "string" ? { harnessId: target.harnessId } : {}),
      }),
      models,
      allowedModelIds: Object.freeze(models.map((model) => model.id)),
      catalogRevision,
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
