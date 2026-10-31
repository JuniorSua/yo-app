/**
 * Who may drive Yo: "controllers" (the desktop app on the user's Mac, or a browser in the PC edition). Origin checks alone don't
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
 *
 * Browsers (docs/web-app/README.md) hold their key in WebCrypto and enroll with the same file token (written by
 * `yo-app signin`) or with a one-time sign-in link a signed-in client made (kept in memory only, same rules).
 * Core sets their session cookie itself (server.ts), so page script never sees a session token.
 */
import fs from "node:fs";
import path from "node:path";
import { SIGN_IN_TOKEN_TTL_MS, type SignedInClient, type SignInLink, signedText } from "@yo/contracts";
import type { Db } from "../db/db";
import { isEd25519PublicKey, randomHex, safeEqual, sha256Hex, verifySignature } from "./identity";

export const SESSION_COOKIE = "yo_session";
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const NONCE_TTL_MS = 60 * 1000;
const ENROLL_TOKEN_TTL_MS = SIGN_IN_TOKEN_TTL_MS;
/** Pending challenges kept; past this the oldest is dropped (refusing instead would let a flood lock out sign-ins). */
const MAX_NONCES = 1024;
/**
 * Failed attempts allowed per minute, per kind and across all callers. Guessing a 256-bit token or forging an Ed25519
 * signature isn't possible anyway; this only keeps a buggy or hostile local client from burning CPU. Separate kinds,
 * so a flood of bad enrollments never stops signed-in browsers from renewing their sessions.
 */
