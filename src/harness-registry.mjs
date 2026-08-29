import {
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

const SPEC_DATA = [
  {
    id: "pi",
    displayName: "Pi",
    version: "0.84.4",
    defaultCommand: "pi",
    compatibility: "full",
    routerProtocol: "openai-responses",
    commandEnvironment: "CODEXHOST_PI_COMMAND",
    login: {
      args: [],
      instruction: "请在可见交互终端中启动 Pi，并使用 /login 完成登录。",
    },
  },
  {
    id: "omp",
    displayName: "OMP",
    version: "18.0.10",
    defaultCommand: "omp",
    compatibility: "inference-only",
    routerProtocol: "openai-responses",
    commandEnvironment: "CODEXHOST_OMP_COMMAND",
    login: {
      args: [],
      instruction: "请在可见交互终端中启动 OMP，并使用 /login 完成登录。",
    },
  },
  {
    id: "deepseek-harness",
    displayName: "DeepSeek Harness",
    version: "0.1.1-rc.2",
    defaultCommand: "dsh",
    compatibility: "full-preview",
    routerProtocol: "openai-responses",
    commandEnvironment: "CODEXHOST_DEEPSEEK_HARNESS_COMMAND",
    login: {
      args: ["--profile", "tui"],
      instruction:
        "请在可见交互终端中启动 DeepSeek Harness，并在其设置界面完成登录。",
    },
  },
  {
    id: "grok",
    displayName: "Grok",
    version: "1.0.13",
    defaultCommand: "grok",
    compatibility: "probe-required",
    routerProtocol: "openai-responses",
    commandEnvironment: "CODEXHOST_GROK_COMMAND",
    login: {
      args: ["login"],
      instruction: "请在可见交互终端中完成 Grok 登录。",
    },
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    version: "2.1.220",
    defaultCommand: "claude",
    compatibility: "native-only",
    routerProtocol: null,
    commandEnvironment: "CODEXHOST_CLAUDE_COMMAND",
    login: {
      args: ["auth", "login"],
      instruction: "请在可见交互终端中完成 Claude Code 登录。",
    },
  },
];

/**
 * Harness 能力表是公开发行契约。这里只描述路径和能力，不保存任何认证值。
 */
export const DEFAULT_HARNESS_SPECS = Object.freeze(
  SPEC_DATA.map((spec) =>
    Object.freeze({
      ...spec,
      login: Object.freeze({ ...spec.login, args: Object.freeze([...spec.login.args]) }),
    }),
  ),
);

const SPEC_BY_ID = new Map(DEFAULT_HARNESS_SPECS.map((spec) => [spec.id, spec]));

async function readState(stateFile) {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8"));
    if (parsed.schemaVersion !== 1 || typeof parsed.harnesses !== "object") {
      throw new Error("Harness 登记文件格式不受支持");
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { schemaVersion: 1, harnesses: {} };
    }
    throw error;
  }
}

async function writeState(stateFile, state) {
  await mkdir(path.dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  try {
    await rename(temporary, stateFile);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

function requireSpec(id) {
  const spec = SPEC_BY_ID.get(id);
  if (!spec) {
    throw new Error(`未知 Harness：${id ?? "<missing>"}`);
  }
  return spec;
}

function toPublicRecord(record) {
  const spec = requireSpec(record.id);
  return {
    id: record.id,
    version: record.version,
    commandPath: record.commandPath,
    managed: false,
    compatibility: spec.compatibility,
    routerProtocol: spec.routerProtocol,
    commandEnvironment: spec.commandEnvironment,
  };
}

/**
 * 管理外部 Harness 的采用记录。Registry 永远不拥有命令文件，也不处理登录凭据。
 */
export class HarnessRegistry {
  constructor({ stateFile } = {}) {
    if (!stateFile || !path.isAbsolute(stateFile)) {
      throw new Error("Harness stateFile 必须是绝对路径");
    }
    this.stateFile = path.resolve(stateFile);
  }

  async adopt({ id, version, commandPath } = {}) {
    const spec = requireSpec(id);
    if (version !== spec.version) {
      throw new Error(
        `${spec.displayName} 必须使用锁定版本 ${spec.version}，收到 ${version ?? "<missing>"}`,
      );
    }
    if (!commandPath || !path.isAbsolute(commandPath)) {
      throw new Error(`${spec.displayName} commandPath 必须是绝对路径`);
    }

    const resolvedCommand = path.resolve(commandPath);
    const commandStat = await stat(resolvedCommand).catch((error) => {
      if (error?.code === "ENOENT") {
        throw new Error(`${spec.displayName} 命令文件不存在：${resolvedCommand}`);
      }
      throw error;
    });
    if (!commandStat.isFile()) {
      throw new Error(`${spec.displayName} commandPath 必须指向文件`);
    }

    const state = await readState(this.stateFile);
    // adopt 只记录外部程序的不可变事实；绝不复制、移动或更新该程序。
    state.harnesses[id] = {
      id,
      version,
      commandPath: resolvedCommand,
    };
    await writeState(this.stateFile, state);
    return toPublicRecord(state.harnesses[id]);
  }

  async list() {
    const state = await readState(this.stateFile);
    return DEFAULT_HARNESS_SPECS.flatMap((spec) => {
      const record = state.harnesses[spec.id];
      return record ? [toPublicRecord(record)] : [];
    });
  }

  async remove(id) {
    requireSpec(id);
    const state = await readState(this.stateFile);
    const existing = state.harnesses[id];
    if (!existing) {
      return { id, removed: false, commandPath: null };
    }

    delete state.harnesses[id];
    await writeState(this.stateFile, state);
    return { id, removed: true, commandPath: existing.commandPath };
  }

  async login(id) {
    const spec = requireSpec(id);
    const state = await readState(this.stateFile);
    const record = state.harnesses[id];
    const command = record?.commandPath ?? spec.defaultCommand;
    return {
      id,
      interactive: true,
      visibleTerminalRequired: true,
      command,
      args: [...spec.login.args],
      instruction: spec.login.instruction,
    };
  }

  async install(id) {
    const spec = requireSpec(id);
    return {
      id,
      version: spec.version,
      action: "download-required",
      executed: false,
      reason: "安装必须由锁文件驱动的公开 bootstrap 流程在可见终端中执行。",
    };
  }
}
