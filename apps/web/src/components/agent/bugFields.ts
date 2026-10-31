/**
 * report_bug tool items come straight from the model (input) and core (output). Read them defensively: a wrong
 * type in one field must never break rendering (there is no app-wide error boundary).
 */

export interface BugFields {
  title?: string;
  what_happened?: string;
  expected?: string;
  steps?: string[];
  evidence?: string;
  suspected_cause?: string;
  suggested_fix?: string;
  area?: string;
  severity?: string;
}

export interface BugCall extends BugFields {
  stage?: "draft" | "submit";
  draft_id?: string;
}

const TEXT = [
  "title",
  "what_happened",
  "expected",
  "evidence",
  "suspected_cause",
  "suggested_fix",
  "area",
  "severity",
] as const;

/** A usable string, or undefined (numbers/booleans are written out, objects and arrays are dropped). */
export function asText(v: unknown, max = 20_000): string | undefined {
  const s =
    typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined;
  const t = s?.trim();
  return t ? t.slice(0, max) : undefined;
}

/** The fields of a report_bug call; anything malformed is coerced or dropped. */
export function bugCall(input: unknown): BugCall {
  const a =
    input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const out: BugCall = {};
  for (const k of TEXT) {
    const v = asText(a[k], k === "title" ? 200 : undefined);
    if (v) out[k] = v;
  }
  const steps = Array.isArray(a.steps)
    ? a.steps.map((s) => asText(s, 2000)).filter((s): s is string => !!s)
    : (asText(a.steps)
        ?.split("\n")
        .map((s) => s.trim())
        .filter(Boolean) ?? []);
  if (steps.length) out.steps = steps.slice(0, 50);
  if (a.stage === "draft" || a.stage === "submit") out.stage = a.stage;
  const draftId = asText(a.draft_id, 100);
  if (draftId) out.draft_id = draftId;
  return out;
}

/** A tool result as text ("" when missing or not a string). */
export function outputText(v: unknown): string {
  return typeof v === "string" ? v : "";
}
