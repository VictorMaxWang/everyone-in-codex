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
    if (!new Set(["--config", "--catalog", "--lease"]).has(flag) || !value) {
      throw new Error("gateway_daemon_invalid_arguments");
    }
    result[flag.slice(2)] = value;
  }
  if (
    !path.isAbsolute(result.config ?? "")
    || !path.isAbsolute(result.catalog ?? "")
    || !LEASE_ID_PATTERN.test(result.lease ?? "")
  ) {
    throw new Error("gateway_daemon_invalid_arguments");
  }
  return result;
}

async function readCatalog(catalogPath) {
  const info = await lstat(catalogPath);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("catalog_snapshot_invalid");
  const parsed = JSON.parse(await readFile(catalogPath, "utf8"));
  if (
    parsed?.schemaVersion !== 1
    || parsed.target !== "codex"
    || typeof parsed.catalogRevision !== "string"
    || !Array.isArray(parsed.models)
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
  catalogPath,
  leaseId,
  pid = process.pid,
  send = (value) => process.send?.(value),
  gatewayFactory = (options) => new FusionGateway(options),
} = {}) {
  if (!LEASE_ID_PATTERN.test(leaseId ?? "") || typeof send !== "function") {
    throw new Error("gateway_daemon_invalid_arguments");
  }
  const config = await readFusionConfig(configPath);
  const catalog = await readCatalog(catalogPath);
  const callerSecret = await readRouterCallerSecret(config.router.stateDir);
  const gateway = gatewayFactory({
    routerBaseUrl: routerCapabilityBaseUrl(config, callerSecret),
  });
  const lease = await gateway.start({ models: catalog.models });
  const authorization = lease.authorizationHeaders().authorization;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) {
    await lease.close();
    throw new Error("gateway_consumer_capability_invalid");
  }

  try {
    send({
      type: "ready",
      leaseId,
      pid,
      baseUrl: lease.baseUrl,
      capability: match[1],
      modelCount: lease.models.length,
      catalogRevision: catalog.catalogRevision,
    });
  } catch (error) {
    await lease.close();
    throw error;
  }

  let closed = false;
  return Object.freeze({
    async close() {
      if (closed) return;
      closed = true;
      await lease.close();
    },
  });
}

export async function main({ argv = process.argv.slice(2) } = {}) {
  try {
    if (typeof process.send !== "function") throw new Error("gateway_daemon_requires_ipc");
    const parsed = parseArguments(argv);
    const service = await startGatewayDaemonService({
      configPath: parsed.config,
      catalogPath: parsed.catalog,
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
