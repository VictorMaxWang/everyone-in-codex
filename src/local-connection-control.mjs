import path from "node:path";

import { ConnectionActivityProbe } from "./connection-activity.mjs";
import { ConnectionControl } from "./connection-control.mjs";
import { createConnectionSources } from "./connection-sources.mjs";
import { createConfiguredConnectionHub } from "./configured-connection-hub.mjs";
import {
  createApplyAction,
  createInteractiveLoginAction,
  createSecurePromptAction,
} from "./local-connection-actions.mjs";

/** 为当前 Codex 2 Fusion 租约装配 Renderer 可用的无凭据 Connections 控制面。 */
export function createLocalConnectionControl({
  config,
  configPath,
  runtime,
  registry,
  fetchImpl = globalThis.fetch,
  spawnImpl,
  sourceEnvironment = process.env,
} = {}) {
  const profiles = Object.freeze({ getActive: async () => config.profile });
  const sources = createConnectionSources({
    profile: config.profile,
    webgptHealthUrl: config.webgpt.healthUrl,
    registry,
    fetchImpl,
  });
  const hub = createConfiguredConnectionHub({
    runtime,
    profiles,
    sources,
    configPath,
    fetchImpl,
  });
  const activity = new ConnectionActivityProbe({
    routerHealthUrl: config.router.healthUrl,
    fetchImpl,
    fusionActivity: () => runtime.activity.inspect(),
  });
  const routerScript = path.join(config.router.sourceRoot, "codex-router.ps1");
  return new ConnectionControl({
    hub,
    activity,
    securePrompt: createSecurePromptAction({ routerScript, spawnImpl }),
    interactiveLogin: createInteractiveLoginAction({ spawnImpl, sourceEnvironment }),
    startApply: createApplyAction({
      configPath,
      nodeExecutable: config.runtime.nodeExecutable,
      spawnImpl,
      sourceEnvironment,
    }),
  });
}
