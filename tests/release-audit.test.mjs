import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const auditScript = join(repoRoot, "scripts", "release-audit.mjs");
const bootstrapScript = join(repoRoot, "scripts", "bootstrap.ps1");
const packageScript = join(repoRoot, "scripts", "package-windows.ps1");

function write(root, relativePath, content = "fixture\n") {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function createPortableFixture(root) {
  write(root, "README.md", "# Portable fixture\n");
  write(root, "LICENSE", "MIT License\n");
  write(root, "THIRD_PARTY_NOTICES.md", "# Notices\n");
  write(root, "package.json", '{"name":"fixture","version":"1.2.3","type":"module"}\n');
  write(root, "bin/everyone-codex.cmd", "@echo off\r\n");
  write(root, "src/cli.mjs", 'if (process.argv.includes("--help")) console.log("help");\n');
  write(root, "runtime/node/node.exe", "fixture-binary");
  write(root, "runtime/node/LICENSE", "Node.js license fixture\n");
}

function runAudit(root) {
  return spawnSync(process.execPath, [auditScript, "--root", root, "--kind", "portable"], {
    encoding: "utf8",
    windowsHide: true,
  });
}

test("portable release audit accepts only the documented public payload", () => {
  const root = mkdtempSync(join(tmpdir(), "everyone-audit-valid-"));
  try {
    createPortableFixture(root);
    write(root, "locks/toolchains.lock.json", '{"schemaVersion":1,"node":"22.22.0"}\n');

    const result = runAudit(root);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.kind, "portable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable release audit rejects a file outside the release allowlist", () => {
  const root = mkdtempSync(join(tmpdir(), "everyone-audit-extra-"));
  try {
    createPortableFixture(root);
    write(root, "logs/session.log", "must not ship\n");

    const result = runAudit(root);

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not allowlisted/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("portable release audit rejects local identity and credential traces", async (t) => {
  const cases = [
    ["drive path", String.raw`D:\private\workspace`],
    ["Windows username", String.raw`C:\Users\example\AppData`],
    ["Codex 2 profile", String.raw`CodexProfiles\second`],
    ["Codex task URL", `codex://${"threads"}/00000000-0000-0000-0000-000000000000`],
    ["API key", `sk-${"a".repeat(40)}`],
    ["bearer token", `Bearer ${"b".repeat(40)}`],
    ...(process.env.USERNAME ? [["current username", `build owner: ${process.env.USERNAME}`]] : []),
  ];

  for (const [name, secretLikeText] of cases) {
    await t.test(name, () => {
      const root = mkdtempSync(join(tmpdir(), "everyone-audit-sensitive-"));
      try {
        createPortableFixture(root);
        write(root, "README.md", `# Portable fixture\n${secretLikeText}\n`);

        const result = runAudit(root);

        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /forbidden content/i);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test(
  "Windows bootstrap adopts an exact Node distribution into the repo-local toolchain root",
  { skip: process.platform !== "win32" },
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "everyone-bootstrap-root-"));
    const nodeRoot = mkdtempSync(join(tmpdir(), "everyone-bootstrap-node-"));
    try {
      write(
        fixtureRoot,
        "locks/toolchains.lock.json",
        `${JSON.stringify({
          schemaVersion: 1,
          node: process.versions.node,
          npm: "11.8.0",
          rust: "1.97.1",
          bun: "1.4.0",
        })}\n`,
      );
      write(nodeRoot, "LICENSE", "Node.js license fixture\n");
      try {
        linkSync(process.execPath, join(nodeRoot, "node.exe"));
      } catch {
        copyFileSync(process.execPath, join(nodeRoot, "node.exe"));
      }

      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          bootstrapScript,
          "-RepoRoot",
          fixtureRoot,
          "-NodeRoot",
          nodeRoot,
        ],
        { encoding: "utf8", windowsHide: true },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const report = JSON.parse(result.stdout);
      assert.equal(report.node.ready, true);
      assert.equal(
        existsSync(join(fixtureRoot, ".toolchains", "node", process.versions.node, "node.exe")),
        true,
      );
      for (const tool of ["npm", "rust", "bun"]) {
        assert.equal(existsSync(join(fixtureRoot, ".toolchains", tool)), true);
      }
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(nodeRoot, { recursive: true, force: true });
    }
  },
);

test(
  "Windows packager emits an audited portable ZIP and SHA256SUMS entry",
  { skip: process.platform !== "win32" },
  () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "everyone-package-root-"));
    const outputRoot = mkdtempSync(join(tmpdir(), "everyone-package-output-"));
    const nodeRoot = mkdtempSync(join(tmpdir(), "everyone-package-node-"));
    const expandedRoot = mkdtempSync(join(tmpdir(), "everyone-package-expanded-"));

    try {
      write(fixtureRoot, "README.md", "# Package fixture\n");
      write(fixtureRoot, "LICENSE", "MIT License\n");
      write(fixtureRoot, "THIRD_PARTY_NOTICES.md", "# Notices\n");
      write(
        fixtureRoot,
        "package.json",
        '{"name":"everyone-in-codex","version":"9.8.7","type":"module"}\n',
      );
      write(fixtureRoot, "src/cli.mjs", 'if (process.argv.includes("--help")) console.log("help");\n');
      write(
        fixtureRoot,
        "locks/toolchains.lock.json",
        `${JSON.stringify({ schemaVersion: 1, node: process.versions.node })}\n`,
      );
      write(fixtureRoot, "locks/upstream.lock.json", '{"schemaVersion":1}\n');
      write(fixtureRoot, "patches/codexhost/0001.patch", "patch fixture\n");
      write(nodeRoot, "LICENSE", "Node.js license fixture\n");
      try {
        linkSync(process.execPath, join(nodeRoot, "node.exe"));
      } catch {
        copyFileSync(process.execPath, join(nodeRoot, "node.exe"));
      }

      const result = spawnSync(
        "pwsh.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-NonInteractive",
          "-File",
          packageScript,
          "-RepoRoot",
          fixtureRoot,
          "-OutputDirectory",
          outputRoot,
          "-NodeRoot",
          nodeRoot,
        ],
        { encoding: "utf8", windowsHide: true },
      );

      assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
      const zipName = "everyone-codex-9.8.7-windows-x64.zip";
      const zipPath = join(outputRoot, zipName);
      assert.equal(existsSync(zipPath), true);
      const expectedHash = createHash("sha256").update(readFileSync(zipPath)).digest("hex");
      assert.equal(readFileSync(join(outputRoot, "SHA256SUMS.txt"), "utf8"), `${expectedHash}  ${zipName}\n`);

      execFileSync("tar.exe", ["-xf", zipPath, "-C", expandedRoot], { windowsHide: true });
      const releaseRoot = join(expandedRoot, "everyone-codex-9.8.7-windows-x64");
      assert.deepEqual(
        readdirSync(join(releaseRoot, "runtime", "node")).sort(),
        ["LICENSE", "node.exe"],
      );
      assert.equal(existsSync(join(releaseRoot, "bin", "everyone-codex.cmd")), true);
      assert.equal(existsSync(join(releaseRoot, "patches")), false);
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
      rmSync(outputRoot, { recursive: true, force: true });
      rmSync(nodeRoot, { recursive: true, force: true });
      rmSync(expandedRoot, { recursive: true, force: true });
    }
  },
);
