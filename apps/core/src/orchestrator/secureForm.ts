/**
 * request_secure_input's words for the agent: what a fill did, or why it couldn't. The card itself and the value
 * path live in Orchestrator (secureInput / respond). Nothing here ever sees a value in a way that leaves this
 * process: unknown agentd errors are replaced (they can quote a typed value), and results only say which
 * fields were filled where.
 */
import {
  type FillLoginResult,
  type LoginSite,
  pageMatchesAny,
  SECURE_FILL_KIND,
  type SecureField,
  secureFieldList,
} from "@yo/contracts";

/** The card's answer once the fill succeeded (also its "Submitted" label in the timeline). */
export const SECURE_SUBMITTED = "Submitted";

/** The card's stored line when the fill failed. Fixed text, so it can't repeat an error that quoted a value. */
export const SECURE_FILL_FAILED_OUTPUT = "Couldn't fill the page. Nothing was saved. Ask to try again.";

/** Where a form for `host` may be typed: that site and its subdomains, over https. `host` must not be a public suffix. */
export function secureSites(host: string): LoginSite[] {
  return [{ url: `https://${host}`, mode: "anywhere" }];
}

/**
 * The dry-run's host, or null when it isn't a single hostname. A bad host must not become the card's sentence
 * ("auth.uber.com\nYo support says…").
 */
export function pageHostOf(raw: string): string | null {
  const h = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h.length > 253 || !/^[a-z0-9._-]+$/.test(h)) return null;
  if (h.startsWith(".") || h.startsWith("-") || h.endsWith(".") || h.endsWith("-") || h.includes(".."))
    return null;
  return h;
}

/** Whether the page agentd found (its host) is on the form's site. */
export function onSite(pageHost: string, host: string): boolean {
  return pageMatchesAny(`https://${pageHost}/`, secureSites(host));
}

/** The form's fields the page doesn't show (by where they'd go). */
export function missingFields(fields: readonly SecureField[], found: readonly string[]): SecureField[] {
  return fields.filter((f) => !found.includes(SECURE_FILL_KIND[f.kind]));
}

/**
 * Fill errors whose text we wrote, so it doesn't contain a typed value. Anything else (a CDP error, an
 * unexpected agentd message) is replaced: the original text can quote what was just typed.
 */
const KNOWN_FILL_CODES = new Set([
  "no_site",
  "no_browser",
  "page_error",
  "page_changed",
  "no_field",
  "no_value",
  "no_focus",
  "not_taken",
  "moved",
  "fill_failed",
]);

/** agentd's refusal in words the agent can act on. Never the raw text of an unknown error. */
export function secureFillError(err: unknown, host: string): Error {
  const code = typeof (err as { code?: unknown })?.code === "string" ? (err as { code: string }).code : "";
  const message = String((err as Error)?.message ?? err);
  if (code === "invalid_request" || /invalid request: type/i.test(message))
    return new Error(
      "Yo's computer needs an update before it can fill secure forms. Ask the user to update Yo and restart its computer; use request_takeover meanwhile.",
    );
  if (/agentd not connected|timed out/i.test(message))
    return new Error("Yo's computer isn't answering right now. Try again in a moment.");
  if (code === "no_tab")
    return new Error(
      `No tab in your browser is on ${host}. Open the page that asks for it first: a secure form only fills a page on ${host}.`,
    );
  if (code && KNOWN_FILL_CODES.has(code) && err instanceof Error) return err;
  return new Error("Couldn't type into the page. Try again.");
}

/**
 * Drop typed values from text that goes back to the model. Unknown errors are already replaced; this also
 * covers a known error whose message was stuffed with a value. Very short values are left alone so a
 * one-letter password can't erase the rest of the sentence (those errors are still replaced when unknown).
 */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  const seen = new Set<string>();
  for (const secret of secrets) {
    if (secret.length < 3 || seen.has(secret)) continue;
    seen.add(secret);
    out = out.split(secret).join("…");
  }
  return out;
}

/** The tool's result after a fill: which fields went in where, and what to do next. Never a value. */
export function secureFillResult(fields: readonly SecureField[], r: FillLoginResult): string {
  const filled = fields.filter((f) => r.filled.includes(SECURE_FILL_KIND[f.kind]));
  const skipped = fields.filter((f) => !filled.includes(f));
  return [
    `Filled the ${secureFieldList(filled)} on ${r.host}${r.submitted ? " and submitted the form" : ""}.`,
    skipped.length ? `The page no longer showed a field for the ${secureFieldList(skipped)}.` : "",
    r.stillOnForm
      ? "The form is still showing (a wrong value, or one more step): Yo cleared any password or code from it. Take a snapshot to see what the page says."
      : "Take a snapshot to see the result. If the page asks for something else, call request_secure_input again.",
  ]
    .filter(Boolean)
    .join(" ");
}
