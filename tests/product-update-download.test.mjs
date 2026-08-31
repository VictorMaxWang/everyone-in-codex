import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { stageProductRelease } from "../src/product-update-runtime.mjs";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

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
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? "", "utf8");
    const checksum = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
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
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.name.endsWith("/") ? 0x41ed0010 : 0x81a40000, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + data.length;
  }
  const directory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...localParts, directory, end]);
}

function releaseFixture() {
  const version = "0.3.3";
  const sourceCommit = "8".repeat(40);
  const root = `everyone-codex-${version}-windows-x64`;
  const payload = Buffer.from("resumable payload\n", "utf8");
  const manifest = Buffer.from(`${sha256(payload)}  runtime/payload.txt\n`, "utf8");
  const distribution = Buffer.from(`${JSON.stringify({
    schemaVersion: 2,
    product: "everyone-in-codex",
    version,
    channel: "stable",
    target: "windows-x64",
    sourceCommit,
    runtimeManifestSha256: sha256(manifest),
    upstreams: {
      codexhost: { commit: "1".repeat(40), tree: "2".repeat(40) },
      router: { commit: "3".repeat(40), tree: "4".repeat(40) },
      webgpt: { commit: "5".repeat(40), tree: "6".repeat(40) },
    },
  }, null, 2)}\n`, "utf8");
  const windows = storedZip([
    { name: `${root}/` },
    { name: `${root}/runtime/` },
    { name: `${root}/runtime/payload.txt`, data: payload },
    { name: `${root}/MANIFEST.sha256`, data: manifest },
    { name: `${root}/product-distribution.json`, data: distribution },
  ]);
  const checksums = Buffer.from(
    `${sha256(windows)}  everyone-codex-${version}-windows-x64.zip\n`
      + `${sha256(manifest)}  MANIFEST.sha256\n`,
    "utf8",
  );
  const base = `https://github.com/VictorMaxWang/everyone-in-codex/releases/download/v${version}`;
  const makeAsset = (name, body) => Object.freeze({
    name,
    size: body.length,
    digest: sha256(body),
    url: `${base}/${name}`,
  });
  return {
    payload,
    bodies: { windows, checksums, manifest },
    release: Object.freeze({
      version,
      sourceCommit,
      assets: Object.freeze({
        windows: makeAsset(`everyone-codex-${version}-windows-x64.zip`, windows),
        checksums: makeAsset("SHA256SUMS.txt", checksums),
        manifest: makeAsset("MANIFEST.sha256", manifest),
      }),
    }),
  };
}

test("正式资产下载中断后从已验证偏移继续，不重复完整 ZIP", async (t) => {
  const productRoot = await mkdtemp(path.join(tmpdir(), "everyone-update-resume-"));
  t.after(() => rm(productRoot, { recursive: true, force: true }));
  const fixture = releaseFixture();
  const windowsUrl = fixture.release.assets.windows.url;
  const split = Math.floor(fixture.bodies.windows.length / 2);
  const windowsRanges = [];

  const fetchImpl = async (input, init = {}) => {
    const url = String(input);
    if (url === windowsUrl) {
      const range = init.headers?.range;
      windowsRanges.push(range ?? null);
      if (windowsRanges.length === 1) {
        let step = 0;
        return new Response(new ReadableStream({
          pull(controller) {
            if (step === 0) {
              controller.enqueue(fixture.bodies.windows.subarray(0, split));
              step += 1;
              return;
            }
            controller.error(new TypeError("fetch failed"));
          },
        }), { status: 200 });
      }
      assert.equal(range, `bytes=${split}-`);
      return new Response(fixture.bodies.windows.subarray(split), {
        status: 206,
        headers: {
          "content-range": `bytes ${split}-${fixture.bodies.windows.length - 1}/${fixture.bodies.windows.length}`,
        },
      });
    }
    const entry = Object.entries(fixture.release.assets)
      .find(([, asset]) => asset.url === url);
    assert.ok(entry, `unexpected URL: ${url}`);
    return new Response(fixture.bodies[entry[0]], { status: 200 });
  };

  const record = await stageProductRelease({
    productRoot,
    release: fixture.release,
    fetchImpl,
    retryDelay: async () => {},
  });

  assert.deepEqual(windowsRanges, [null, `bytes=${split}-`]);
  assert.equal(record.version, "0.3.3");
  assert.equal(
    await readFile(path.join(productRoot, "versions", record.directory, "runtime/payload.txt"), "utf8"),
    fixture.payload.toString("utf8"),
  );
});
test("续传响应拒绝 Range 时失败关闭，不把完整响应追加到 partial", async (t) => {
  const productRoot = await mkdtemp(path.join(tmpdir(), "everyone-update-range-"));
  t.after(() => rm(productRoot, { recursive: true, force: true }));
  const fixture = releaseFixture();
  const split = Math.floor(fixture.bodies.windows.length / 2);
  let calls = 0;
  const fetchImpl = async (input) => {
    const url = String(input);
    if (url !== fixture.release.assets.windows.url) {
      const entry = Object.entries(fixture.release.assets).find(([, asset]) => asset.url === url);
      return new Response(fixture.bodies[entry[0]], { status: 200 });
    }
    calls += 1;
    if (calls === 1) {
      let step = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (step++ === 0) controller.enqueue(fixture.bodies.windows.subarray(0, split));
          else controller.error(new TypeError("fetch failed"));
        },
      }), { status: 200 });
    }
    return new Response(fixture.bodies.windows, { status: 200 });
  };

  await assert.rejects(
    stageProductRelease({
      productRoot,
      release: fixture.release,
      fetchImpl,
      retryDelay: async () => {},
    }),
    /product_update_resume_rejected/u,
  );
  assert.equal(calls, 2);
});

test("网络中断最多尝试五次，429 不进入重试循环", async (t) => {
  const fixture = releaseFixture();
  const transientRoot = await mkdtemp(path.join(tmpdir(), "everyone-update-retries-"));
  t.after(() => rm(transientRoot, { recursive: true, force: true }));
  let transientCalls = 0;
  await assert.rejects(
    stageProductRelease({
      productRoot: transientRoot,
      release: fixture.release,
      fetchImpl: async () => {
        transientCalls += 1;
        throw new TypeError("fetch failed");
      },
      retryDelay: async () => {},
    }),
    /fetch failed/u,
  );
  assert.equal(transientCalls, 5);

  const limitedRoot = await mkdtemp(path.join(tmpdir(), "everyone-update-429-"));
  t.after(() => rm(limitedRoot, { recursive: true, force: true }));
  let limitedCalls = 0;
  await assert.rejects(
    stageProductRelease({
      productRoot: limitedRoot,
      release: fixture.release,
      fetchImpl: async () => {
        limitedCalls += 1;
        return new Response(null, { status: 429 });
      },
    }),
    /product_update_rate_limited/u,
  );
  assert.equal(limitedCalls, 1);
});
