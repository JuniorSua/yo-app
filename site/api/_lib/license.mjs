// Yo's license: a key per Stripe customer, and short-lived signed tokens that say "this key has an active
// subscription until <exp>". Stateless on purpose (no database): the key carries the customer id and an HMAC
// over it, so only this server can make one, and Stripe stays the only record of who has paid.
//
//   key    yo_<customer id without "cus_">_<22 chars of HMAC-SHA256(YO_LICENSE_HMAC_SECRET, customer id)>
//   token  <base64url JSON payload>.<base64url Ed25519 signature>, signed with YO_LICENSE_SIGNING_KEY. The app
//          checks it offline with the public key it ships with (apps/core/src/license/), so a Yo that's
//          offline keeps working until the token expires.
//
// Files under api/_lib are helpers, not endpoints (Vercel skips names that start with "_").

import { createHash, createHmac, createPrivateKey, sign, timingSafeEqual } from "node:crypto";

/** A subscription in one of these states unlocks Yo. past_due: Stripe is still retrying the card. */
export const ACTIVE_STATUSES = new Set(["active", "trialing", "past_due"]);
/** How long a Yo that can't reach this server keeps working. The app asks again every day. */
export const TOKEN_DAYS = 7;

const KEY_RE = /^yo_([A-Za-z0-9]{6,40})_([A-Za-z0-9_-]{22})$/;
const CUSTOMER_RE = /^cus_[A-Za-z0-9]{6,40}$/;

const b64url = (buf) => Buffer.from(buf).toString("base64url");

function hmac(secret, customer) {
  return b64url(createHmac("sha256", secret).update(`yo-license-v1:${customer}`).digest()).slice(0, 22);
}

/** The license key for a Stripe customer id (cus_...). */
export function makeKey(customer, secret) {
  if (!CUSTOMER_RE.test(customer)) throw new Error("not a Stripe customer id");
  if (!secret) throw new Error("YO_LICENSE_HMAC_SECRET is not set");
  return `yo_${customer.slice(4)}_${hmac(secret, customer)}`;
}

/** The customer id inside a genuine key, or null for anything this server didn't make. */
export function customerFromKey(key, secret) {
  if (!secret || typeof key !== "string") return null;
  const m = KEY_RE.exec(key.trim());
  if (!m) return null;
  const customer = `cus_${m[1]}`;
  const want = Buffer.from(hmac(secret, customer));
  const got = Buffer.from(m[2]);
  return want.length === got.length && timingSafeEqual(want, got) ? customer : null;
}

/** Short, non-reversible id of a key, so a token only works with the key it was issued for. */
export function keyId(key) {
  return createHash("sha256").update(key.trim()).digest("base64url").slice(0, 16);
}

/**
 * A signed token for the app. `signingKey` is the Ed25519 private key as PKCS#8 PEM, or that PEM's base64
 * body on one line (easier to paste into an environment variable).
 */
export function signToken(payload, signingKey) {
  if (!signingKey) throw new Error("YO_LICENSE_SIGNING_KEY is not set");
  const key = signingKey.includes("BEGIN")
    ? createPrivateKey(signingKey)
    : createPrivateKey({ key: Buffer.from(signingKey.trim(), "base64"), format: "der", type: "pkcs8" });
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(body), key);
  return `${body}.${b64url(sig)}`;
}

/** Calls the Stripe API with the secret (or restricted) key. Throws on HTTP errors. */
export async function stripe(path, secretKey, fetchImpl = fetch) {
  if (!secretKey) throw new Error("STRIPE_SECRET_KEY is not set");
  const res = await fetchImpl(`https://api.stripe.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Stripe answered ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/** The customer's best subscription: an active one if there is any, else the newest. Null when none. */
export async function subscriptionFor(customer, secretKey, fetchImpl = fetch) {
  const list = await stripe(
    `subscriptions?customer=${encodeURIComponent(customer)}&status=all&limit=20`,
    secretKey,
    fetchImpl,
  );
  const subs = Array.isArray(list?.data) ? list.data : [];
  return subs.find((s) => ACTIVE_STATUSES.has(s.status)) ?? subs[0] ?? null;
}

/** Unix seconds when the paid period ends (newer Stripe API versions keep it on the subscription item). */
export function periodEnd(sub) {
  return sub?.items?.data?.[0]?.current_period_end ?? sub?.current_period_end ?? null;
}

export function json(status, body, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extraHeaders },
  });
}

/** Reads a JSON body of at most `max` bytes; null if it's missing, too big or not JSON. */
export async function readJson(request, max = 64_000) {
  const text = await request.text().catch(() => "");
  if (!text || text.length > max) return null;
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}
