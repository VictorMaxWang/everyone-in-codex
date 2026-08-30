#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { FusionGateway } from "./fusion-gateway.mjs";
import { parseCodex2AuthJson } from "./codex2-native-catalog.mjs";
import { HarnessRegistry } from "./harness-registry.mjs";
import { createLocalConnectionControl } from "./local-connection-control.mjs";
import {
  LocalFusionRuntime,
  readFusionConfig,
  readRouterCallerSecret,
  routerCapabilityBaseUrl,
} from "./local-runtime.mjs";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";

const LEASE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (
      !new Set(["--config", "--codex-catalog", "--external-catalog", "--lease"]).has(flag)
      || !value
    ) {
      throw new Error("gateway_daemon_invalid_arguments");
    }
    result[flag.slice(2)] = value;
  }
  if (
    !path.isAbsolute(result.config ?? "")
    || !path.isAbsolute(result["codex-catalog"] ?? "")
    || !path.isAbsolute(result["external-catalog"] ?? "")
    || !LEASE_ID_PATTERN.test(result.lease ?? "")
  ) {
    throw new Error("gateway_daemon_invalid_arguments");
  }
  return result;
}

async function readCatalog(catalogPath, expectedTarget) {
  const info = await lstat(catalogPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("catalog_snapshot_invalid");
  const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  if (
    parsed?.schemaVersion !== 1
    || parsed.target !== expectedTarget
    || typeof parsed.catalogRevision !== "string"
    || !Array.isArray(parsed.models)
    || parsed.models.some((model) => typeof model?.id !== "string")
  ) {
    throw new Error("catalog_snapshot_invalid");
  }
  return parsed;
}

async function readCodex2NativeSession(config) {
  const authPath = path.join(config.profile.codexHome, "auth.json");
  const info = await lstat(authPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("codex2_auth_invalid");
  const session = parseCodex2AuthJson(await readFile(authPath, "utf8"));
  // API-key 模式只有显式绑定官方端点时才可用；自定义 Provider key 绝不能外送。
  if (session.kind === "api-key" && !config.nativeOpenAi?.apiBaseUrl) return null;
  return session;
}

/**
 * 启动子进程内的 Gateway。Router capability 仅从 stateDir 读取并留在该进程内存。
 */
export async function startGatewayDaemonService({
  configPath,
  codexCatalogPath,
  externalCatalogPath,
  leaseId,
  pid = process.pid,
  send = (value) => process.send?.(value),
  gatewayFactory = (options) => new FusionGateway(options),
  connectionControlFactory = createLocalConnectionControl,
  nativeFetch = globalThis.fetch,
} = {}) {
  if (!LEASE_ID_PATTERN.test(leaseId ?? "") || typeof send !== "function") {
    throw new Error("gateway_daemon_invalid_arguments");
  }
  const config = await readFusionConfig(configPath);
  const [codexCatalog, externalCatalog] = await Promise.all([
    readCatalog(codexCatalogPath, "codex"),
    readCatalog(externalCatalogPath, "external"),
  ]);
  const callerSecret = await readRouterCallerSecret(config.router.stateDir);
  const routerBaseUrl = routerCapabilityBaseUrl(config, callerSecret);
  const stateRoot = path.dirname(codexCatalogPath);
  const registry = new HarnessRegistry({ stateFile: path.join(stateRoot, "harnesses.json") });
  const localRuntime = new LocalFusionRuntime({
    configPath,
    stateRoot,
    harnesses: registry,
  });
  const connectionControl = connectionControlFactory({
    config,
    configPath,
    runtime: localRuntime,
    registry,
  });
  const gateway = gatewayFactory({
    routerBaseUrl,
    nativeOpenAiBaseUrl: config.nativeOpenAi?.apiBaseUrl ?? null,
    nativeFetch,
    connectionControl,
    nativeOpenAiSessionProvider: async () => {
      try {
        return await readCodex2NativeSession(config);
      } catch {
        return null;
      }
    },
  });
  const leases = [];
  const startIsolatedLease = async (consumerId, catalog, protocol = "openai-responses") => {
    const lease = await gateway.start({
      models: catalog.models,
      consumerId,
      harnessId: consumerId,
      protocol,
    });
    leases.push(lease);
    const authorization = lease.authorizationHeaders().authorization;
    const match = /^Bearer (\S+)$/.exec(authorization);
    if (!match) throw new Error("gateway_consumer_capability_invalid");
    return {
      baseUrl: lease.baseUrl,
      capability: match[1],
      modelCount: lease.models.length,
      catalogRevision: catalog.catalogRevision,
      protocol,
    };
  };

  try {
    // 两份 allowlist 必须由两个独立 capability 保护，不得复用同一 lease。
    const codex = await startIsolatedLease("codex", codexCatalog);
    const harnesses = {};
    // 顺序启动保证任一后继失败时 catch 已持有并可关闭此前的全部 server。
    for (const harnessId of ["pi", "omp", "deepseek-harness", "grok"]) {
      harnesses[harnessId] = await startIsolatedLease(harnessId, externalCatalog);
    }
    harnesses["claude-code"] = await startIsolatedLease(
      "claude-code",
      externalCatalog,
      "anthropic-messages",
    );
    const controlHeaders = leases[1]?.controlAuthorizationHeaders?.();
    const controlMatch = /^Bearer (\S+)$/.exec(controlHeaders?.authorization ?? "");
    if (!controlMatch) throw new Error("gateway_host_capability_invalid");
    send({
      type: "ready",
      leaseId,
      pid,
      codex,
      harnesses,
      control: {
        baseUrl: harnesses.pi.baseUrl,
        capability: controlMatch[1],
      },
    });
  } catch (error) {
    await Promise.allSettled(leases.map((lease) => lease.close()));
    throw error;
  }

  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) return;
      closed = true;
      const results = await Promise.allSettled(leases.map((lease) => lease.close()));
      const failed = results.find((result) => result.status === "rejected");
      if (failed) throw failed.reason;
    },
  });
}

export async function main({ argv = process.argv.slice(2) } = {}) {
  try {
    if (typeof process.send !== "function") throw new Error("gateway_daemon_requires_ipc");
    const parsed = parseArguments(argv);
    const service = await startGatewayDaemonService({
      configPath: parsed.config,
      codexCatalogPath: parsed["codex-catalog"],
      externalCatalogPath: parsed["external-catalog"],
      leaseId: parsed.lease,
    });
    const close = async () => {
      await service.close().catch(() => {});
      process.exitCode = 0;
    };
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    process.once("disconnect", close);
    return 0;
  } catch {
    // 错误详情可能包含 capability URL；子进程只发稳定错误码。
    process.stderr.write("gateway_daemon_failed\n");
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
