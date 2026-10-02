import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import os from "node:os";

/** Constant-time string comparison (hashes first so lengths never leak through timing). */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

export function validateToken(token: string | undefined): string {
  if (!token || token.length < 32) {
    throw new Error("YO_AGENTD_TOKEN is required and must be at least 32 characters");
  }
  return token;
}

/** Extracts the bearer token from an Authorization header, or null. */
export function bearerFrom(req: Pick<IncomingMessage, "headers">): string | null {
  const h = req.headers.authorization;
  if (typeof h !== "string") return null;
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1]!.trim() : null;
}

export function checkBearer(req: Pick<IncomingMessage, "headers">, expected: string): boolean {
  const t = bearerFrom(req);
  return t !== null && safeEqual(t, expected);
}

/** Strip IPv4-mapped IPv6 prefix and zone id. */
export function normalizeAddress(addr: string): string {
  let a = addr.trim().toLowerCase();
  const zone = a.indexOf("%");
  if (zone >= 0) a = a.slice(0, zone);
  if (a.startsWith("::ffff:") && a.includes(".")) a = a.slice(7);
  return a;
}

export function isLoopback(addr: string): boolean {
  const a = normalizeAddress(addr);
  return a === "::1" || a === "0:0:0:0:0:0:0:1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(a);
}

export function ownAddresses(): Set<string> {
  const out = new Set<string>();
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list ?? []) out.add(normalizeAddress(i.address));
  }
  return out;
}

/**
 * True when a connection originates inside the container (loopback or one of our own interface
 * addresses). Legit yo-core traffic always arrives via the Docker port-forward (bridge gateway / VM),
 * so authenticated endpoints refuse local peers: processes in the sandbox (same uid as agentd) could
 * otherwise read the token from /proc and impersonate core.
 */
export function isLocalPeer(remoteAddress: string | undefined, own: Set<string> = ownAddresses()): boolean {
  if (!remoteAddress) return true;
  const a = normalizeAddress(remoteAddress);
  return isLoopback(a) || a === "::" || a === "0.0.0.0" || own.has(a);
}

/** Copy of an env with agentd-private variables (YO_AGENTD_*) removed. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!k.startsWith("YO_AGENTD_")) out[k] = v;
  return out;
}
