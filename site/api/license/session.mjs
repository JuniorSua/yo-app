// GET /api/license/session?id=cs_...
// The thanks page calls this right after Stripe Checkout (the payment link sends people to
// /thanks?session_id={CHECKOUT_SESSION_ID}). It turns the finished checkout into the buyer's license key.
// The session id is long and random and only the buyer's browser gets it, so it works as a one-time proof.
// This is also where the key is emailed (licenseMail.mjs): same response either way.

import { json, makeKey, stripe } from "../_lib/license.mjs";
import { maybeEmailLicenseKey } from "../_lib/licenseMail.mjs";

const SESSION_RE = /^cs_(test|live)_[A-Za-z0-9]{10,200}$/;

/** The endpoint, with its environment and fetch passed in (tests use fakes). `context` is Vercel's. */
export async function licenseFromSession(request, env, fetchImpl = fetch, context) {
  const id = new URL(request.url).searchParams.get("id") ?? "";
  if (!SESSION_RE.test(id)) return json(400, { error: "Missing or malformed checkout session." });

  let session;
  try {
    session = await stripe(`checkout/sessions/${encodeURIComponent(id)}`, env.STRIPE_SECRET_KEY, fetchImpl);
  } catch (err) {
    if (err.status === 404) return json(404, { error: "We couldn't find that checkout." });
    return json(502, { error: "Couldn't reach the payment system. Refresh this page in a minute." });
  }

  const customer = typeof session.customer === "string" ? session.customer : session.customer?.id;
  if (session.status !== "complete" || session.mode !== "subscription" || !customer) {
    return json(409, { error: "This checkout isn't finished yet. Refresh this page in a minute." });
  }

  const key = makeKey(customer, env.YO_LICENSE_HMAC_SECRET);
  const email = session.customer_details?.email ?? null;
  // Same moment the key is issued. Null, and no other work, unless both mail env vars are set. The promise
  // is only returned when the send has to be waited on, and it gives up after a short cap (licenseMail.mjs).
  const pending = maybeEmailLicenseKey({
    sessionId: id,
    key,
    email,
    metadata: session.metadata,
    env,
    fetchImpl,
    context,
  });
  if (pending) await pending;
  return json(200, { key, email });
}

// Vercel calls this with the request and a context (context.waitUntil finishes the license email).
export const GET = (request, context) => licenseFromSession(request, process.env, fetch, context);
