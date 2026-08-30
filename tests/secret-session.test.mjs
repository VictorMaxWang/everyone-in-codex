import assert from "node:assert/strict";
import test from "node:test";

import {
  SecretSessionBroker,
  encryptSecretForSession,
} from "../src/secret-session.mjs";

test("遮罩输入只提交一次 RSA-OAEP 密文，明文不进入公开 receipt", async () => {
  const received = [];
  let currentTime = 1_000;
  const broker = new SecretSessionBroker({
    now: () => currentTime,
    submitSecret: async ({ ownerId, secret }) => {
      received.push({ ownerId, secret: secret.toString("utf8") });
      return { configured: true };
    },
  });
  const session = await broker.start({ ownerId: "custom-lab" });
  const plaintext = "fixture-secret-never-log";
  const ciphertext = encryptSecretForSession(session.publicKeyJwk, plaintext);

  assert.match(session.publicKeySpkiBase64, /^[A-Za-z0-9+/]+={0,2}$/u);
  assert.equal(ciphertext.includes(plaintext), false);
  assert.equal(JSON.stringify(session).includes(plaintext), false);
  assert.deepEqual(await broker.submit({ operationId: session.operationId, ciphertext }), {
    configured: true,
  });
  assert.deepEqual(received, [{ ownerId: "custom-lab", secret: plaintext }]);
  await assert.rejects(
    broker.submit({ operationId: session.operationId, ciphertext }),
    /secret_session_invalid/,
  );

  const expired = await broker.start({ ownerId: "custom-expired" });
  currentTime = expired.expiresAt;
  await assert.rejects(
    broker.submit({
      operationId: expired.operationId,
      ciphertext: encryptSecretForSession(expired.publicKeyJwk, "expired-secret"),
    }),
    /secret_session_expired/,
  );

  const pending = await broker.start({ ownerId: "pending-custom-connection" });
  await broker.submit({
    operationId: pending.operationId,
    ownerId: "custom-rebound",
    ciphertext: encryptSecretForSession(pending.publicKeyJwk, "rebound-secret"),
  });
  assert.deepEqual(received.at(-1), { ownerId: "custom-rebound", secret: "rebound-secret" });
});
