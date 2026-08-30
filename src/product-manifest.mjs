import { readFile } from "node:fs/promises";
import path from "node:path";

import { parseProductDistributionManifest } from "./product-distribution.mjs";

/**
 * 发布包读取生成的 schema v2 清单；源码工作树只构造不可安装的开发身份，
 * 这样 Fusion 仍会屏蔽 stock CodexHost updater，但不会把未提交源码当成发布包。
 */
export async function readCurrentProductManifest({ packageRoot } = {}) {
  if (typeof packageRoot !== "string" || !path.isAbsolute(packageRoot)) {
    throw new Error("product_package_root_invalid");
  }
  try {
    const manifest = parseProductDistributionManifest(
      JSON.parse(await readFile(path.join(packageRoot, "product-distribution.json"), "utf8")),
    );
    return Object.freeze({ manifest, development: false });
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const [pkg, upstream, router] = await Promise.all([
    readFile(path.join(packageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, "locks", "upstream.lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(packageRoot, "locks", "router-v030.lock.json"), "utf8").then(JSON.parse),
  ]);
  const manifest = parseProductDistributionManifest({
    schemaVersion: 2,
    product: "everyone-in-codex",
    version: pkg.version,
    channel: "stable",
    target: "windows-x64",
    sourceCommit: "0".repeat(40),
    runtimeManifestSha256: "0".repeat(64),
    upstreams: {
      codexhost: {
        commit: upstream.codexhost.commit,
        tree: upstream.codexhost.patchedTree,
      },
      router: {
        commit: router.upstreamCommit,
        tree: router.patchedTree,
      },
      webgpt: {
        commit: upstream.webgpt.integrationCommit,
        tree: upstream.webgpt.integrationTree,
      },
    },
  });
  return Object.freeze({ manifest, development: true });
}
