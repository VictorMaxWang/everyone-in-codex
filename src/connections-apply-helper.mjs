import { setTimeout as delay } from "node:timers/promises";

import { main } from "./cli.mjs";

// 先让 Settings RPC 返回，再开始会精确结束当前 Fusion 租约的应用事务。
await delay(500);
process.exitCode = await main({ argv: ["connections", "apply"] });
