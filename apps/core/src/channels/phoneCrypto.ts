/**
 * Yo Phone crypto (docs/phone/PROTOCOL.md "Keys" and "Envelopes"). WebCrypto only, so it matches
 * phone/lib/crypto.js byte for byte:
 *
 *   secret (32 bytes) --HKDF-SHA256, empty salt--> authToken ("yo-phone/v1/auth", 32 bytes, base64url)
 *                                               \-> encKey   ("yo-phone/v1/enc", AES-GCM 256)
 *   envelope = base64url(iv[12] || AES-GCM(encKey, iv, utf8(JSON), aad = "yo-phone/v1/<in|out>"))
 *
 * `in` is phone -> core and `out` is core -> phone; the AAD stops the relay from reflecting one as the other.
 */
import type { webcrypto } from "node:crypto";

/** phone -> core is "in", core -> phone is "out". */
export type PhoneDir = "in" | "out";

export interface PhoneKeys {
  /** Sent as `Authorization: Bearer <authToken>`; the relay hashes it into the mailbox id. */
  authToken: string;
  encKey: webcrypto.CryptoKey;
}

const subtle = () => globalThis.crypto.subtle;
const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();
const IV_BYTES = 12;

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64url");
}

export function fromBase64Url(s: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) throw new Error("not base64url");
  return new Uint8Array(Buffer.from(s, "base64url"));
}

/** A new pairing secret: 32 random bytes, base64url without padding (43 characters). */
export function randomSecret(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

export async function deriveKeys(secret: string): Promise<PhoneKeys> {
  const raw = fromBase64Url(secret);
  if (raw.length !== 32) throw new Error("A phone link secret must be 32 bytes.");
  const ikm = await subtle().importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info: string) => ({
    name: "HKDF",
    hash: "SHA-256",
    salt: new Uint8Array(0),
    info: utf8.encode(info),
  });
  const auth = await subtle().deriveBits(hkdf("yo-phone/v1/auth"), ikm, 256);
  const encKey = await subtle().deriveKey(
    hkdf("yo-phone/v1/enc"),
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { authToken: toBase64Url(new Uint8Array(auth)), encKey };
}

const aad = (dir: PhoneDir) => utf8.encode(`yo-phone/v1/${dir}`);

/** Encrypt a message. `iv` is only for test vectors; normally it's random. */
export async function seal(keys: PhoneKeys, obj: unknown, dir: PhoneDir, iv?: Uint8Array): Promise<string> {
  const nonce = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  if (nonce.length !== IV_BYTES) throw new Error("iv must be 12 bytes");
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(dir) },
      keys.encKey,
      utf8.encode(JSON.stringify(obj)),
    ),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, IV_BYTES);
  return toBase64Url(out);
}

/** Decrypt and parse an envelope. Throws if it's malformed, tampered with, or meant for the other direction. */
export async function open(keys: PhoneKeys, envelope: string, dir: PhoneDir): Promise<unknown> {
  const bytes = fromBase64Url(envelope);
  if (bytes.length < IV_BYTES + 16) throw new Error("envelope too short");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: aad(dir) },
    keys.encKey,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(fromUtf8.decode(pt));
}

/* ------------------------- v2: admission and signatures ------------------------- */

/** The relay's mailbox id for a token: hex(sha256(utf8(authToken))). */
export async function boxOf(authToken: string): Promise<string> {
  const d = new Uint8Array(await subtle().digest("SHA-256", utf8.encode(authToken)));
  return Buffer.from(d).toString("hex");
}

async function hmac(registerKey: string, msg: string): Promise<string> {
  const key = await subtle().importKey(
    "raw",
    utf8.encode(registerKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toBase64Url(new Uint8Array(await subtle().sign("HMAC", key, utf8.encode(msg))));
}

/** `admit`: in the link; every relay call sends it (X-Yo-Admit). */
export const admitFor = (registerKey: string, box: string) => hmac(registerKey, `yo-phone/v1/admit\n${box}`);

/** `coreCred`: core and relay only, never in the link (X-Yo-Core on core routes). */
export const coreCredFor = (registerKey: string, box: string) =>
  hmac(registerKey, `yo-phone/v1/core\n${box}`);

/** A link's signing key: the private key as PKCS8 and the raw public key, both base64url. */
export interface PhoneSignKey {
  pkcs8: string;
  pub: string;
}

/** A new Ed25519 key pair for a link (core signs every `out` envelope; the phone checks with `pub`). */
export async function newSignKey(): Promise<PhoneSignKey> {
  const pair = (await subtle().generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as webcrypto.CryptoKeyPair;
  const pkcs8 = new Uint8Array(await subtle().exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { pkcs8: toBase64Url(pkcs8), pub: toBase64Url(pub) };
}

export async function importSignKey(pkcs8: string): Promise<webcrypto.CryptoKey> {
  return subtle().importKey("pkcs8", fromBase64Url(pkcs8), { name: "Ed25519" }, false, ["sign"]);
}

/** `sig` for an out envelope: Ed25519 over utf8("yo-phone/v1/out\n" + envelope), base64url. */
export async function signOut(key: webcrypto.CryptoKey, envelope: string): Promise<string> {
  return toBase64Url(
    new Uint8Array(
      await subtle().sign({ name: "Ed25519" }, key, utf8.encode(`yo-phone/v1/out\n${envelope}`)),
    ),
  );
}

/* ------------------------- v2.1: pictures (blobs) ------------------------- */

/**
 * A picture travels as a blob beside the mailbox, not inside it: `base64url(iv || AES-GCM(encKey, iv, bytes, aad))`
 * with aad `yo-phone/v1/blob-<dir>\n<id>`, so a blob can't be passed off under another id or direction. The signed
 * message that points at it carries `hash` (sha256 of the bytes), checked after decrypting.
 */
const blobAad = (dir: PhoneDir, id: string) => utf8.encode(`yo-phone/v1/blob-${dir}\n${id}`);

export const BLOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A blob id: 16 random bytes, base64url (22 characters). */
export function randomBlobId(): string {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** base64url(sha256(bytes)) */
export async function hashOf(bytes: Uint8Array): Promise<string> {
  return toBase64Url(new Uint8Array(await subtle().digest("SHA-256", bytes)));
}

export async function sealBlob(
  keys: PhoneKeys,
  bytes: Uint8Array,
  dir: PhoneDir,
  id: string,
): Promise<string> {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: blobAad(dir, id) },
      keys.encKey,
      bytes,
    ),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, IV_BYTES);
  return toBase64Url(out);
}

/** Throws if the blob was tampered with, or belongs to another id or direction. */
export async function openBlob(
  keys: PhoneKeys,
  envelope: string,
  dir: PhoneDir,
  id: string,
): Promise<Uint8Array> {
  const bytes = fromBase64Url(envelope);
  if (bytes.length < IV_BYTES + 16) throw new Error("blob too short");
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: blobAad(dir, id) },
      keys.encKey,
      bytes.subarray(IV_BYTES),
    ),
  );
}
