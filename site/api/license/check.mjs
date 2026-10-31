// POST /api/license/check  {"key": "yo_..."}
// Yo asks this when it's activated and then once a day. Answers:
//   200 {"active": true,  "token": "...", "status": "active", "renewsAt": 1760000000}
//   200 {"active": false, "status": "canceled" | "none", "reason": "..."}
//   400 / 403 for a key this server never made.

import {
  ACTIVE_STATUSES,
  customerFromKey,
  json,
  keyId,
  periodEnd,
  readJson,
  signToken,
  subscriptionFor,
  TOKEN_DAYS,
} from "../_lib/license.mjs";

/** The endpoint, with its environment and fetch passed in (tests use fakes). */
export async function checkLicense(request, env, fetchImpl = fetch) {
  const body = await readJson(request, 4_000);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key) return json(400, { active: false, reason: "Paste the license key from your receipt page." });

  const customer = customerFromKey(key, env.YO_LICENSE_HMAC_SECRET);
  if (!customer) return json(403, { active: false, reason: "That isn't a Yo license key. Check for typos." });

  let sub;
  try {
    sub = await subscriptionFor(customer, env.STRIPE_SECRET_KEY, fetchImpl);
  } catch (err) {
    // Unknown customer (deleted in Stripe) reads as "no subscription"; anything else is our problem.
    if (err.status === 404) sub = null;
    else
      return json(502, {
        active: false,
        reason: "Couldn't reach the payment system. Yo will try again soon.",
      });
  }

  if (!sub || !ACTIVE_STATUSES.has(sub.status)) {
    return json(200, {
      active: false,
      status: sub?.status ?? "none",
      reason: "This key has no active subscription. Subscribe again at theyoapp.com to keep using Yo.",
    });
  }

  const now = Math.floor(Date.now() / 1000);
  const token = signToken(
    { v: 1, kid: keyId(key), status: sub.status, iat: now, exp: now + TOKEN_DAYS * 86_400 },
    env.YO_LICENSE_SIGNING_KEY,
  );
  return json(200, {
    active: true,
    token,
    status: sub.status,
    renewsAt: sub.cancel_at_period_end ? null : periodEnd(sub),
    endsAt: sub.cancel_at_period_end ? periodEnd(sub) : null,
  });
}

/**
 * GET: not a check, but says whether this server can answer checks (all its settings are there). The release
 * script refuses to tag a release while it says false: a public build that can't
 * check its key would lock everyone out.
 */
export function licenseServerStatus(env) {
  const ready = Boolean(env.STRIPE_SECRET_KEY && env.YO_LICENSE_HMAC_SECRET && env.YO_LICENSE_SIGNING_KEY);
  return json(405, { error: "POST a JSON body with your key.", ready }, { Allow: "POST" });
}

// Vercel calls this with the request (and maybe more); only the request is used.
export const POST = (request) => checkLicense(request, process.env, fetch);
export const GET = () => licenseServerStatus(process.env);
