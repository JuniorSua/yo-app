import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { generateSignKey, signOut, signPubFor } from "../core/sign.mjs";
import {
  admitFor,
  boxFor,
  canVerifyEd25519,
  coreCredFor,
  deriveKeys,
  fromB64url,
  isB64url,
  MIN_ENVELOPE_CHARS,
  open,
  randomId,
  randomSecret,
  seal,
  toB64url,
  verifyOut,
} from "../lib/crypto.js";

const vector = JSON.parse(readFileSync(new URL("./vector.json", import.meta.url), "utf8"));

describe("base64url", () => {
  it("round-trips every length without padding", () => {
    for (let n = 0; n < 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const s = toB64url(bytes);
      expect(s).not.toMatch(/[+/=]/);
      expect(Array.from(fromB64url(s))).toEqual(Array.from(bytes));
    }
  });
  it("rejects non-base64url input", () => {
    expect(() => fromB64url("abc+")).toThrow();
    expect(() => fromB64url("a")).toThrow();
    expect(isB64url("ab_-")).toBe(true);
    expect(isB64url("ab/=")).toBe(false);
  });
  it("makes 43-character secrets and distinct ids", () => {
    const a = randomSecret();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromB64url(a)).toHaveLength(32);
    expect(randomSecret()).not.toBe(a);
    expect(randomId()).not.toBe(randomId());
  });
  it("knows the shortest envelope", () => {
    expect(MIN_ENVELOPE_CHARS).toBe(toB64url(new Uint8Array(28)).length);
  });
});

describe("test vector (shared with apps/core phoneCrypto.ts)", () => {
  it("uses bytes 0x00..0x1f as the secret", () => {
    expect(Array.from(fromB64url(vector.secret))).toEqual(Array.from({ length: 32 }, (_, i) => i));
    expect(vector.secret).toBe("AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8");
  });
  it("derives the expected auth token and box", async () => {
    const { authToken } = await deriveKeys(vector.secret);
    expect(authToken).toBe(vector.authToken);
    expect(await boxFor(authToken)).toBe(vector.box);
  });
  it("seals the fixed envelope byte for byte with the fixed iv", async () => {
    const { encKey } = await deriveKeys(vector.secret);
    expect(await seal(encKey, vector.plaintext, vector.dir, fromB64url(vector.iv))).toBe(vector.envelope);
    expect(JSON.stringify(vector.plaintext)).toBe(vector.plaintextJson);
  });
  it("opens the fixed envelope", async () => {
    const { encKey } = await deriveKeys(vector.secret);
    expect(await open(encKey, vector.envelope, vector.dir)).toEqual(vector.plaintext);
  });
});

describe("seal/open", () => {
  it("round-trips both directions with random ivs", async () => {
    const { encKey } = await deriveKeys(randomSecret());
    const msg = { v: 1, t: "reply", text: "héllo 👋 ".repeat(50) };
    for (const dir of ["in", "out"]) {
      const a = await seal(encKey, msg, dir);
      const b = await seal(encKey, msg, dir);
      expect(a).not.toBe(b);
      expect(await open(encKey, a, dir)).toEqual(msg);
    }
  });
  it("fails when the direction (AAD) doesn't match", async () => {
    const { encKey } = await deriveKeys(vector.secret);
    await expect(open(encKey, vector.envelope, "out")).rejects.toThrow();
    const out = await seal(encKey, { v: 1, t: "hello" }, "out");
    await expect(open(encKey, out, "in")).rejects.toThrow();
  });
  it("fails with another key or a tampered envelope", async () => {
    const other = await deriveKeys(randomSecret());
    await expect(open(other.encKey, vector.envelope, "in")).rejects.toThrow();
    const { encKey } = await deriveKeys(vector.secret);
    const bytes = fromB64url(vector.envelope);
    bytes[bytes.length - 1] ^= 1;
    await expect(open(encKey, toB64url(bytes), "in")).rejects.toThrow();
    await expect(open(encKey, "AAAA", "in")).rejects.toThrow();
  });
  it("rejects bad secrets and directions", async () => {
    await expect(deriveKeys(toB64url(new Uint8Array(16)))).rejects.toThrow();
    const { encKey } = await deriveKeys(vector.secret);
    await expect(seal(encKey, {}, "sideways")).rejects.toThrow();
  });
});

describe("v2 vector: admission and signatures", () => {
  it("derives the expected admit and coreCred for the vector box", async () => {
    expect(await admitFor(vector.registerKey, vector.box)).toBe(vector.admit);
    expect(await coreCredFor(vector.registerKey, vector.box)).toBe(vector.coreCred);
    expect(vector.admit).not.toBe(vector.coreCred);
    expect(await admitFor(`${vector.registerKey}x`, vector.box)).not.toBe(vector.admit);
  });

  it("has a fixed Ed25519 key whose public half is signPub", async () => {
    expect(await signPubFor(vector.signPkcs8)).toBe(vector.signPub);
    expect(fromB64url(vector.signPub)).toHaveLength(32);
  });

  it("signs the vector envelope deterministically and verifies it", async () => {
    expect(vector.sigMessage).toBe(`yo-phone/v1/out\n${vector.envelope}`);
    expect(await signOut(vector.signPkcs8, vector.envelope)).toBe(vector.sig);
    expect(await verifyOut(vector.signPub, vector.envelope, vector.sig)).toBe(true);
    expect(await canVerifyEd25519(vector.signPub)).toBe(true);
  });

  it("the link carries k, a and p", () => {
    const hash = new URL(vector.link).hash.slice(1);
    const params = new URLSearchParams(hash);
    expect(params.get("k")).toBe(vector.secret);
    expect(params.get("a")).toBe(vector.admit);
    expect(params.get("p")).toBe(vector.signPub);
  });
});

describe("verifyOut", () => {
  it("rejects a tampered envelope, a tampered or missing sig, and another key", async () => {
    const env = vector.envelope;
    const flipped = env.slice(0, 20) + (env[20] === "A" ? "B" : "A") + env.slice(21);
    expect(await verifyOut(vector.signPub, flipped, vector.sig)).toBe(false);
    const sigBytes = fromB64url(vector.sig);
    sigBytes[10] ^= 1;
    expect(await verifyOut(vector.signPub, env, toB64url(sigBytes))).toBe(false);
    for (const bad of [undefined, null, "", "abc", vector.sig.slice(0, -2), `${vector.sig}AA`]) {
      expect(await verifyOut(vector.signPub, env, bad), String(bad)).toBe(false);
    }
    const other = await generateSignKey();
    expect(await verifyOut(other.signPub, env, vector.sig)).toBe(false);
    expect(await verifyOut(vector.signPub, env, await signOut(other.pkcs8, env))).toBe(false);
  });

  it("never throws on a malformed public key", async () => {
    expect(await verifyOut("not-a-key", vector.envelope, vector.sig)).toBe(false);
    expect(await verifyOut(toB64url(new Uint8Array(31)), vector.envelope, vector.sig)).toBe(false);
    expect(await canVerifyEd25519("nope")).toBe(false);
  });
});
