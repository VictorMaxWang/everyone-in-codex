import assert from "node:assert/strict";
import test from "node:test";

import {
  compareProductVersions,
  parseProductDistributionManifest,
  parseStableProductRelease,
  parseSha256Sums,
} from "../src/product-distribution.mjs";

const sourceCommit = "a".repeat(40);
const tree = "b".repeat(40);

function release(overrides = {}) {
  const version = overrides.version ?? "0.3.2";
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.com/VictorMaxWang/everyone-in-codex/releases/tag/v${version}`,
    body: "Release notes",
    assets: [
      {
        name: `everyone-codex-${version}-windows-x64.zip`,
        browser_download_url:
          `https://github.com/VictorMaxWang/everyone-in-codex/releases/download/v${version}/everyone-codex-${version}-windows-x64.zip`,
        size: 1024,
        digest: `sha256:${"1".repeat(64)}`,
      },
      {
        name: "SHA256SUMS.txt",
        browser_download_url:
          `https://github.com/VictorMaxWang/everyone-in-codex/releases/download/v${version}/SHA256SUMS.txt`,
        size: 256,
        digest: `sha256:${"2".repeat(64)}`,
      },
      {
        name: "MANIFEST.sha256",
        browser_download_url:
          `https://github.com/VictorMaxWang/everyone-in-codex/releases/download/v${version}/MANIFEST.sha256`,
        size: 512,
        digest: `sha256:${"3".repeat(64)}`,
      },
    ],
    ...overrides,
  };
}

test("产品版本比较只接受稳定 semver，并正确区分同版本与新版本", () => {
  assert.equal(compareProductVersions("0.3.1", "0.3.1"), 0);
  assert.equal(compareProductVersions("0.3.1", "0.3.2"), -1);
  assert.equal(compareProductVersions("0.4.0", "0.3.9"), 1);
  assert.throws(() => compareProductVersions("latest", "0.3.2"), /version_invalid/u);
});

test("Release 解析只接受本产品稳定资产，不会把 CodexHost 上游当成产品更新", () => {
  const parsed = parseStableProductRelease(release());
  assert.equal(parsed.version, "0.3.2");
  assert.equal(parsed.assets.windows.name, "everyone-codex-0.3.2-windows-x64.zip");

  assert.throws(
    () => parseStableProductRelease({
      ...release(),
      html_url: "https://github.com/BytePioneer-AI/codex-host/releases/tag/v0.4.0",
    }),
    /release_source_invalid/u,
  );
  assert.throws(
    () => parseStableProductRelease({ ...release(), prerelease: true }),
    /release_channel_invalid/u,
  );
});

test("Release 缺少或重复校验资产时失败关闭", () => {
  assert.throws(
    () => parseStableProductRelease({ ...release(), assets: release().assets.slice(0, 2) }),
    /release_asset_missing/u,
  );
  assert.throws(
    () => parseStableProductRelease({
      ...release(),
      assets: [...release().assets, release().assets[0]],
    }),
    /release_asset_duplicate/u,
  );
});

test("产品分发清单固定产品、通道、平台、source commit 与三个上游 tree", () => {
  const parsed = parseProductDistributionManifest({
    schemaVersion: 2,
    product: "everyone-in-codex",
    version: "0.3.1",
    channel: "stable",
    target: "windows-x64",
    sourceCommit,
    runtimeManifestSha256: "4".repeat(64),
    upstreams: {
      codexhost: { commit: sourceCommit, tree },
      router: { commit: sourceCommit, tree },
      webgpt: { commit: sourceCommit, tree },
    },
  });
  assert.equal(parsed.product, "everyone-in-codex");
  assert.equal(parsed.upstreams.router.tree, tree);

  assert.throws(
    () => parseProductDistributionManifest({ ...parsed, product: "codexhost" }),
    /distribution_manifest_invalid/u,
  );
});

test("SHA256SUMS 解析拒绝重复名称、路径和非 SHA-256 内容", () => {
  const sums = parseSha256Sums(`${"a".repeat(64)}  package.zip\n${"b".repeat(64)}  MANIFEST.sha256\n`);
  assert.equal(sums.get("package.zip"), "a".repeat(64));
  assert.throws(
    () => parseSha256Sums(`${"a".repeat(64)}  package.zip\n${"b".repeat(64)}  package.zip\n`),
    /checksum_duplicate/u,
  );
  assert.throws(() => parseSha256Sums(`${"a".repeat(64)}  ..\\package.zip\n`), /checksum_name_invalid/u);
});
