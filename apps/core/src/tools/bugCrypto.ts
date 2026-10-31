/**
 * Bug report encryption (docs/phone/PROTOCOL.md, "Bug mailbox"). A report is sealed to the owner's
 * bug-inbox public key with a one-time X25519 key (ECDH), HKDF-SHA256 and AES-256-GCM, so the relay and its
 * database only ever see ciphertext. The header fields (`v`, `install`, `epk`) are bound in as associated data.
 *
 * Plaintext: one line of JSON (the report's text fields) and a "\n", then the bundle zip's bytes (if any).
 */
import crypto from "node:crypto";
import type { BugEnvelope } from "@yo/contracts";

const INFO = "yo-bugs/v1/aes-256-gcm";
const PKCS8_X25519 = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519 = Buffer.from("302a300506032b656e032100", "hex");
const KEY_RE = /^[A-Za-z0-9_-]{43}$/;
const TAG_BYTES = 16;

function raw32(b64: string, what: string): Buffer {
  const buf = KEY_RE.test(b64) ? Buffer.from(b64, "base64url") : null;
  if (!buf || buf.length !== 32) throw new Error(`${what} must be 32 bytes in base64url`);
  return buf;
}

const publicKeyObject = (raw: Buffer) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: "der", type: "spki" });
const privateKeyObject = (raw: Buffer) =>
  crypto.createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: "der", type: "pkcs8" });

/** The public key (base64url) of a private key (base64url). Throws if it isn't one. */
export function bugInboxPublicKeyOf(privateKey: string): string {
  const pub = crypto.createPublicKey(privateKeyObject(raw32(privateKey, "The bug inbox key")));
  return pub.export({ format: "jwk" }).x as string;
}

/** For tests (the real pair comes from scripts/bug-inbox-keygen.mjs). */
export function newBugInboxKeyPair(): { privateKey: string; publicKey: string } {
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  return { privateKey: jwk.d as string, publicKey: jwk.x as string };
}

/** A short fingerprint to compare keys by eye: the first 16 hex of sha256(raw public key). */
export function bugKeyFingerprint(publicKey: string): string {
  return crypto.createHash("sha256").update(raw32(publicKey, "The key")).digest("hex").slice(0, 16);
}

/** What the relay sees instead of the install id: 32 hex characters of a hash of it. */
export function installHashOf(installId: string): string {
  return crypto.createHash("sha256").update(`yo-bug-install\n${installId}`).digest("hex").slice(0, 32);
}

const aad = (install: string, epk: string) => Buffer.from(`yo-bugs/v1\n${install}\n${epk}`, "utf8");

function aesKey(shared: Buffer, epk: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", shared, Buffer.concat([epk, recipient]), INFO, 32));
}

/** Encrypts `plaintext` to `recipientPublicKey`. A fresh one-time key and iv every time. */
export function sealBugReport(plaintext: Buffer, recipientPublicKey: string, install: string): BugEnvelope {
  if (!/^[0-9a-f]{32}$/.test(install)) throw new Error("install must be 32 hex characters");
  const recipient = raw32(recipientPublicKey, "The bug inbox public key");
  const eph = crypto.generateKeyPairSync("x25519");
  const epk = eph.publicKey.export({ format: "jwk" }).x as string;
  const shared = crypto.diffieHellman({ privateKey: eph.privateKey, publicKey: publicKeyObject(recipient) });
  const key = aesKey(shared, Buffer.from(epk, "base64url"), recipient);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(install, epk));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final(), cipher.getAuthTag()]);
  return { v: 1, install, epk, iv: iv.toString("base64url"), ct: ct.toString("base64url") };
}

/** Decrypts an envelope with the inbox's private key. Throws if anything in it was changed. */
export function openBugReport(env: BugEnvelope, privateKey: string): Buffer {
  if (env?.v !== 1 || typeof env.install !== "string" || typeof env.ct !== "string")
    throw new Error("Not a bug report envelope");
  const priv = privateKeyObject(raw32(privateKey, "The bug inbox key"));
  const recipient = Buffer.from(
    crypto.createPublicKey(priv).export({ format: "jwk" }).x as string,
    "base64url",
  );
  const epk = raw32(env.epk, "epk");
  const iv = Buffer.from(env.iv, "base64url");
  const ct = Buffer.from(env.ct, "base64url");
  if (iv.length !== 12 || ct.length < TAG_BYTES) throw new Error("Not a bug report envelope");
  const shared = crypto.diffieHellman({ privateKey: priv, publicKey: publicKeyObject(epk) });
  const decipher = crypto.createDecipheriv("aes-256-gcm", aesKey(shared, epk, recipient), iv);
  decipher.setAAD(aad(env.install, env.epk));
  decipher.setAuthTag(ct.subarray(ct.length - TAG_BYTES));
  try {
    return Buffer.concat([decipher.update(ct.subarray(0, ct.length - TAG_BYTES)), decipher.final()]);
  } catch {
    throw new Error("The report couldn't be opened (wrong key, or it was changed on the way)");
  }
}

/** The report's text fields and its bundle, as one plaintext. */
export function packBugReport(meta: Record<string, unknown>, zip: Buffer | null): Buffer {
  return Buffer.concat([Buffer.from(`${JSON.stringify(meta)}\n`, "utf8"), zip ?? Buffer.alloc(0)]);
}

export function unpackBugReport(plain: Buffer): { meta: Record<string, unknown>; zip: Buffer | null } {
  const nl = plain.indexOf(0x0a);
  if (nl < 0) throw new Error("Not a bug report");
  const meta = JSON.parse(plain.subarray(0, nl).toString("utf8"));
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Not a bug report");
  const zip = plain.length > nl + 1 ? plain.subarray(nl + 1) : null;
  return { meta, zip };
}
