#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with exit code ${result.status}\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function repositoryFiles() {
  const output = run("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  return output
    .split("\0")
    .filter(Boolean)
    .map((file) => file.split("/").join(sep))
    .sort((left, right) => left.localeCompare(right, "en"));
}

function parseJson(relativePath) {
  const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
  try {
    return JSON.parse(content);
  } catch (error) {
    throw new Error(`${relativePath} is not valid JSON: ${error.message}`);
  }
}

function checkPowerShell(relativePath) {
  const command = [
    "$tokens = $null",
    "$errors = $null",
    "[void][System.Management.Automation.Language.Parser]::ParseFile($env:EVERYONE_CODEX_CHECK_FILE, [ref]$tokens, [ref]$errors)",
    "if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }",
  ].join("; ");
  run("pwsh.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command], {
    env: { ...process.env, EVERYONE_CODEX_CHECK_FILE: resolve(repoRoot, relativePath) },
  });
}

function scanForCredentialShapes(files) {
  const textExtensions = new Set([".cmd", ".json", ".md", ".mjs", ".patch", ".ps1", ".txt", ".yml", ".yaml"]);
  const patterns = [
    /\bsk-[A-Za-z0-9_-]{20,}\b/,
    /\bnvapi-[A-Za-z0-9_-]{20,}\b/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}\b/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{20,}/i,
  ];

  for (const relativePath of files) {
    if (!textExtensions.has(extname(relativePath).toLowerCase())) {
      continue;
    }
    const content = readFileSync(resolve(repoRoot, relativePath), "utf8");
    for (const pattern of patterns) {
      const match = content.match(pattern)?.[0];
      if (match && !/(?:dummy|example|fixture|test|secret[-_]?value)/i.test(match)) {
        throw new Error(`Credential-shaped content found in ${relativePath}`);
      }
    }
  }
}

function main() {
  const files = repositoryFiles();
  const forbiddenNames = files.filter((file) =>
    /(?:^|[\\/])(?:\.runtime|\.state|\.toolchains|artifacts|logs|node_modules)(?:[\\/]|$)/i.test(file),
  );
  if (forbiddenNames.length > 0) {
    throw new Error(`Generated/runtime files are visible to Git: ${forbiddenNames.join(", ")}`);
  }

  const required = [
    "package.json",
    "locks/toolchains.lock.json",
    "locks/upstream.lock.json",
    "locks/harnesses.lock.json",
    "scripts/bootstrap.ps1",
    "scripts/check-sources.mjs",
    "scripts/package-windows.ps1",
    "scripts/release-audit.mjs",
    "src/cli.mjs",
  ];
  const normalizedFiles = new Set(files.map((file) => file.split(sep).join("/")));
  const missing = required.filter((file) => !normalizedFiles.has(file));
  if (missing.length > 0) {
    throw new Error(`Required source files are missing: ${missing.join(", ")}`);
  }

  const packageJson = parseJson("package.json");
  const toolchains = parseJson("locks/toolchains.lock.json");
  const upstream = parseJson("locks/upstream.lock.json");
  const harnesses = parseJson("locks/harnesses.lock.json");
  for (const relativePath of files.filter((file) => extname(file).toLowerCase() === ".json")) {
    parseJson(relativePath);
  }
  if (packageJson.bin?.["everyone-codex"] !== "./src/cli.mjs") {
    throw new Error("package.json must expose ./src/cli.mjs as everyone-codex");
  }
  for (const [name, value] of Object.entries({
    node: toolchains.node,
    npm: toolchains.npm,
    rust: toolchains.rust,
    bun: toolchains.bun,
  })) {
    if (typeof value !== "string" || !/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(value)) {
      throw new Error(`Toolchain lock has an invalid ${name} version`);
    }
  }
  if (upstream.schemaVersion !== 1 || harnesses.schemaVersion !== 1 || !Array.isArray(harnesses.harnesses)) {
    throw new Error("Upstream and Harness locks must use schemaVersion 1");
  }

  for (const relativePath of files.filter((file) => extname(file).toLowerCase() === ".mjs")) {
    run(process.execPath, ["--check", resolve(repoRoot, relativePath)]);
  }
  for (const relativePath of files.filter((file) => extname(file).toLowerCase() === ".ps1")) {
    checkPowerShell(relativePath);
  }
  scanForCredentialShapes(files);

  process.stdout.write(`${JSON.stringify({ ok: true, files: files.length })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`Source check failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
