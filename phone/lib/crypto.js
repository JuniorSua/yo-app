// Yo Phone crypto (docs/phone/PROTOCOL.md). Plain ESM that runs in browsers and Node 22 via
// globalThis.crypto.subtle. The core mirrors this in apps/core/src/channels/phoneCrypto.ts and both sides
// check phone/test/vector.json.

const subtle = () => globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export const DIRS = /** @type {const} */ (["in", "out"]);
const IV_BYTES = 12;
const TAG_BYTES = 16;
/** Shortest possible envelope: a 12-byte iv plus a 16-byte tag over an empty plaintext, in base64url. */
export const MIN_ENVELOPE_CHARS = Math.ceil(((IV_BYTES + TAG_BYTES) * 4) / 3);
const B64URL_RE = /^[A-Za-z0-9_-]*$/;

/** @param {Uint8Array} bytes */
export function toB64url(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** @param {string} str */
export function fromB64url(str) {
  if (typeof str !== "string" || !B64URL_RE.test(str) || str.length % 4 === 1) {
    throw new Error("Not base64url");
  }
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** @param {string} str */
export function isB64url(str) {
  return typeof str === "string" && B64URL_RE.test(str) && str.length % 4 !== 1;
}

/** 32 random bytes as base64url (43 characters). */
export function randomSecret() {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(32)));
}

/** A short random id for messages (dedupe key on the core). */
export function randomId() {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(12)));
}

/**
 * HKDF-SHA256 (empty salt) from the 32-byte link secret.
 * @param {string} secretB64url
 * @returns {Promise<{authToken: string, encKey: CryptoKey}>}
 */
export async function deriveKeys(secretB64url) {
  const raw = fromB64url(secretB64url);
  if (raw.length !== 32) throw new Error("The phone link secret must be 32 bytes");
  const ikm = await subtle().importKey("raw", raw, "HKDF", false, ["deriveBits", "deriveKey"]);
  const hkdf = (info) => ({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: enc.encode(info) });
  const authBits = await subtle().deriveBits(hkdf("yo-phone/v1/auth"), ikm, 256);
  const encKey = await subtle().deriveKey(
    hkdf("yo-phone/v1/enc"),
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  return { authToken: toB64url(new Uint8Array(authBits)), encKey };
}

/** Mailbox id the relay derives from the auth token: hex(sha256(utf8(authToken))). */
export async function boxFor(authToken) {
  const hash = new Uint8Array(await subtle().digest("SHA-256", enc.encode(authToken)));
  return Array.from(hash, (b) => b.toString(16).padStart(2, "0")).join("");
}
/** @deprecated name from v1; same as boxFor */
export const boxId = boxFor;

async function hmacB64url(key, message) {
  const k = await subtle().importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return toB64url(new Uint8Array(await subtle().sign("HMAC", k, enc.encode(message))));
}

/** Admission credential (in the link, sent as X-Yo-Admit): HMAC(registerKey, "yo-phone/v1/admit\n" + box). */
export function admitFor(registerKey, box) {
  return hmacB64url(registerKey, `yo-phone/v1/admit\n${box}`);
}

/** Core-only credential (never in the link, sent as X-Yo-Core): HMAC(registerKey, "yo-phone/v1/core\n" + box). */
export function coreCredFor(registerKey, box) {
  return hmacB64url(registerKey, `yo-phone/v1/core\n${box}`);
}

/**
 * The bug mailbox (POST /api/relay/bugs) isn't a phone mailbox: its core routes take X-Yo-Core = coreCredFor(
 * registerKey, BUGS_BOX). Real box ids are 64 hex characters, so this can never collide with one, and only a core
 * holding the register key (the owner's) can compute it.
 */
export const BUGS_BOX = "bugs";

/** The bytes the core signs for each out item. */
export function outSigMessage(envelope) {
  return enc.encode(`yo-phone/v1/out\n${envelope}`);
}

const pubKeys = new Map();
async function importSignPub(signPubB64) {
  let key = pubKeys.get(signPubB64);
  if (!key) {
    const raw = fromB64url(signPubB64);
    if (raw.length !== 32) throw new Error("signPub must be 32 bytes");
    key = await subtle().importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    if (pubKeys.size > 8) pubKeys.clear();
    pubKeys.set(signPubB64, key);
  }
  return key;
}

/** True if this browser can verify Ed25519 signatures (Safari 17+, Chrome 137+, Node 22). */
export async function canVerifyEd25519(signPubB64) {
  try {
    await importSignPub(signPubB64);
    return true;
  } catch {
    return false;
  }
}

/**
 * Checks the core's Ed25519 signature over an out envelope. Never throws: anything malformed is just "false".
 * @param {string} signPubB64 raw 32-byte public key, base64url
 * @param {string} envelope
 * @param {string} sig base64url, 64 bytes
 */
export async function verifyOut(signPubB64, envelope, sig) {
  try {
    if (typeof envelope !== "string" || typeof sig !== "string") return false;
    const sigBytes = fromB64url(sig);
    if (sigBytes.length !== 64) return false;
    return await subtle().verify(
      "Ed25519",
      await importSignPub(signPubB64),
      sigBytes,
      outSigMessage(envelope),
    );
  } catch {
    return false;
  }
}

function aad(dir) {
  if (dir !== "in" && dir !== "out") throw new Error(`Unknown direction: ${dir}`);
  return enc.encode(`yo-phone/v1/${dir}`);
}

/**
 * Encrypt a JSON-able object into an envelope.
 * @param {CryptoKey} encKey
 * @param {unknown} obj
 * @param {"in"|"out"} dir
 * @param {Uint8Array} [iv] fixed iv, for tests only
 */
export async function seal(encKey, obj, dir, iv) {
  const nonce = iv ?? globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  if (nonce.length !== IV_BYTES) throw new Error("iv must be 12 bytes");
  const ct = new Uint8Array(
    await subtle().encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad(dir) },
      encKey,
      enc.encode(JSON.stringify(obj)),
    ),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, IV_BYTES);
  return toB64url(out);
}

