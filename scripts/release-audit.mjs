#!/usr/bin/env node

import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

const REQUIRED_PORTABLE_FILES = [
  "README.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "bin/everyone-codex.cmd",
  "src/cli.mjs",
  "runtime/node/node.exe",
  "runtime/node/LICENSE",
];

const ALLOWED_PORTABLE_PATHS = [
  /^(?:README\.md|LICENSE|THIRD_PARTY_NOTICES\.md|package\.json|release-manifest\.json)$/,
  /^bin\/everyone-codex\.cmd$/,
  /^src\/[A-Za-z0-9._/-]+\.(?:mjs|json|md)$/,
  /^locks\/[A-Za-z0-9._/-]+\.json$/,
  /^runtime\/node\/(?:node\.exe|LICENSE)$/,
  /^runtime\/codexhost\/[A-Za-z0-9._/-]+\.(?:exe|dll|node|js|mjs|cjs|json|wasm|pak|bin|dat|txt|md|html|css|png|ico)$/,
  /^licenses\/[A-Za-z0-9._/-]+\.(?:txt|md)$/,
];

const TEXT_EXTENSIONS = new Set([
  "",
  ".cmd",
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".mjs",
  ".patch",
  ".sha256",
  ".txt",
]);

const FORBIDDEN_CONTENT = [
  { name: "local drive path", pattern: /(?:^|[\s"'=(])(?:[A-Za-z]:[\\/])[^\s"'<>]*/m },
  { name: "Windows user profile", pattern: /\\Users\\[^\\\s"'<>]+/i },
  { name: "Codex 2 profile", pattern: /CodexProfiles[\\/]second/i },
  { name: "Codex task URL", pattern: /codex:\/\/threads\/[0-9a-f-]+/i },
  { name: "OpenAI-style API key", pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: "NVIDIA API key", pattern: /\bnvapi-[A-Za-z0-9_-]{20,}\b/i },
  { name: "bearer token", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i },
  {
    name: "assigned key or token",
    pattern: /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{20,}/i,
  },
];

function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

if (process.env.USERNAME && process.env.USERNAME.length >= 3) {
  // 当前构建账户名不应进入公开包；路径之外的诊断或 receipt 泄漏也会被拦截。
  FORBIDDEN_CONTENT.push({
    name: "local username",
    pattern: new RegExp(`\\b${escapeRegularExpression(process.env.USERNAME)}\\b`, "i"),
  });
}

function parseArguments(argv) {
  const options = { kind: "portable", root: null };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--root") {
      options.root = argv[++index];
    } else if (value === "--kind") {
      options.kind = argv[++index];
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!options.root) {
    throw new Error("--root is required");
  }
  if (options.kind !== "portable") {
    throw new Error(`Unsupported audit kind: ${options.kind}`);
  }
  return options;
}

function toPortablePath(root, absolutePath) {
  const candidate = relative(root, absolutePath).split(sep).join("/");
  if (!candidate || candidate === ".." || candidate.startsWith("../") || isAbsolute(candidate)) {
    throw new Error(`Path escapes release root: ${absolutePath}`);
  }
  return candidate;
}

function walkFiles(root, current = root, files = []) {
  const entries = readdirSync(current, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name, "en"),
  );
  for (const entry of entries) {
    const absolutePath = resolve(current, entry.name);
    const metadata = lstatSync(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release contains a symbolic link or reparse target: ${toPortablePath(root, absolutePath)}`);
    }
    if (metadata.isDirectory()) {
      walkFiles(root, absolutePath, files);
    } else if (metadata.isFile()) {
      files.push({ absolutePath, relativePath: toPortablePath(root, absolutePath), size: metadata.size });
    } else {
      throw new Error(`Release contains an unsupported filesystem entry: ${toPortablePath(root, absolutePath)}`);
    }
  }
  return files;
}

function extensionOf(relativePath) {
  const fileName = relativePath.slice(relativePath.lastIndexOf("/") + 1);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex === -1 ? "" : fileName.slice(dotIndex).toLowerCase();
}

function auditPortable(root) {
  const absoluteRoot = resolve(root);
  const rootMetadata = lstatSync(absoluteRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error("Release root must be a real directory");
  }

  const files = walkFiles(absoluteRoot);
  const fileNames = new Set(files.map(({ relativePath }) => relativePath));
  const missing = REQUIRED_PORTABLE_FILES.filter((file) => !fileNames.has(file));
  if (missing.length > 0) {
    throw new Error(`Release is missing required files: ${missing.join(", ")}`);
  }

  for (const file of files) {
    if (!ALLOWED_PORTABLE_PATHS.some((pattern) => pattern.test(file.relativePath))) {
      throw new Error(`Release file is not allowlisted: ${file.relativePath}`);
    }
    if (!TEXT_EXTENSIONS.has(extensionOf(file.relativePath))) {
      continue;
    }
    // 发行审计只读取允许的文本载荷；二进制由路径 allowlist 与打包阶段的来源约束保护。
    const content = readFileSync(file.absolutePath, "utf8");
    for (const forbidden of FORBIDDEN_CONTENT) {
      if (forbidden.pattern.test(content)) {
        throw new Error(`Release contains forbidden content (${forbidden.name}) in ${file.relativePath}`);
      }
    }
  }

  return {
    ok: true,
    kind: "portable",
    files: files.length,
    bytes: files.reduce((sum, file) => sum + file.size, 0),
  };
}

function main() {
  try {
    const options = parseArguments(process.argv.slice(2));
    const report = auditPortable(options.root);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stderr.write(`Release audit failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

main();
