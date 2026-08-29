#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { FusionGateway } from "./fusion-gateway.mjs";
import {
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
    || (expectedTarget === "external" && parsed.models.some((model) => (
      typeof model?.id !== "string" || model.id.startsWith("chatgpt-web/")
    )))
  ) {
    throw new Error("catalog_snapshot_invalid");
  }
  return parsed;
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
  const leases = [];
  const startIsolatedLease = async (target, catalog) => {
    const gateway = gatewayFactory({ routerBaseUrl }, target);
    const lease = await gateway.start({ models: catalog.models });
    leases.push(lease);
    const authorization = lease.authorizationHeaders().authorization;
    const match = /^Bearer (\S+)$/.exec(authorization);
    if (!match) throw new Error("gateway_consumer_capability_invalid");
    return {
      baseUrl: lease.baseUrl,
      capability: match[1],
      modelCount: lease.models.length,
      catalogRevision: catalog.catalogRevision,
    };
  };

  try {
    // 两份 allowlist 必须由两个独立 capability 保护，不得复用同一 lease。
    const codex = await startIsolatedLease("codex", codexCatalog);
    const external = await startIsolatedLease("external", externalCatalog);
    send({
      type: "ready",
      leaseId,
      pid,
      codex,
      external,
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
