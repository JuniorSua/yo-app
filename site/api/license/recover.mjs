// POST /api/license/recover  {"email": "you@example.com"}
// "I lost my key": emails the key to the address that paid, if that address has a subscription. It always
// answers the same way, so nobody can use it to find out who subscribes. Needs RESEND_API_KEY (and a sender on
// theyoapp.com verified in Resend); until then it answers 501 and the page points people to support email.

import { ACTIVE_STATUSES, json, makeKey, readJson, stripe, subscriptionFor } from "../_lib/license.mjs";

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
const SAME_ANSWER = { ok: true, message: "If that email has a Yo subscription, the key is on its way." };

/** The endpoint, with its environment and fetch passed in (tests use fakes). */
export async function recoverLicense(request, env, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) {
    return json(501, { ok: false, message: "Email us and we'll send your key." });
  }
  const body = await readJson(request, 2_000);
  const email = typeof body?.email === "string" ? body.email.trim().toLowerCase() : "";
  if (!EMAIL_RE.test(email))
    return json(400, { ok: false, message: "That doesn't look like an email address." });

  try {
    const customers = await stripe(
      `customers?email=${encodeURIComponent(email)}&limit=10`,
      env.STRIPE_SECRET_KEY,
      fetchImpl,
    );
    for (const c of customers?.data ?? []) {
      const sub = await subscriptionFor(c.id, env.STRIPE_SECRET_KEY, fetchImpl);
      if (!sub || !ACTIVE_STATUSES.has(sub.status)) continue;
      const key = makeKey(c.id, env.YO_LICENSE_HMAC_SECRET);
      await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: env.YO_MAIL_FROM || "Yo <support@theyoapp.com>",
          to: [email],
          subject: "Your Yo license key",
          text: `Here's your Yo license key:\n\n${key}\n\nOpen Yo, choose "I have a key", and paste it.\n\nManage or cancel your subscription any time: https://theyoapp.com/support#billing\n`,
        }),
      });
      break;
    }
  } catch {
    // Same answer either way; a failure here shows up in the Vercel logs.
  }
  return json(200, SAME_ANSWER);
}

// Vercel calls this with the request (and maybe more); only the request is used.
export const POST = (request) => recoverLicense(request, process.env, fetch);
