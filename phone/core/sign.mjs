// Ed25519 signing for out items, for Node-side cores (like dev/fake-core.mjs). The real core signs in
// apps/core/src/channels/phoneCrypto.ts; the phone app only ever verifies (lib/crypto.js verifyOut).
import { fromB64url, outSigMessage, toB64url } from "../lib/crypto.js";

const { subtle } = globalThis.crypto;

/** A fresh key pair: PKCS8 private key and raw public key, both base64url. */
export async function generateSignKey() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const pub = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { pkcs8: toB64url(pkcs8), signPub: toB64url(pub) };
}

/** The raw public key for a PKCS8 private key (the JWK form carries it as `x`). */
export async function signPubFor(pkcs8B64) {
  const key = await subtle.importKey("pkcs8", fromB64url(pkcs8B64), { name: "Ed25519" }, true, ["sign"]);
  return (await subtle.exportKey("jwk", key)).x;
}

/** sig = base64url(Ed25519-sign(key, "yo-phone/v1/out\n" + envelope)) */
export async function signOut(pkcs8B64, envelope) {
  const key = await subtle.importKey("pkcs8", fromB64url(pkcs8B64), { name: "Ed25519" }, false, ["sign"]);
  return toB64url(new Uint8Array(await subtle.sign("Ed25519", key, outSigMessage(envelope))));
}