/**
 * Decrypt an envelope. Throws if it was tampered with, sealed for the other direction, or isn't JSON.
 * @param {CryptoKey} encKey
 * @param {string} envelope
 * @param {"in"|"out"} dir
 */
export async function open(encKey, envelope, dir) {
  const bytes = fromB64url(envelope);
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("Envelope too short");
  const pt = await subtle().decrypt(
    { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: aad(dir) },
    encKey,
    bytes.subarray(IV_BYTES),
  );
  return JSON.parse(dec.decode(pt));
}

// v2.1: pictures. A picture travels as a blob beside the mailbox (relay routes blob/out and blob/in):
// base64url(iv || AES-GCM(encKey, iv, bytes, aad)) with aad `yo-phone/v1/blob-<dir>\n<id>`. The signed message that
// points at it carries `hash` = base64url(sha256(bytes)), checked after decrypting.

function blobAad(dir, id) {
  if (dir !== "in" && dir !== "out") throw new Error(`Unknown direction: ${dir}`);
  return enc.encode(`yo-phone/v1/blob-${dir}\n${id}`);
}

export const BLOB_ID_RE = /^[A-Za-z0-9_-]{22}$/;

/** A blob id: 16 random bytes, base64url (22 characters). */
export function randomBlobId() {
  return toB64url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
}

/** @param {Uint8Array} bytes @returns {Promise<string>} base64url(sha256(bytes)) */
export async function hashOf(bytes) {
  return toB64url(new Uint8Array(await subtle().digest("SHA-256", bytes)));
}

/** @param {CryptoKey} encKey @param {Uint8Array} bytes @param {"in"|"out"} dir @param {string} id */
export async function sealBlob(encKey, bytes, dir, id) {
  const nonce = globalThis.crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await subtle().encrypt({ name: "AES-GCM", iv: nonce, additionalData: blobAad(dir, id) }, encKey, bytes),
  );
  const out = new Uint8Array(IV_BYTES + ct.length);
  out.set(nonce, 0);
  out.set(ct, IV_BYTES);
  return toB64url(out);
}

/** Throws if the blob was tampered with, or belongs to another id or direction. */
export async function openBlob(encKey, envelope, dir, id) {
  const bytes = fromB64url(envelope);
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error("Blob too short");
  return new Uint8Array(
    await subtle().decrypt(
      { name: "AES-GCM", iv: bytes.subarray(0, IV_BYTES), additionalData: blobAad(dir, id) },
      encKey,
      bytes.subarray(IV_BYTES),
    ),
  );
}
