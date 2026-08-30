import {
  constants,
  createPublicKey,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomUUID,
} from "node:crypto";

const OWNER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
// RSA-2048 + OAEP/SHA-256 的单块明文上限是 190 bytes；更长输入必须拒绝，
// 不能依赖 WebCrypto/Node 在深层抛出难以分类的加密错误。
const MAX_SECRET_BYTES = 190;
const PENDING_OWNER = "pending-custom-connection";

export function encryptSecretForSession(publicKeyJwk, value) {
  const secret = Buffer.from(String(value), "utf8");
  if (secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
    throw new Error("secret_value_invalid");
  }
  try {
    return publicEncrypt({
      key: createPublicKey({ key: publicKeyJwk, format: "jwk" }),
      oaepHash: "sha256",
      padding: constants.RSA_PKCS1_OAEP_PADDING,
    }, secret).toString("base64url");
  } finally {
    secret.fill(0);
  }
}

/** 一次性本机密钥入口；公开 receipt 只含公钥，私钥和明文均不序列化。 */
export class SecretSessionBroker {
  #sessions = new Map();

  constructor({ submitSecret, now = Date.now, ttlMs = 120_000 } = {}) {
    if (
      typeof submitSecret !== "function"
      || typeof now !== "function"
      || !Number.isSafeInteger(ttlMs)
      || ttlMs < 1
      || ttlMs > 120_000
    ) {
      throw new Error("secret_session_dependency_invalid");
    }
    this.submitSecret = submitSecret;
    this.now = now;
    this.ttlMs = ttlMs;
  }

  async start({ ownerId } = {}) {
    if (typeof ownerId !== "string" || !OWNER_PATTERN.test(ownerId)) {
      throw new Error("secret_owner_invalid");
    }
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicExponent: 0x10001,
    });
    const operationId = randomUUID();
    const expiresAt = this.now() + this.ttlMs;
    this.#sessions.set(operationId, { ownerId, privateKey, expiresAt });
    return Object.freeze({
      operationId,
      expiresAt,
      algorithm: "RSA-OAEP-256",
      publicKeyJwk: Object.freeze(publicKey.export({ format: "jwk" })),
      publicKeySpkiBase64: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    });
  }

  async submit({ operationId, ciphertext, ownerId } = {}) {
    if (typeof operationId !== "string" || typeof ciphertext !== "string") {
      throw new Error("secret_session_invalid");
    }
    const session = this.#sessions.get(operationId);
    if (!session) throw new Error("secret_session_invalid");
    this.#sessions.delete(operationId);
    if (this.now() >= session.expiresAt) throw new Error("secret_session_expired");
    const targetOwnerId = session.ownerId === PENDING_OWNER ? ownerId : session.ownerId;
    if (typeof targetOwnerId !== "string" || !OWNER_PATTERN.test(targetOwnerId)) {
      throw new Error("secret_owner_invalid");
    }
    let secret;
    try {
      const encrypted = Buffer.from(ciphertext, "base64url");
      secret = privateDecrypt({
        key: session.privateKey,
        oaepHash: "sha256",
        padding: constants.RSA_PKCS1_OAEP_PADDING,
      }, encrypted);
      if (secret.length < 1 || secret.length > MAX_SECRET_BYTES) {
        throw new Error("secret_value_invalid");
      }
      return await this.submitSecret({ ownerId: targetOwnerId, secret });
    } catch (error) {
      if (error?.message === "secret_value_invalid") throw error;
      throw new Error("secret_session_invalid");
    } finally {
      secret?.fill(0);
    }
  }
}
