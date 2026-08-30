#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { createLocalFusionController } from "./fusion-controller.mjs";

const SECRET_FLAGS = new Set([
  "--api-key",
  "--authorization",
  "--caller-capability",
  "--cookie",
  "--oauth-token",
  "--token",
]);

function usage(message) {
  throw new Error(`用法错误：${message}`);
}

function ensureNoCredentialFlags(argv) {
  for (const raw of argv) {
    const flag = raw.split("=", 1)[0].toLowerCase();
    if (SECRET_FLAGS.has(flag)) {
      throw new Error(`CLI 禁止接收凭据参数 ${flag}`);
    }
  }
}

function parseOptions(tokens, allowed) {
  const result = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const raw = tokens[index];
    if (!raw.startsWith("--")) {
      usage(`不支持额外位置参数 ${raw}`);
    }
    const equalIndex = raw.indexOf("=");
    const name = equalIndex === -1 ? raw : raw.slice(0, equalIndex);
    if (!Object.hasOwn(allowed, name)) {
      throw new Error(`未知参数 ${name}`);
    }
    if (Object.hasOwn(result, allowed[name])) {
      usage(`参数 ${name} 不得重复`);
    }
    const value =
      equalIndex === -1 ? tokens[(index += 1)] : raw.slice(equalIndex + 1);
    if (value === undefined || value === "" || value.startsWith("--")) {
      usage(`参数 ${name} 缺少值`);
    }
    result[allowed[name]] = value;
  }
  return result;
}

function requireFields(value, fields, label) {
  const missing = fields.filter((field) => !value[field]);
  if (missing.length > 0) {
    usage(`${label} 缺少 ${missing.join(", ")}`);
  }
}

/** 把 argv 解析为稳定、无凭据的 FusionController 命令对象。 */
export function parseCli(argv) {
  if (!Array.isArray(argv) || argv.length === 0) {
    usage("需要命令");
  }
  ensureNoCredentialFlags(argv);

  const [group, action, subject, ...rest] = argv;
  if (group === "doctor" && argv.length === 1) {
    return { command: "doctor" };
  }
  if (group === "launch" && argv.length === 1) {
    return { command: "launch" };
  }
  if (group === "restore") {
    const options = parseOptions(argv.slice(1), { "--lease": "leaseId" });
    requireFields(options, ["leaseId"], "restore");
    return { command: "restore", leaseId: options.leaseId };
  }

  if (group === "profile") {
    if (action === "list" && argv.length === 2) {
      return { command: "profile.list" };
    }
    if (action === "use" && subject && argv.length === 3) {
      return { command: "profile.use", name: subject };
    }
    if (action === "add" && subject) {
      const options = parseOptions(rest, {
        "--codex-home": "codexHome",
        "--sqlite-home": "sqliteHome",
        "--desktop-root": "desktopRoot",
        "--desktop-user-data": "desktopUserData",
      });
      requireFields(
        options,
        ["codexHome", "sqliteHome", "desktopRoot", "desktopUserData"],
        "profile add",
      );
      return { command: "profile.add", profile: { name: subject, ...options } };
    }
    usage("profile add|list|use");
  }

  if (group === "harness") {
    if (action === "list" && argv.length === 2) {
      return { command: "harness.list" };
    }
    if (
      new Set(["install", "login", "remove"]).has(action) &&
      subject &&
      argv.length === 3
    ) {
      return { command: `harness.${action}`, id: subject };
    }
    if (action === "adopt" && subject) {
      const options = parseOptions(rest, {
        "--path": "commandPath",
        "--version": "version",
      });
      requireFields(options, ["commandPath", "version"], "harness adopt");
      return {
        command: "harness.adopt",
        harness: { id: subject, ...options },
      };
    }
    usage("harness adopt|install|login|list|remove");
  }

  if (group === "models" && action === "sync") {
    const options = parseOptions(argv.slice(2), { "--target": "target" });
    return { command: "models.sync", target: options.target ?? "codex" };
  }

  if (group === "setup" && argv.length === 1) {
    return { command: "connections.open" };
  }

  if (group === "connections") {
    if (action === "list" && argv.length === 2) return { command: "connections.list" };
    if (action === "apply" && argv.length === 2) return { command: "connections.apply" };
    if (action === "prepare-router") {
      const options = parseOptions(argv.slice(2), { "--backup-directory": "backupDirectory" });
      requireFields(options, ["backupDirectory"], "connections prepare-router");
      return { command: "connections.prepare-router", backupDirectory: options.backupDirectory };
    }
    if (action === "login" && subject && argv.length === 3) {
      return { command: "connections.login", target: subject };
    }
    if (action === "remove" && subject && argv.length === 3) {
      return { command: "connections.remove", id: subject };
    }
    if (action === "add") {
      const options = parseOptions(argv.slice(2), {
        "--label": "label",
        "--base-url": "baseUrl",
        "--protocol": "protocol",
        "--models": "models",
        "--keyless": "keyless",
      });
      requireFields(options, ["label", "baseUrl", "protocol", "models"], "connections add");
      const modelIds = [...new Set(options.models.split(",").map((id) => id.trim()).filter(Boolean))];
      if (modelIds.length === 0) usage("connections add 缺少有效 models");
      if (options.keyless !== undefined && !new Set(["true", "false"]).has(options.keyless)) {
        usage("connections add --keyless 只接受 true 或 false");
      }
      return {
        command: "connections.add",
        draft: {
          label: options.label,
          baseUrl: options.baseUrl,
          protocol: options.protocol,
          keyless: options.keyless === "true",
          models: modelIds.map((id) => ({ id })),
        },
      };
    }
    usage("connections add|apply|list|login|prepare-router|remove");
  }

  throw new Error(`未知命令 ${group}`);
}

