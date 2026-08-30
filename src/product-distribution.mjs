const STABLE_VERSION_PATTERN = /^\d+\.\d+\.\d+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const GIT_OBJECT_PATTERN = /^[a-f0-9]{40}$/u;
const RELEASE_PREFIX = "https://github.com/VictorMaxWang/everyone-in-codex/releases/";
const DOWNLOAD_PREFIX = `${RELEASE_PREFIX}download/`;

export const PRODUCT_RELEASE_REPOSITORY = "VictorMaxWang/everyone-in-codex";

function requireStableVersion(value) {
  if (typeof value !== "string" || !STABLE_VERSION_PATTERN.test(value)) {
    throw new Error("version_invalid");
  }
  const parts = value.split(".").map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part))) throw new Error("version_invalid");
  return Object.freeze(parts);
}

/** 只比较产品稳定版本；预发布版本不会进入 stable 更新通道。 */
export function compareProductVersions(left, right) {
  const leftParts = requireStableVersion(left);
  const rightParts = requireStableVersion(right);
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] < rightParts[index]) return -1;
    if (leftParts[index] > rightParts[index]) return 1;
  }
  return 0;
}

function requireGitObject(value) {
  if (typeof value !== "string" || !GIT_OBJECT_PATTERN.test(value)) {
    throw new Error("distribution_manifest_invalid");
  }
  return value;
}

function parseUpstream(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("distribution_manifest_invalid");
  }
  return Object.freeze({
    commit: requireGitObject(value.commit),
    tree: requireGitObject(value.tree),
  });
}

/** 校验随发布包携带的产品身份，避免把任一上游组件误装成融合产品。 */
export function parseProductDistributionManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("distribution_manifest_invalid");
  }
  if (
    value.schemaVersion !== 2
    || value.product !== "everyone-in-codex"
    || value.channel !== "stable"
    || value.target !== "windows-x64"
    || typeof value.runtimeManifestSha256 !== "string"
    || !SHA256_PATTERN.test(value.runtimeManifestSha256)
    || !value.upstreams
  ) {
    throw new Error("distribution_manifest_invalid");
  }
  requireStableVersion(value.version);
  return Object.freeze({
    schemaVersion: 2,
    product: "everyone-in-codex",
    version: value.version,
    channel: "stable",
    target: "windows-x64",
    sourceCommit: requireGitObject(value.sourceCommit),
    runtimeManifestSha256: value.runtimeManifestSha256,
    upstreams: Object.freeze({
      codexhost: parseUpstream(value.upstreams.codexhost),
      router: parseUpstream(value.upstreams.router),
      webgpt: parseUpstream(value.upstreams.webgpt),
    }),
  });
}

function parseReleaseAsset(asset, expectedName, tag) {
  if (!asset || typeof asset !== "object" || asset.name !== expectedName) {
    throw new Error("release_asset_invalid");
  }
  if (!Number.isSafeInteger(asset.size) || asset.size < 1) {
    throw new Error("release_asset_invalid");
  }
  const digestMatch = /^sha256:([a-f0-9]{64})$/u.exec(asset.digest ?? "");
  if (!digestMatch) throw new Error("release_asset_digest_missing");
  const expectedPrefix = `${DOWNLOAD_PREFIX}${tag}/`;
  let url;
  try {
    url = new URL(asset.browser_download_url);
  } catch {
    throw new Error("release_asset_url_invalid");
  }
  if (
    !url.href.startsWith(expectedPrefix)
    || url.pathname.split("/").at(-1) !== encodeURIComponent(expectedName)
    || url.username
    || url.password
    || url.search
    || url.hash
  ) {
    throw new Error("release_asset_url_invalid");
  }
  return Object.freeze({
    name: expectedName,
    url: url.href,
    size: asset.size,
    digest: digestMatch[1],
  });
}

/** 从 GitHub latest Release 中只选取融合产品自己的三个受信资产。 */
export function parseStableProductRelease(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("release_invalid");
  }
  const version = String(value.tag_name ?? "").replace(/^v/u, "");
  requireStableVersion(version);
  const tag = `v${version}`;
  if (value.draft !== false || value.prerelease !== false) {
    throw new Error("release_channel_invalid");
  }
  if (value.html_url !== `${RELEASE_PREFIX}tag/${tag}`) {
    throw new Error("release_source_invalid");
  }
  if (!Array.isArray(value.assets)) throw new Error("release_asset_missing");
  const expected = Object.freeze({
    windows: `everyone-codex-${version}-windows-x64.zip`,
    checksums: "SHA256SUMS.txt",
    manifest: "MANIFEST.sha256",
  });
  const selected = {};
  for (const [kind, name] of Object.entries(expected)) {
    const matches = value.assets.filter((asset) => asset?.name === name);
    if (matches.length === 0) throw new Error(`release_asset_missing:${name}`);
    if (matches.length !== 1) throw new Error(`release_asset_duplicate:${name}`);
    selected[kind] = parseReleaseAsset(matches[0], name, tag);
  }
  return Object.freeze({
    version,
    tag,
    releaseNotes: typeof value.body === "string" && value.body.trim() ? value.body.slice(0, 20_000) : null,
    releaseNotesUrl: value.html_url,
    assets: Object.freeze(selected),
  });
}

/** 解析发布校验和；只接受同目录文件名，避免校验目标被路径语法替换。 */
export function parseSha256Sums(text) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw new Error("checksum_manifest_invalid");
  }
  const result = new Map();
  for (const line of text.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/u.exec(line);
    if (!match || match[2] === "." || match[2] === ".." || match[2].includes(":")) {
      throw new Error("checksum_name_invalid");
    }
    if (result.has(match[2])) throw new Error("checksum_duplicate");
    result.set(match[2], match[1]);
  }
  if (result.size === 0) throw new Error("checksum_manifest_invalid");
  return result;
}
