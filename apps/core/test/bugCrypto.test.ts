/** Bug report encryption: round trip, tampering, the shipped public key, and the key generator script. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BUG_INBOX_PUBLIC_KEY } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import {
  bugInboxPublicKeyOf,
  bugKeyFingerprint,
  installHashOf,
  newBugInboxKeyPair,
  openBugReport,
  packBugReport,
  sealBugReport,
  unpackBugReport,
} from "../src/tools/bugCrypto";

const KP = newBugInboxKeyPair();
const INSTALL = installHashOf("inst_0123456789abcdefghij");
const flip = (b64: string, at = 0) => {
  const b = Buffer.from(b64, "base64url");
  b[at]! ^= 1;
  return b.toString("base64url");
};

describe("bug report encryption", () => {
  it("round-trips the text fields and the zip", () => {
    const zip = Buffer.from([0x50, 0x4b, 1, 2, 3, 0x0a, 0, 255]);
    const env = sealBugReport(packBugReport({ title: "Hi\nthere", n: 1 }, zip), KP.publicKey, INSTALL);
    expect(Object.keys(env).sort()).toEqual(["ct", "epk", "install", "iv", "v"]);
    expect(env.install).toBe(INSTALL);
    expect(env.epk).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.iv).toMatch(/^[A-Za-z0-9_-]{16}$/);
    expect(Buffer.from(env.ct, "base64url").toString("latin1")).not.toContain("there");
    const out = unpackBugReport(openBugReport(env, KP.privateKey));
    expect(out.meta).toEqual({ title: "Hi\nthere", n: 1 });
    expect(out.zip).toEqual(zip);
    expect(
      unpackBugReport(
        openBugReport(sealBugReport(packBugReport({}, null), KP.publicKey, INSTALL), KP.privateKey),
      ).zip,
    ).toBeNull();
  });

  it("uses a new one-time key and iv every time", () => {
    const a = sealBugReport(Buffer.from("same"), KP.publicKey, INSTALL);
    const b = sealBugReport(Buffer.from("same"), KP.publicKey, INSTALL);
    expect(a.epk).not.toBe(b.epk);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("rejects a tampered envelope, a swapped header, or the wrong key", () => {
    const env = sealBugReport(Buffer.from("report"), KP.publicKey, INSTALL);
    const bad = [
      { ...env, ct: flip(env.ct) },
      { ...env, ct: flip(env.ct, Buffer.from(env.ct, "base64url").length - 1) }, // the tag
      { ...env, iv: flip(env.iv) },
      { ...env, epk: newBugInboxKeyPair().publicKey },
      { ...env, install: installHashOf("someone-else") },
    ];
    for (const e of bad) expect(() => openBugReport(e, KP.privateKey)).toThrow(/couldn't be opened/);
    expect(() => openBugReport(env, newBugInboxKeyPair().privateKey)).toThrow(/couldn't be opened/);
    expect(() => openBugReport({ ...env, ct: "AAAA" }, KP.privateKey)).toThrow();
    expect(() => openBugReport({ ...env, v: 2 as 1 }, KP.privateKey)).toThrow();
  });

  it("refuses an install that isn't a hash, and keys that aren't 32 bytes", () => {
    expect(() => sealBugReport(Buffer.from("x"), KP.publicKey, "inst_raw")).toThrow(/install/);
    expect(() => sealBugReport(Buffer.from("x"), "short", INSTALL)).toThrow(/32 bytes/);
    expect(() => bugInboxPublicKeyOf("nope")).toThrow();
  });

  it("derives the public key from the private one", () => {
    expect(bugInboxPublicKeyOf(KP.privateKey)).toBe(KP.publicKey);
    expect(installHashOf("a")).toMatch(/^[0-9a-f]{32}$/);
    expect(installHashOf("a")).not.toBe(installHashOf("b"));
  });

  it("ships a valid public key", () => {
    expect(BUG_INBOX_PUBLIC_KEY).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(() => sealBugReport(Buffer.from("x"), BUG_INBOX_PUBLIC_KEY, INSTALL)).not.toThrow();
    expect(bugKeyFingerprint(BUG_INBOX_PUBLIC_KEY)).toBe("88448bef8c6a1400");
  });
});

describe("scripts/bug-inbox-keygen.mjs", () => {
  const script = path.join(__dirname, "../../../scripts/bug-inbox-keygen.mjs");

  it("writes the private key (600) without ever printing it, and won't overwrite it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-keygen-"));
    const file = path.join(dir, "sub", "bug-inbox-key");
    const env = { ...process.env, YO_BUG_INBOX_KEY_FILE: file };
    try {
      const out = execFileSync(process.execPath, [script], { env, encoding: "utf8" });
      const priv = fs.readFileSync(file, "utf8").trim();
      expect(priv).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(out).not.toContain(priv);
      const pub = bugInboxPublicKeyOf(priv);
      expect(out).toContain(`BUG_INBOX_PUBLIC_KEY = "${pub}"`);
      expect(out).toContain(bugKeyFingerprint(pub));

      let refused = "";
      try {
        execFileSync(process.execPath, [script], { env, encoding: "utf8", stdio: "pipe" });
      } catch (err: any) {
        refused = String(err.stderr) + String(err.stdout);
      }
      expect(refused).toMatch(/already exists/);
      expect(refused).not.toContain(priv);
      expect(fs.readFileSync(file, "utf8").trim()).toBe(priv);

      const again = execFileSync(process.execPath, [script, "--public"], { env, encoding: "utf8" });
      expect(again).toContain(pub);
      expect(again).not.toContain(priv);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
