/**
 * Secure forms (`request_secure_input`): when a site needs a code, password or other private value, the agent
 * asks for it with a card in the chat instead of in a message. The user types it into the card, core hands it
 * to agentd's browser.fillLogin (the same path as 1Password sign-ins), and the agent only learns what was
 * filled where. The values are never stored, logged, pushed to other channels or shown to the model.
 */
import { z } from "zod";
import type { OnePasswordFieldKind } from "./onePassword";

export const SECURE_INPUT_TOOL = "request_secure_input";

export const SECURE_FIELD_KINDS = [
  "one_time_code",
  "password",
  "username",
  "email",
  "phone",
  "text",
] as const;
export const SecureFieldKind = z.enum(SECURE_FIELD_KINDS);
export type SecureFieldKind = z.infer<typeof SecureFieldKind>;

export const SecureField = z.object({
  kind: SecureFieldKind,
  /** What the card's input is called ("Code from your text message"). */
  label: z.string().trim().min(1, "Each field needs a label").max(80),
});
export type SecureField = z.infer<typeof SecureField>;

/**
 * A form fills one field of each kind the sign-in page has (who you are, a password, a code), so at most 3.
 * Longer sign-ins come in steps: ask again on the next page.
 */
export const SECURE_MAX_FIELDS = 3;
/** Longest value the card takes. */
export const SECURE_VALUE_MAX = 512;

/** The card's payload on a pending request (PendingRequest.secureForm). Never holds a value. */
export const SecureForm = z.object({
  /** The host the values may be typed into ("uber.com", also its subdomains). */
  site: z.string(),
  reason: z.string(),
  fields: z.array(SecureField).min(1).max(SECURE_MAX_FIELDS),
});
export type SecureForm = z.infer<typeof SecureForm>;

export const RequestSecureInputInput = z.object({
  site: z.string().trim().min(1, "site is required, e.g. 'uber.com'").max(253),
  reason: z.string().trim().max(500).default(""),
  fields: z
    .array(SecureField)
    .min(1, "Ask for at least one field")
    .max(SECURE_MAX_FIELDS, `Ask for at most ${SECURE_MAX_FIELDS} fields at a time`),
});

/** The sign-in field each kind goes into: browser.fillLogin knows a name, a password and a code. */
export const SECURE_FILL_KIND: Record<SecureFieldKind, OnePasswordFieldKind> = {
  one_time_code: "one_time_code",
  password: "password",
  username: "username",
  email: "username",
  phone: "username",
  text: "username",
};

/** Plain words for a field, for results ("one-time code"). A free-text field goes by its label. */
export function secureFieldWords(f: SecureField): string {
  if (f.kind === "text") return `"${f.label}"`;
  return {
    one_time_code: "one-time code",
    password: "password",
    username: "username",
    email: "email",
    phone: "phone number",
  }[f.kind];
}

export function secureFieldList(fields: readonly SecureField[]): string {
  const words = fields.map(secureFieldWords);
  if (words.length <= 1) return words[0] ?? "nothing";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Kind names only, never an agent-written label. */
const KIND_WORDS: Record<SecureFieldKind, string> = {
  one_time_code: "one-time code",
  password: "password",
  username: "username",
  email: "email",
  phone: "phone number",
  text: "text",
};

function joinWords(words: string[]): string {
  if (words.length <= 1) return words[0] ?? "nothing";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** Card title and notifications. The real page host and the field kinds: never the agent's labels or reason. */
export function secureFormTitle(fields: readonly SecureField[], pageHost: string): string {
  const words = joinWords(fields.map((f) => KIND_WORDS[f.kind]));
  return `${words.charAt(0).toUpperCase()}${words.slice(1)} for ${pageHost}`;
}

/** The card's key line. Fixed app text: who is asking, and the page the dry run actually found. */
export function secureFormAskLine(agentName: string, pageHost: string): string {
  return `${agentName} is asking you to type this into the page on ${pageHost}.`;
}

/** Shown with the key line when a password is one of the fields. The host is the real page, not the agent's site. */
export function secureFormPasswordCaution(pageHost: string): string {
  return `This includes a password. Only continue if ${pageHost} is the site you mean to sign in to.`;
}

/** Labels the agent's reason so it isn't read as the app's own sentence. */
export function secureFormReasonLabel(agentName: string): string {
  return `${agentName} says`;
}

/** The resolved card when the browser fill failed. Fixed text: it never quotes an error that might hold a value. */
export const SECURE_FILL_FAILED = "Couldn't fill the page";

export function secureFormFailedHint(agentName: string): string {
  return `Nothing was typed in and nothing was saved. Ask ${agentName} to try again.`;
}

/** The fillLogin kinds for a form, or why it can't be filled in one go (two fields that go into the same box). */
export function secureFillKinds(
  fields: readonly SecureField[],
): { kinds: OnePasswordFieldKind[] } | { error: string } {
  const kinds = fields.map((f) => SECURE_FILL_KIND[f.kind]);
  const dup = kinds.find((k, i) => kinds.indexOf(k) !== i);
  if (dup)
    return {
      error:
        dup === "username"
          ? "A secure form can ask for one name field (username, email, phone or text), one password and one one-time code. Ask for the rest on the next step."
          : `A secure form can ask for one ${dup === "password" ? "password" : "one-time code"} at a time.`,
    };
  return { kinds };
}

/**
 * What the user typed, checked against the form: one non-empty value per field. A code loses its spaces
 * ("482 913"). Error messages name the field, never the value.
 */
export function cleanSecureValues(
  fields: readonly SecureField[],
  values: unknown,
): { values: string[] } | { error: string } {
  if (!Array.isArray(values) || values.length !== fields.length)
    return { error: "Fill in every field of the secure form." };
  const out: string[] = [];
  for (const [i, f] of fields.entries()) {
    const raw = values[i];
    if (typeof raw !== "string") return { error: `Fill in "${f.label}".` };
    const v = f.kind === "one_time_code" ? raw.replace(/\s+/g, "") : f.kind === "password" ? raw : raw.trim();
    if (!v) return { error: `Fill in "${f.label}".` };
    if (v.length > SECURE_VALUE_MAX) return { error: `"${f.label}" is too long.` };
    out.push(v);
  }
  return { values: out };
}