const FAILURE_LIMIT = { enroll: 20, session: 300 } as const;
type FailureKind = keyof typeof FAILURE_LIMIT;
/** Sign-in links waiting to be used. Enough for a household; a runaway client can't fill memory. */
const MAX_SIGN_IN_LINKS = 20;
const MAX_LABEL = 80;

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
  private failures: Record<FailureKind, number[]> = { enroll: [], session: [] };
  /** sha256(link token) -> expiresAt. Only the hash is kept, like sessions. */
  private links = new Map<string, number>();
  private revokeListeners = new Set<(controllerId: string) => void>();

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
    this.throttle("enroll");
    const token = typeof input.token === "string" ? input.token : "";
    const publicKey = typeof input.publicKey === "string" ? input.publicKey : "";
    const label = typeof input.label === "string" ? input.label.slice(0, 80) : "Yo app";
    if (!token || !isEd25519PublicKey(publicKey)) throw this.fail("enroll", "invalid enrollment");
    if (!this.useLink(token)) this.useFileToken(token);
    const controllerId = `ctl_${randomHex(12)}`;
    this.db
      .prepare(
        "INSERT INTO controllers (id, public_key, label, created_at, last_used_at, revoked_at) VALUES (?, ?, ?, ?, NULL, NULL)",
      )
      .run(controllerId, publicKey, label, this.now());
    return { controllerId };
  }

  /** A sign-in link's token: true when it was one (now used up), throws when it was one but expired. */
  private useLink(token: string): boolean {
    const key = sha256Hex(token);
    const exp = this.links.get(key);
    if (exp === undefined) return false;
    this.links.delete(key);
    if (exp < this.now()) throw this.fail("enroll", "sign-in link expired");
    return true;
  }

  /** The owner's token in <dataDir>/enroll-token (the Mac app, the home server's setup, `yo-app signin`). */
  private useFileToken(token: string) {
    let expected = "";
    let mtime = 0;
    try {
      expected = fs.readFileSync(this.enrollTokenPath, "utf8").trim();
      mtime = fs.statSync(this.enrollTokenPath).mtimeMs;
    } catch {
      throw this.fail("enroll", "no enrollment is open");
    }
    if (this.now() - mtime > ENROLL_TOKEN_TTL_MS) {
      fs.rmSync(this.enrollTokenPath, { force: true });
      throw this.fail("enroll", "enrollment token expired");
    }
    if (expected.length < 32 || !safeEqual(expected, token)) throw this.fail("enroll", "invalid enrollment");
    fs.rmSync(this.enrollTokenPath, { force: true });
  }

  /** A one-time link for signing in another browser, made by a signed-in client (`auth.signInLink.create`). */
  createSignInLink(): SignInLink {
    const t = this.now();
    for (const [k, exp] of this.links) if (exp < t) this.links.delete(k);
    if (this.links.size >= MAX_SIGN_IN_LINKS)
      throw new AuthError("Too many sign-in links are waiting. Use one, or try again in a few minutes.", 429);
    const token = randomHex(32);
    const expiresAt = t + SIGN_IN_TOKEN_TTL_MS;
    this.links.set(sha256Hex(token), expiresAt);
    return { token, expiresAt };
  }

  challenge(): { nonce: string; expiresAt: number } {
    this.sweep();
    while (this.nonces.size >= MAX_NONCES) {
      const oldest = this.nonces.keys().next().value;
      if (oldest === undefined) break;
      this.nonces.delete(oldest);
    }
    const nonce = randomHex(32);
    const expiresAt = this.now() + NONCE_TTL_MS;
    this.nonces.set(nonce, expiresAt);
    return { nonce, expiresAt };
  }

  createSession(input: { controllerId: unknown; nonce: unknown; signature: unknown }): {
    token: string;
    expiresAt: number;
  } {
    this.throttle("session");
    const controllerId = typeof input.controllerId === "string" ? input.controllerId : "";
    const nonce = typeof input.nonce === "string" ? input.nonce : "";
    const signature = typeof input.signature === "string" ? input.signature : "";
    const exp = this.nonces.get(nonce);
    // One use, whatever happens next.
    this.nonces.delete(nonce);
    if (!exp || exp < this.now()) throw this.fail("session", "sign-in expired");
    const row = this.db
      .prepare("SELECT public_key FROM controllers WHERE id = ? AND revoked_at IS NULL")
      .get(controllerId) as { public_key: string } | undefined;
    if (
      !row ||
      !verifySignature(row.public_key, signedText.controllerSession(nonce, controllerId), signature)
    )
      throw this.fail("session", "sign-in rejected");
    const token = randomHex(32);
    const expiresAt = this.now() + SESSION_TTL_MS;
    this.sessions.set(sha256Hex(token), { controllerId, expiresAt });
    this.db.prepare("UPDATE controllers SET last_used_at = ? WHERE id = ?").run(this.now(), controllerId);
    return { token, expiresAt };
  }

  /** Resolve the caller from a session token (cookie or bearer). */
  principal(token: string | null, opts: { loopback: boolean }): Principal | null {
    const s = this.sessionInfo(token);
    if (s) return { kind: "controller", controllerId: s.controllerId };
    if (this.devBypass && opts.loopback) return { kind: "dev" };
    return null;
  }

  /** The live session behind a token (for /auth/me), or null when it ended, expired or was revoked. */
  sessionInfo(token: string | null): { controllerId: string; expiresAt: number } | null {
    if (!token) return null;
    const key = sha256Hex(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (s.expiresAt > this.now() && this.isLive(s.controllerId)) return { ...s };
    this.sessions.delete(key);
    return null;
  }

  /** Sign out one session (POST /auth/signout). The controller stays enrolled. */
  endSession(token: string | null): { controllerId: string } | null {
    if (!token) return null;
    const key = sha256Hex(token);
    const s = this.sessions.get(key);
    this.sessions.delete(key);
    return s ? { controllerId: s.controllerId } : null;
  }

  /** Apps and browsers that can still sign in, newest first. */
  listClients(): SignedInClient[] {
    const rows = this.db
      .prepare(
        "SELECT id, label, created_at, last_used_at FROM controllers WHERE revoked_at IS NULL ORDER BY created_at DESC, rowid DESC",
      )
      .all() as { id: string; label: string; created_at: number; last_used_at: number | null }[];
    return rows.map((r) => ({
      id: r.id,
      label: r.label,
      createdAt: r.created_at,
      lastUsedAt: r.last_used_at,
    }));
  }

  renameClient(controllerId: string, label: string): SignedInClient {
    const clean = String(label ?? "").trim();
    if (!clean) throw new Error("The name can't be empty.");
    if (clean.length > MAX_LABEL) throw new Error(`Keep the name under ${MAX_LABEL} characters.`);
    const res = this.db
      .prepare("UPDATE controllers SET label = ? WHERE id = ? AND revoked_at IS NULL")
      .run(clean, controllerId);
    const client = this.listClients().find((c) => c.id === controllerId);
    if (!res.changes || !client) throw new Error("That app or browser isn't signed in to Yo.");
    return client;
  }

  /**
   * Sign a controller out for good: its sessions end at once and listeners (the server) close its open sockets.
   * False when there was no such signed-in controller.
   */
  revokeController(controllerId: string): boolean {
    const res = this.db
      .prepare("UPDATE controllers SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.now(), controllerId);
    for (const [k, s] of this.sessions) if (s.controllerId === controllerId) this.sessions.delete(k);
    if (!res.changes) return false;
    for (const fn of this.revokeListeners) fn(controllerId);
    return true;
  }

  /** Called with a controller's id when it's revoked. Returns an unsubscribe function. */
  onRevoke(fn: (controllerId: string) => void): () => void {
    this.revokeListeners.add(fn);
    return () => this.revokeListeners.delete(fn);
  }

  private isLive(controllerId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM controllers WHERE id = ? AND revoked_at IS NULL")
      .get(controllerId);
  }

  private sweep() {
    const t = this.now();
    for (const [n, exp] of this.nonces) if (exp < t) this.nonces.delete(n);
    for (const [k, s] of this.sessions) if (s.expiresAt < t) this.sessions.delete(k);
  }

  /** Brake on repeated failures (FAILURE_LIMIT a minute per kind, across all callers). */
  private throttle(kind: FailureKind) {
    const t = this.now();
    this.failures[kind] = this.failures[kind].filter((f) => t - f < 60_000);
    if (this.failures[kind].length >= FAILURE_LIMIT[kind])
      throw new AuthError("too many attempts; try again in a minute", 429);
  }

  private fail(kind: FailureKind, message: string) {
    this.failures[kind].push(this.now());
    return new AuthError(message);
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    if (part.slice(0, i).trim() !== name) continue;
    // Anyone can send a malformed value (`%`): that's no session, never an exception.
    try {
      return decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}
