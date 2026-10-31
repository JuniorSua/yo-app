import type { PendingRequest } from "@yo/contracts";

/**
 * The sensitive-detail check: what in a message or post Yo is about to send looks like something the user may not
 * mean to share (a card number, a Social Security number, bank details, a password, an API key, a health detail).
 * The approval card warns before they allow it. Labels are plain words and never carry the value itself.
 *
 * It errs on the side of quiet: a warning on every order number or "password reset link" would teach the user to
 * ignore it, so numbers must look like the real thing (a card's prefix and checksum, an IBAN's checksum) and
 * passwords need a value next to them.
 */
export type SensitiveFinding = NonNullable<PendingRequest["sensitive"]>[number];
type Kind = SensitiveFinding["kind"];

/** Luhn checksum (card numbers). */
function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The issuer prefixes of real cards: Visa, Mastercard, Amex, Discover, JCB, Diners, UnionPay. */
const CARD_PREFIX =
  /^(?:4|5[1-5]|2(?:2[2-9]|[3-6]\d|7[01]|720)|3[47]|6(?:011|4[4-9]|5)|35|3(?:0[0-5]|[68])|62)/;

/**
 * Card-shaped runs: grouped in fours (with spaces, dots or dashes), Amex 4-6-5, or 13-19 digits in a row. A grouped
 * run can't sit inside a longer one (a 22-digit tracking number in fours) but may be followed by an expiry or CVV.
 */
const CARD_GROUPED = /(?<![\d-])(?<!\d[ .])\d{4}([ .-])\d{4}\1\d{4}\1\d{1,4}(?:\1\d{3})?(?!\d|\1\d{4}|-)/g;
const CARD_AMEX = /(?<![\d-])(?<!\d[ .])\d{4}([ .-])\d{6}\1\d{5}(?!\d|\1\d{4}|-)/g;
const CARD_PLAIN = /(?<![\d-])\d{13,19}(?![\d-])/g;
/**
 * A plain run of digits right after these words is an order, tracking or reference number, not a card. A bare "#"
 * isn't enough ("Card #4111…" is a card).
 */
const NOT_A_CARD =
  /(?:order|tracking|track|confirmation|conf|invoice|reference|ref|booking|shipment|parcel|ticket|case)\W{0,4}(?:no\.?|number|num|id|code)?\W{0,4}$/i;
/** No-break and other fixed-width spaces, read as plain spaces between digit groups. */
const ODD_SPACES = /[\u00a0\u2007\u2009\u202f]/g;

function findCard(raw: string): string | null {
  const text = raw.replace(ODD_SPACES, " ");
  const check = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && CARD_PREFIX.test(digits) && luhn(digits)
      ? digits
      : null;
  };
  for (const re of [CARD_GROUPED, CARD_AMEX]) {
    for (const m of text.matchAll(re)) {
      // "4242 4242 4242 4242 123": the card, then a CVV.
      const digits = check(m[0]) ?? check(m[0].replace(/\D/g, "").slice(0, 16));
      if (digits) return digits;
    }
  }
  for (const m of text.matchAll(CARD_PLAIN)) {
    if (NOT_A_CARD.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    const digits = check(m[0]);
    if (digits) return digits;
  }
  return null;
}

/** US SSN: ###-##-####, never 000/666/9xx, 00 or 0000. */
const SSN = /(?<![\d-])(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}(?![\d-])/;

/** IBAN: country, check digits, then 11-30 letters and digits (spaces every four allowed). Checked with mod 97. */
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]){11,30}\b/g;

/** An IBAN-shaped run may have picked up a word after it ("… 32 THANKS"): try it shorter, a group at a time. */
function hasIban(text: string): boolean {
  for (const m of text.matchAll(IBAN)) {
    const parts = m[0].split(" ");
    for (let k = parts.length; k >= 1; k--) if (ibanValid(parts.slice(0, k).join(""))) return true;
  }
  return false;
}