async function dispatch(parsed, controller) {
  switch (parsed.command) {
    case "doctor":
      return controller.inspect();
    case "profile.add":
      return controller.addProfile(parsed.profile);
    case "profile.list":
      return controller.listProfiles();
    case "profile.use":
      return controller.useProfile(parsed.name);
    case "harness.adopt":
      return controller.adoptHarness(parsed.harness);
    case "harness.install":
      return controller.installHarness(parsed.id);
    case "harness.login":
      return controller.loginHarness(parsed.id);
    case "harness.list":
      return controller.listHarnesses();
    case "harness.remove":
      return controller.removeHarness(parsed.id);
    case "models.sync":
      return controller.syncModels({ target: parsed.target });
    case "connections.open":
      return controller.openConnections();
    case "connections.list":
      return controller.listConnections();
    case "connections.add":
      {
        const created = await controller.createConnection(parsed.draft);
        if (!parsed.draft.keyless) {
          await controller.startConnectionSecretEntry({
            ownerId: created.id,
            mode: "secure-prompt",
          });
        }
        return created;
      }
    case "connections.login":
      return typeof controller.executeConnectionLogin === "function"
        ? controller.executeConnectionLogin(parsed.target)
        : controller.loginConnection(parsed.target);
    case "connections.remove":
      return controller.removeConnection(parsed.id);
    case "connections.apply":
      return controller.applyConnections();
    case "connections.prepare-router":
      return controller.prepareConnectionRouter({ backupDirectory: parsed.backupDirectory });
    case "launch":
      return controller.launch();
    case "restore":
      return controller.restore({ leaseId: parsed.leaseId });
    default:
      throw new Error(`未实现命令 ${parsed.command}`);
  }
}

/** 执行一个已支持的 CLI 命令并输出 JSON；所有副作用由注入的 Controller 决定。 */
export async function executeCli(
  argv,
  { controller, stdout = process.stdout } = {},
) {
  if (!controller) {
    throw new Error("executeCli 需要显式 Controller");
  }
  const result = await dispatch(parseCli(argv), controller);
  stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** CLI 进程入口，返回退出码而不直接终止宿主进程。 */
export async function main({
  argv = process.argv.slice(2),
  stdout = process.stdout,
  stderr = process.stderr,
  controller = createLocalFusionController(),
} = {}) {
  try {
    await executeCli(argv, { controller, stdout });
    return 0;
  } catch (error) {
    stderr.write(`${error?.message ?? "CLI 执行失败"}\n`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
