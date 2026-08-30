import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SAFE_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

function childExit(child, errorCode) {
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new Error(errorCode)));
    child.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(errorCode));
    });
  });
}

export function createSecurePromptAction({
  routerScript,
  promptScript = path.join(MODULE_ROOT, "src", "connection-secret-prompt.ps1"),
  powershellExecutable = "pwsh.exe",
  spawnImpl = spawn,
} = {}) {
  return async (connectionId) => {
    if (!SAFE_ID.test(connectionId) || !path.isAbsolute(routerScript)) {
      throw new Error("connection_secure_prompt_target_invalid");
    }
    const child = spawnImpl(powershellExecutable, [
      "-NoLogo",
      "-NoProfile",
      "-File",
      promptScript,
      "-RouterScript",
      routerScript,
      "-ConnectionId",
      connectionId,
    ], {
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore"],
    });
    await childExit(child, "connection_secure_prompt_failed");
    return Object.freeze({ configured: true });
  };
}

export function createInteractiveLoginAction({
  spawnImpl = spawn,
  sourceEnvironment = process.env,
  powershellExecutable = "pwsh.exe",
  launcherScript = path.join(MODULE_ROOT, "src", "start-interactive-login.ps1"),
} = {}) {
  return async (plan) => {
    if (typeof plan?.command !== "string" || !plan.command) {
      return Object.freeze({ state: "waiting-user", message: "Open the owner login flow" });
    }
    const encodedPlan = Buffer.from(JSON.stringify({
      command: plan.command,
      args: Array.isArray(plan.args) ? plan.args : [],
      ...(typeof plan.cwd === "string" ? { cwd: plan.cwd } : {}),
      ...(plan.environment ? { environment: plan.environment } : {}),
    }), "utf8").toString("base64");
    const child = spawnImpl(powershellExecutable, [
      "-NoLogo",
      "-NoProfile",
      "-File",
      launcherScript,
      "-PlanBase64",
      encodedPlan,
    ], {
      env: sourceEnvironment,
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => {});
    child.unref?.();
    return Object.freeze({ state: "waiting-user", message: "Login window opened" });
  };
}

export function createApplyAction({
  configPath,
  nodeExecutable = process.execPath,
  helperPath = path.join(MODULE_ROOT, "src", "connections-apply-helper.mjs"),
  spawnImpl = spawn,
  sourceEnvironment = process.env,
} = {}) {
  return async () => {
    if (!path.isAbsolute(configPath)) throw new Error("connection_apply_config_invalid");
    const child = spawnImpl(nodeExecutable, [helperPath], {
      cwd: MODULE_ROOT,
      env: { ...sourceEnvironment, EVERYONE_CODEX_CONFIG: configPath },
      detached: true,
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => {});
    child.unref?.();
  };
}
