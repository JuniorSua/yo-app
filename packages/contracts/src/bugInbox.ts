/**
 * Yo's bug mailbox (docs/phone/PROTOCOL.md, "Bug mailbox"). Every Yo encrypts a bug report to this public key
 * and drops it in the Yo Phone relay's bug mailbox; only the owner's core, which holds the private key, can open
 * it and file it on GitHub.
 *
 * X25519 public key, raw 32 bytes, base64url. Made by scripts/bug-inbox-keygen.mjs (fingerprint 88448bef8c6a1400:
 * the first 16 hex characters of sha256 of the raw key). Changing it means the owner's core needs the new private
 * key (`yo-ops.mjs bugs key`) and reports sent to the old one can no longer be opened.
 */
export const BUG_INBOX_PUBLIC_KEY = "1obD-bxZGggtwvr_TOSoeWHi5CnH3LY1mfU6nvvT6gA";

/** What travels: the relay checks this exact shape and stores it as is. */
export interface BugEnvelope {
  v: 1;
  /** A hash of the sender's install id (32 hex): per-install caps and "the same report again". */
  install: string;
  /** The sender's one-time X25519 public key (base64url). */
  epk: string;
  /** AES-256-GCM iv (12 bytes, base64url). */
  iv: string;
  /** Ciphertext + 16-byte tag (base64url). */
  ct: string;
}

/** `bugInbox.status`: the owner's receiving side (only the owner's core has the keys to turn it on). */
export interface BugInboxStatus {
  /** Both keys are there (the bug inbox private key and Yo Phone's register key), so core polls the mailbox. */
  enabled: boolean;
  keySet: boolean;
  registerKeySet: boolean;
  /** The core's GitHub token for filing issues is set (without it, reports wait in the mailbox). */
  githubTokenSet: boolean;
  relayUrl: string;
  repo: string;
  lastPollAt: number | null;
  /** Reports seen in the mailbox on the last poll that aren't filed yet. */
  pending: number;
  /** Filed since this core started. */
  filed: number;
  lastError: string | null;
  /** The next poll (later than usual after a failure). */
  nextPollAt: number | null;
}

/**
 * Owner-only methods (yo-ops.mjs `bugs key` / `bugs status`), kept out of ApiMethods like the Telegram ones: no UI
 * calls them and the web mock doesn't answer them.
 */
export interface BugInboxApiMethods {
  "bugInbox.status": { params: Record<string, never>; result: BugInboxStatus };
  /** Save the bug inbox private key (base64url, from scripts/bug-inbox-keygen.mjs) or forget it (null). */
  "bugInbox.configure": { params: { privateKey: string | null }; result: BugInboxStatus };
}
