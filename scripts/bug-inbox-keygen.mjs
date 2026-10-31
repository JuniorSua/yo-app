#!/usr/bin/env node
// Makes the bug inbox's key pair (X25519). Every Yo encrypts bug reports to the public key
// (BUG_INBOX_PUBLIC_KEY in packages/contracts/src/bugInbox.ts), and only the owner's core, holding the private
// key, can open them (docs/phone/PROTOCOL.md, "Bug mailbox").
//
//   node scripts/bug-inbox-keygen.mjs            # writes ~/.config/yo/bug-inbox-key (600), prints the public key
//   node scripts/bug-inbox-keygen.mjs --public   # prints the public key of the existing file
//
// It never prints the private key, and refuses to overwrite an existing one (reports already sent to the old
// public key could no longer be opened). Load it into the owner's core with
//   yo-ops.mjs bugs key < ~/.config/yo/bug-inbox-key   (the owner's ops script)
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FILE = process.env.YO_BUG_INBOX_KEY_FILE || path.join(os.homedir(), ".config", "yo", "bug-inbox-key");
const B64URL_32 = /^[A-Za-z0-9_-]{43}$/;

/** The public key (raw 32 bytes, base64url) for a raw private key (base64url). */
export function publicKeyOf(privateKey) {
  if (!B64URL_32.test(privateKey)) throw new Error("not a bug inbox key");
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b656e04220420", "hex"),
    Buffer.from(privateKey, "base64url"),
  ]);
  const priv = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return crypto.createPublicKey(priv).export({ format: "jwk" }).x;
}

/** A short fingerprint to compare keys by eye: first 16 hex of sha256(raw public key). */
export function fingerprintOf(publicKey) {
  return crypto.createHash("sha256").update(Buffer.from(publicKey, "base64url")).digest("hex").slice(0, 16);
}

function main(argv) {
  if (argv.includes("--public")) {
    const priv = fs.readFileSync(FILE, "utf8").trim();
    const pub = publicKeyOf(priv);
    console.log(`BUG_INBOX_PUBLIC_KEY = "${pub}"   (fingerprint ${fingerprintOf(pub)})`);
    return;
  }
  if (fs.existsSync(FILE)) {
    console.error(
      `${FILE} already exists. Not replacing it: reports encrypted to its public key would become unreadable.\n` +
        "Print its public key with --public.",
    );
    process.exit(1);
  }
  const { privateKey } = crypto.generateKeyPairSync("x25519");
  const jwk = privateKey.export({ format: "jwk" });
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, `${jwk.d}\n`, { mode: 0o600, flag: "wx" });
  fs.chmodSync(FILE, 0o600);
  console.log(`Private key written to ${FILE} (mode 600). It is never printed: keep it there.`);
  console.log(`BUG_INBOX_PUBLIC_KEY = "${jwk.x}"   (fingerprint ${fingerprintOf(jwk.x)})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]))
  main(process.argv.slice(2));
