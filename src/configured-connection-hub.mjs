import path from "node:path";

import { ConnectionActivityProbe } from "./connection-activity.mjs";
import { ConnectionPublicationState } from "./connection-publication-state.mjs";
import { createLocalConnectionHub } from "./local-connection-hub.mjs";
import { createSecurePromptAction } from "./local-connection-actions.mjs";
import { readFusionConfig } from "./local-runtime.mjs";
import { verifyRouterOverlay } from "./router-overlay-verifier.mjs";
import { prepareRouterOverlay } from "./router-overlay-installer.mjs";
import {
  RouterConnectionAdapter,
  createRouterCommandRunner,
  createRouterServiceRestarter,
} from "./router-connections-adapter.mjs";
import { SecretSessionBroker } from "./secret-session.mjs";

function lazyDelegate(load, method) {
  return async (...args) => {
    const target = await load();
    if (typeof target?.[method] !== "function") {
      throw new Error(`connection_${method}_unavailable`);
    }
    return target[method](...args);
  };
}

/**
 * 延迟读取本机配置，避免普通 doctor/launch 在未使用 Connections 时触碰 Router 管理面。
 */
export function createConfiguredConnectionHub({
  runtime,
  profiles,
  sources = [],
  sourceFactory = null,
  configPath = runtime?.configPath,
  readConfig = readFusionConfig,
  commandRunnerFactory = createRouterCommandRunner,
  serviceRestarterFactory = createRouterServiceRestarter,
  overlayVerifier = verifyRouterOverlay,
  overlayInstaller = prepareRouterOverlay,
  fetchImpl = globalThis.fetch,
  open = async () => Object.freeze({
    opened: true,
    surface: "codex-settings",
    section: "connections",
  }),
} = {}) {
  if (!runtime?.activity || typeof runtime.activity.inspect !== "function") {
    throw new Error("connection_runtime_activity_unavailable");
  }
  if (sourceFactory !== null && typeof sourceFactory !== "function") {
    throw new Error("connection_source_factory_invalid");
  }
  if (typeof overlayVerifier !== "function") throw new Error("router_overlay_verifier_invalid");
  if (typeof overlayInstaller !== "function") throw new Error("router_overlay_installer_invalid");
  let hubPromise = null;
  const load = () => {
    hubPromise ??= (async () => {
      const config = await readConfig(configPath);
      await overlayVerifier({ routerRoot: config.router.sourceRoot });
      const resolvedSources = sourceFactory ? await sourceFactory(config) : sources;
      const routerScript = path.join(config.router.sourceRoot, "codex-router.ps1");
      const run = commandRunnerFactory({ routerScript });
      const router = new RouterConnectionAdapter({
        run,
        restart: serviceRestarterFactory({ routerRoot: config.router.sourceRoot }),
        secretPrompt: createSecurePromptAction({ routerScript }),
        loginPlan: (id) => {
          const oauth = id.endsWith("-oauth")
            || new Set(["devin-cli", "github-copilot"]).has(id);
          return Object.freeze(oauth
            ? {
              target: `router:${id}`,
              command: process.execPath,
              args: [path.join(config.router.sourceRoot, "src", "control.mjs"), "login", id],
              cwd: config.router.sourceRoot,
            }
            : {
              target: `router:${id}`,
              command: "pwsh.exe",
              args: [
                "-NoLogo", "-NoProfile", "-File", routerScript,
                "provider-key", id, "set",
              ],
              cwd: config.router.sourceRoot,
            });
        },
      });
      const activity = new ConnectionActivityProbe({
        routerHealthUrl: config.router.healthUrl,
        fetchImpl,
        fusionActivity: () => runtime.activity.inspect(),
      });
      const secrets = new SecretSessionBroker({
        submitSecret: (input) => router.submitSecret(input),
      });
      const publication = new ConnectionPublicationState({ stateRoot: runtime.stateRoot });
      return createLocalConnectionHub({
        router,
        sources: resolvedSources,
        activity,
        profiles,
        runtime,
        secrets,
        publication,
        open,
      });
    })();
    // 初始化失败后允许修复配置再重试，而不是永久缓存拒绝态。
    hubPromise.catch(() => { hubPromise = null; });
    return hubPromise;
  };

  return Object.freeze({
    inspect: lazyDelegate(load, "inspect"),
    createCustom: lazyDelegate(load, "createCustom"),
    startLogin: lazyDelegate(load, "startLogin"),
    remove: lazyDelegate(load, "remove"),
    apply: lazyDelegate(load, "apply"),
    open: lazyDelegate(load, "open"),
    startSecretEntry: lazyDelegate(load, "startSecretEntry"),
    submitSecret: lazyDelegate(load, "submitSecret"),
    async prepareRouter({ backupDirectory } = {}) {
      const config = await readConfig(configPath);
      return overlayInstaller({
        routerRoot: config.router.sourceRoot,
        backupDirectory,
      });
    },
  });
}
