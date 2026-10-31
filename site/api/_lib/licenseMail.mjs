// Emails a license key once, right after checkout (called from api/license/session.mjs).
//
// There is no database: the key is an HMAC of the Stripe customer id, and nothing in this repo stores a
// "sent" flag. The durable place is metadata on the Checkout Session this request already loaded
// (`yo_license_emailed`). Stripe can update that after the session is complete. A Set in this process covers
// a second request that arrives before the write lands (a refresh, or the thanks page asking twice). Resend's
// Idempotency-Key, the session id, covers another instance of this function within a day. That still works
// if the Stripe key is only allowed to read Checkout Sessions and the metadata write is refused.
//
// Nothing here runs unless RESEND_API_KEY and YO_MAIL_FROM are both set and non-empty. A failed send is
// logged without the key or either API key, and never changes the thanks-page response. The send stays
// alive on context.waitUntil, or on the Vercel request-context symbol when that argument is missing. If
// neither exists, the response waits for the send for at most 2.5s, then returns the key anyway.

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}$/;
/** Public customer portal. Keep equal to STRIPE_PORTAL_LINK in site/config.js. */
export const PORTAL_URL = "https://billing.stripe.com/p/login/3cIbJ0gDz3yh4GvbGR0Ba00";
const MARK = "yo_license_emailed";
const STRIPE_VERSION = "2024-09-30";
/** How long to wait for the send when Vercel will not keep the function alive after the response. */
export const SEND_CAP_MS = 2500;
const VERCEL_REQUEST_CONTEXT = Symbol.for("@vercel/request-context");

const sent = new Set();
let markUnsupported = false;
let tail = Promise.resolve();

function trimmed(value) {
  return typeof value === "string" ? value.trim() : "";
}

/** A https://billing.stripe.com/… link, or "" if it isn't one. Same checks as site/contact.js. */
export function portalLink(raw) {
  const text = trimmed(raw);
  if (!text) return "";
  try {
    const u = new URL(text);
    const ok =
      u.protocol === "https:" &&
      u.hostname === "billing.stripe.com" &&
      !u.port &&
      !u.username &&
      !u.password &&
      /^(\/[A-Za-z0-9_-]+)+$/.test(u.pathname);
    return ok ? u.href : "";
  } catch {
    return "";
  }
}

/** Plain text of the purchase email. `portal` is included only when it is a real portal link. */
export function licenseKeyEmailText(key, portal = PORTAL_URL) {
  const lines = [
    "Your Yo license key:",
    "",
    key,
    "",
    "Download Yo: https://theyoapp.com",
    "Open Yo, paste this key, and click Activate.",
  ];
  const href = portalLink(portal);
  if (href) lines.push("", `Manage or cancel your subscription: ${href}`);
  return `${lines.join("\n")}\n`;
}

function normalizeEmail(email) {
  if (typeof email !== "string") return "";
  const v = email.trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : "";
}

function logSendFailed(status) {
  if (typeof status === "number") console.error(`license email: send failed (${status})`);
  else console.error("license email: send failed");
}

function logMarkFailed(status) {
  if (typeof status === "number") console.error(`license email: mark failed (${status})`);
  else console.error("license email: mark failed");
}

function tryWaitUntil(wait, thisArg, promise) {
  if (typeof wait !== "function") return false;
  try {
    wait.call(thisArg, promise);
    return true;
  } catch {
    return false;
  }
}

/** context.waitUntil, else the symbol @vercel/functions reads. Null when neither is there. */
function keepAlive(context) {
  if (typeof context?.waitUntil === "function") {
    return (promise) => tryWaitUntil(context.waitUntil, context, promise);
  }
  try {
    const ctx = globalThis[VERCEL_REQUEST_CONTEXT]?.get?.();
    if (typeof ctx?.waitUntil === "function") return (promise) => tryWaitUntil(ctx.waitUntil, ctx, promise);
  } catch {
    // A broken request context must not stop the key from being returned.
  }
  return null;
}

/** Resolves when `promise` settles, or after `ms`, whichever is first. Never rejects. */
function cap(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    promise.then(
      () => {
        clearTimeout(timer);
        resolve();
      },
      () => {
        clearTimeout(timer);
        resolve();
      },
    );
  });
}

/**
 * Keeps `promise` alive after the response when Vercel offers waitUntil. Otherwise returns a promise the
 * caller waits on, capped so a slow send cannot hold the key back.
 */
function arm(promise, context, sessionId) {
  const safe = promise.then(
    () => undefined,
    () => {
      sent.delete(sessionId);
      logSendFailed();
    },
  );
  tail = tail.then(() => safe);
  const wait = keepAlive(context);
  if (wait?.(safe)) return null;
  return cap(safe, SEND_CAP_MS);
}

async function postEmail(opts, apiKey, from, to) {
  try {
    const res = await opts.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Idempotency-Key": `yo-license/${opts.sessionId}`,
      },
      body: JSON.stringify({
        from,
        to: [to],
        subject: "Your Yo license key",
        text: licenseKeyEmailText(opts.key),
      }),
    });
    if (!res?.ok) {
      logSendFailed(typeof res?.status === "number" ? res.status : 0);
      return false;
    }
    return true;
  } catch {
    logSendFailed();
    return false;
  }
}

async function markEmailed(opts) {
  if (markUnsupported) return;
  const stripeKey = trimmed(opts.env?.STRIPE_SECRET_KEY);
  if (!stripeKey) {
    logMarkFailed();
    return;
  }
  try {
    const res = await opts.fetchImpl(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(opts.sessionId)}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${stripeKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
          "Stripe-Version": STRIPE_VERSION,
        },
        body: `metadata[${MARK}]=1`,
      },
    );
    if (res?.ok) return;
    const status = typeof res?.status === "number" ? res.status : 0;
    // A read-only Stripe key refuses every mark. Say so once, then stop trying.
    if (status === 401 || status === 403) markUnsupported = true;
    logMarkFailed(status);
  } catch {
    logMarkFailed();
  }
}

async function deliver(opts, apiKey, from, to) {
  const ok = await postEmail(opts, apiKey, from, to);
  if (!ok) {
    sent.delete(opts.sessionId);
    return;
  }
  await markEmailed(opts);
}

/**
 * Starts the purchase email.
 * Returns null (and does no other work) when either mail env var is missing or blank, the buyer has no
 * usable address, this checkout was already emailed, or this process already claimed it. Returns null after
 * handing the send to waitUntil. Returns a promise only when nothing can keep the send alive: that promise
 * settles when the send finishes or after SEND_CAP_MS, and it never rejects.
 */
export function maybeEmailLicenseKey(opts) {
  const apiKey = trimmed(opts?.env?.RESEND_API_KEY);
  const from = trimmed(opts?.env?.YO_MAIL_FROM);
  if (!apiKey || !from) return null;
  try {
    const to = normalizeEmail(opts.email);
    if (!to) return null;
    const metadata = opts.metadata;
    if (metadata && typeof metadata === "object" && metadata[MARK] === "1") return null;
    if (typeof opts.sessionId !== "string" || sent.has(opts.sessionId)) return null;
    sent.add(opts.sessionId);
    return arm(deliver(opts, apiKey, from, to), opts.context, opts.sessionId);
  } catch {
    logSendFailed();
    return null;
  }
}

/** Resolves when every purchase email started in this process has finished (tests). */
export function licenseEmailsSettled() {
  return tail;
}

/** Clears the in-process "already sent" memory (tests). */
export function resetLicenseEmailState() {
  sent.clear();
  markUnsupported = false;
  tail = Promise.resolve();
}
