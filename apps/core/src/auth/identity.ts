/**
 * Core's long-lived Ed25519 identity. Devices pin its public key when they pair, then use it to check
 * that they're talking to the same core and that a write approval really came from it.
 * The private key lives only in core's data dir (never inside the agent's computer).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface CoreIdentity {
  coreId: string;
  /** SPKI DER, base64. */
  publicKey: string;
  sign(text: string): string;
}

interface Stored {
  privateKey: string; // PKCS8 DER, base64
  publicKey: string; // SPKI DER, base64
}

export function loadOrCreateIdentity(dataDir: string): CoreIdentity {
  const file = path.join(dataDir, "core-identity.json");
  let stored: Stored | null = null;
  try {
    stored = JSON.parse(fs.readFileSync(file, "utf8")) as Stored;
  } catch {
    /* first run */
  }
  if (!stored?.privateKey || !stored.publicKey) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
    stored = {
      privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"),
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
    };
    fs.mkdirSync(dataDir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(stored), { mode: 0o600 });
    fs.renameSync(tmp, file);
  }
  const key = crypto.createPrivateKey({
    key: Buffer.from(stored.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  const coreId = `core_${crypto.createHash("sha256").update(stored.publicKey).digest("hex").slice(0, 20)}`;
  return {
    coreId,
    publicKey: stored.publicKey,
    sign: (text) => crypto.sign(null, Buffer.from(text), key).toString("base64"),
  };
}

/** Verify an Ed25519 signature made with an SPKI-DER (base64) public key. Never throws. */
export function verifySignature(publicKeyB64: string, text: string, signatureB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    if (key.asymmetricKeyType !== "ed25519") return false;
    return crypto.verify(null, Buffer.from(text), key, Buffer.from(signatureB64, "base64"));
  } catch {
    return false;
  }
}

export function isEd25519PublicKey(publicKeyB64: string): boolean {
  try {
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

export const randomHex = (bytes = 32) => crypto.randomBytes(bytes).toString("hex");

export const sha256Hex = (data: string | Buffer) => crypto.createHash("sha256").update(data).digest("hex");

/** Constant-time string compare (via hashes, so lengths don't leak). */
export function safeEqual(a: string, b: string): boolean {
  return crypto.timingSafeEqual(
    crypto.createHash("sha256").update(a).digest(),
    crypto.createHash("sha256").update(b).digest(),
  );
}
