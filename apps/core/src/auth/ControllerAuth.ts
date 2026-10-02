/**
 * Who may drive Yo: "controllers" (the desktop app on the user's Mac). Origin checks alone don't
 * identify anyone, and approvals/grants must never come from an anonymous localhost client or from
 * a process inside the agent's computer.
 *
 * Enrollment (once per install):
 *   1. The machine owner drops a one-time token into `<dataDir>/enroll-token` (mode 600). For a core the
 *      desktop app spawns itself, the app writes it; for the Home PC, the setup script copies the same
 *      token to the PC's data dir and to the Mac over the existing pinned-key SSH path.
 *   2. The desktop app's main process POSTs it with a fresh Ed25519 public key (private key stays in the
 *      Mac Keychain via safeStorage). Tokens expire after 10 minutes and work once.
 * Sessions: main asks for a nonce, signs it, and gets a short-lived session token, which it installs as an
 * HttpOnly cookie for the UI origin only. Sessions are kept in memory; after a core restart main signs in again.
 */
import fs from "node:fs";
import path from "node:path";
import { signedText } from "@yo/contracts";
import type { Db } from "../db/db";
import { isEd25519PublicKey, randomHex, safeEqual, sha256Hex, verifySignature } from "./identity";

export const SESSION_COOKIE = "yo_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NONCE_TTL_MS = 60 * 1000;
const ENROLL_TOKEN_TTL_MS = 10 * 60 * 1000;
const MAX_NONCES = 256;

export type Principal = { kind: "controller"; controllerId: string } | { kind: "dev" };

export class AuthError extends Error {
  constructor(
    message: string,
    readonly status = 401,
  ) {
    super(message);
  }
}

export class ControllerAuth {
  private sessions = new Map<string, { controllerId: string; expiresAt: number }>();
  private nonces = new Map<string, number>();
  private failures: number[] = [];

  constructor(
    private readonly db: Db,
    private readonly dataDir: string,
    /** YO_DEV=1: unauthenticated loopback requests act as a dev principal (never set in a deployment). */
    private readonly devBypass: boolean,
    private readonly now: () => number = Date.now,
  ) {}

  get enrollTokenPath() {
    return path.join(this.dataDir, "enroll-token");
  }

  hasControllers(): boolean {
    return !!this.db.prepare("SELECT 1 FROM controllers WHERE revoked_at IS NULL LIMIT 1").get();
  }

  enroll(input: { token: unknown; publicKey: unknown; label: unknown }): { controllerId: string } {
    this.throttle();
    const token = typeof input.token === "string" ? input.token : "";
    const publicKey = typeof input.publicKey === "string" ? input.publicKey : "";
    const label = typeof input.label === "string" ? input.label.slice(0, 80) : "Yo app";
    if (!token || !isEd25519PublicKey(publicKey)) throw this.fail("invalid enrollment");
    let expected = "";
    let mtime = 0;
    try {
      expected = fs.readFileSync(this.enrollTokenPath, "utf8").trim();
      mtime = fs.statSync(this.enrollTokenPath).mtimeMs;
    } catch {
      throw this.fail("no enrollment is open");
    }
    if (this.now() - mtime > ENROLL_TOKEN_TTL_MS) {
      fs.rmSync(this.enrollTokenPath, { force: true });
      throw this.fail("enrollment token expired");
    }
    if (expected.length < 32 || !safeEqual(expected, token)) throw this.fail("invalid enrollment");
    fs.rmSync(this.enrollTokenPath, { force: true });
    const controllerId = `ctl_${randomHex(12)}`;
    this.db
      .prepare(
        "INSERT INTO controllers (id, public_key, label, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
      )
      .run(controllerId, publicKey, label, this.now());
    return { controllerId };
  }

  challenge(): { nonce: string; expiresAt: number } {
    this.throttle();
    this.sweep();
    if (this.nonces.size >= MAX_NONCES) throw new AuthError("too many pending sign-ins", 429);
    const nonce = randomHex(32);
    const expiresAt = this.now() + NONCE_TTL_MS;
    this.nonces.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  createSession(input: { controllerId: unknown; nonce: unknown; signature: unknown }): {
    token: string;
    expiresAt: number;
  } {
    this.throttle();
    const controllerId = typeof input.controllerId === "string" ? input.controllerId : "";
    const nonce = typeof input.nonce === "string" ? input.nonce : "";
    const signature = typeof input.signature === "string" ? input.signature : "";
    const exp = this.nonces.get(nonce);
    // One use, whatever happens next.
    this.nonces.delete(nonce);
    if (!exp || exp < this.now()) throw this.fail("sign-in expired");
    const row = this.db
      .prepare("SELECT public_key FROM controllers WHERE id = ? AND revoked_at IS NULL")
      .get(controllerId) as { public_key: string } | undefined;
    if (
      !row ||
      !verifySignature(row.public_key, signedText.controllerSession(nonce, controllerId), signature)
    )
      throw this.fail("sign-in rejected");
    const token = randomHex(32);
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(sha256Hex(token), { controllerId, expiresAt });
    this.db.prepare("UPDATE controllers SET last_used_at = ? WHERE id = ?").run(this.now(), controllerId);
    return { token, expiresAt };
  }

  /** Resolve the caller from a session token (cookie or bearer). */
  principal(token: string | null, opts: { loopback: boolean }): Principal | null {
    if (token) {
      const s = this.sessions.get(sha256Hex(token));
      if (s && s.expiresAt > this.now()) {
        const live = this.db
          .prepare("SELECT 1 FROM controllers WHERE id = ? AND revoked_at IS NULL")
          .get(s.controllerId);
        if (live) return { kind: "controller", controllerId: s.controllerId };
      }
      if (s) this.sessions.delete(sha256Hex(token));
    }
    if (this.devBypass && opts.loopback) return { kind: "dev" };
    return null;
  }

  revokeController(controllerId: string) {
    this.db.prepare("UPDATE controllers SET revoked_at = ? WHERE id = ?").run(this.now(), controllerId);
    for (const [k, s] of this.sessions) if (s.controllerId === controllerId) this.sessions.delete(k);
  }

  private sweep() {
    const t = this.now();
    for (const [n, exp] of this.nonces) if (exp < t) this.nonces.delete(n);
    for (const [k, s] of this.sessions) if (s.expiresAt < t) this.sessions.delete(k);
  }

  /** Crude brute-force brake: at most 20 failures a minute across all callers. */
  private throttle() {
    const t = this.now();
    this.failures = this.failures.filter((f) => t - f < 60_000);
    if (this.failures.length >= 20) throw new AuthError("too many attempts; try again in a minute", 429);
  }

  private fail(message: string) {
    this.failures.push(this.now());
    return new AuthError(message);
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}
