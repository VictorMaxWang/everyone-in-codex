import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { extractVerifiedZip } from "../src/safe-zip.mjs";

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.from(entry.data ?? "", "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE((3 << 8) | 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.externalAttributes ?? (entry.name.endsWith("/") ? 0x41ed0010 : 0x81a40000), 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDirectory.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, centralDirectory, eocd]);
}

async function fixture(t, entries) {
  const root = await mkdtemp(path.join(tmpdir(), "everyone-zip-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "fixture.zip");
  const destinationRoot = path.join(root, "expanded");
  await writeFile(archivePath, storedZip(entries));
  return { archivePath, destinationRoot };
}

test("安全解压只接受单一预期根目录并逐文件写入", async (t) => {
  const expectedRootName = "everyone-codex-0.3.1-windows-x64";
  const input = await fixture(t, [
    { name: `${expectedRootName}/` },
    { name: `${expectedRootName}/README.md`, data: "ok\n" },
    { name: `${expectedRootName}/src/cli.mjs`, data: "export {};\n" },
  ]);
  const result = await extractVerifiedZip({ ...input, expectedRootName });
  assert.equal(result.fileCount, 2);
  assert.equal(await readFile(path.join(result.rootPath, "README.md"), "utf8"), "ok\n");
});

test("安全解压拒绝 traversal、绝对路径、大小写重复与符号链接", async (t) => {
  const expectedRootName = "everyone-codex-0.3.1-windows-x64";
  const cases = [
    [{ name: `${expectedRootName}/../escape.txt`, data: "x" }, /zip_path_invalid/u],
    [{ name: `C:/${expectedRootName}/escape.txt`, data: "x" }, /zip_path_invalid/u],
    [
      [
        { name: `${expectedRootName}/A.txt`, data: "a" },
        { name: `${expectedRootName}/a.txt`, data: "b" },
      ],
      /zip_entry_duplicate/u,
    ],
    [
      { name: `${expectedRootName}/link`, data: "target", externalAttributes: 0xa1ff0000 },
      /zip_link_forbidden/u,
    ],
  ];
  for (const [entryOrEntries, error] of cases) {
    const input = await fixture(t, Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries]);
    await assert.rejects(extractVerifiedZip({ ...input, expectedRootName }), error);
  }
});

test("安全解压在条目或展开大小超过上限时失败关闭", async (t) => {
  const expectedRootName = "everyone-codex-0.3.1-windows-x64";
  const input = await fixture(t, [
    { name: `${expectedRootName}/one.txt`, data: "12345" },
    { name: `${expectedRootName}/two.txt`, data: "67890" },
  ]);
  await assert.rejects(
    extractVerifiedZip({
      ...input,
      expectedRootName,
      limits: { maxEntries: 1, maxTotalBytes: 100, maxFileBytes: 100 },
    }),
    /zip_entry_limit/u,
  );
});