function ibanValid(s: string): boolean {
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const d of v) rem = (rem * 10 + (d.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** "routing number 021000021", "account number: 12345678", "acct # 0012 3456". */
const BANK_WORDS =
  /\b(?:routing|aba|account|acct|bank\s+account|checking\s+account|savings\s+account)(?:\s*(?:number|no\.?|num|#))?\s*(?:is|:|#|=|-)?\s*\d(?:[ -]?\d){5,16}(?!\d)/i;

/** "password: …", "pw = …", "PIN: 4821", "passcode 1234". */
const PASSWORD_COLON = /\b(?:password|passwd|pwd|pw|passcode|pass\s?code|pin(?:\s?code)?)\s*[:=]\s*\S/i;
const PASSCODE_DIGITS = /\b(?:password|passcode|pass\s?code|pin(?:\s?code)?)\s+(?:is\s+)?\d{4,}\b/i;
/** "my password is hunter2": a value with a digit, a symbol, a mix of cases, or in quotes. Not "is wrong". */
const PASSWORD_IS = /\b(?:password|passcode|pass\s?code)\s+is\s+(\S+)/gi;

function passwordValue(word: string): boolean {
  if (/^["'`“‘].+/.test(word)) return true;
  const w = word.replace(/[.,;!?)]+$/, "");
  return /\d/.test(w) || /[^A-Za-z]/.test(w) || /.[A-Z]/.test(w);
}

/** Secret keys and tokens by their well-known shapes. */
const KEYS = [
  /\bsk-(?:[A-Za-z]+-)?[A-Za-z0-9_-]{20,}/,
  /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/,
  /\bxox[bpas]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{35}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Health details: words that rarely mean anything else. */
const HEALTH =
  /\b(?:diagnos(?:is|es|ed)|prescriptions?|prescribed|medications?|antidepressants?|HIV|pregnant|pregnancy|miscarriage|therap(?:y|ies|ist|ists)|psychotherapy|psychiatric|psychiatrist|chemotherapy|chemo|blood\s+(?:test|work)\s+results?|lab\s+results?|biopsy|medical\s+records?|mental\s+health|insulin|diabet(?:es|ic)|cancer)\b/i;

const LABELS: Record<Exclude<Kind, "card">, string> = {
  ssn: "a Social Security number",
  bank: "bank account details",
  password: "a password",
  key: "an API key or token",
  health: "a health detail",
};

/** Everything sensitive-looking in `text`, at most one finding per kind, in a fixed order. */
export function findSensitive(text: string): SensitiveFinding[] {
  if (!text) return [];
  const out: SensitiveFinding[] = [];
  const card = findCard(text);
  if (card) out.push({ kind: "card", label: `a card number ending ${card.slice(-4)}` });
  const add = (kind: Exclude<Kind, "card">) => out.push({ kind, label: LABELS[kind] });
  if (SSN.test(text)) add("ssn");
  if (BANK_WORDS.test(text) || hasIban(text)) add("bank");
  if (
    PASSWORD_COLON.test(text) ||
    PASSCODE_DIGITS.test(text) ||
    [...text.matchAll(PASSWORD_IS)].some((m) => passwordValue(m[1] ?? ""))
  )
    add("password");
  if (KEYS.some((re) => re.test(text))) add("key");
  if (HEALTH.test(text)) add("health");
  return out;
}

/**
 * What request_approval's category carries by design, so its check leaves that kind out: a purchase is paid with
 * a card, a sign-in uses a password or key. Everything else is still looked for (an SSN in a checkout form, a
 * health detail in a sign-up).
 */
const EXPECTED_FOR: Record<string, readonly Kind[]> = {
  purchase: ["card"],
  credentials: ["password", "key"],
};

/** findSensitive for a request_approval of `category`, minus what that category is expected to carry. */
export function findSensitiveFor(category: string, text: string): SensitiveFinding[] {
  const expected = EXPECTED_FOR[category] ?? [];
  return findSensitive(text).filter((f) => !expected.includes(f.kind));
}
