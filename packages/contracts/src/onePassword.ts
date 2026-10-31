/**
 * 1Password: Yo signs in to sites with logins from the user's 1Password, through a service account the user
 * limits to one vault (Settings → Accounts → 1Password). Core keeps the token in the SecretStore and resolves
 * logins itself; agentd types them into the agent's browser. The model only ever sees item names, websites and
 * an opaque item reference, never a username, password or one-time code.
 */
import { z } from "zod";
import { isPublicSuffix } from "./publicSuffix";

/** What Settings shows about the connection. Never carries the token. */
export interface OnePasswordStatus {
  /** A service account token is saved. */
  connected: boolean;
  /** "ok": the last check worked. "error": it didn't (see `lastError`). "unchecked": not checked since core started. */
  state: "off" | "ok" | "error" | "unchecked";
  /** The vaults the service account can read. */
  vaults: { id: string; title: string; items: number }[];
  /** When the vaults were last read from 1Password. */
  checkedAt: number | null;
  /** The last problem, in plain words (bad token, no vault access, offline, rate limit). */
  lastError: string | null;
  /** The last few times Yo used a login: which one, where, and what it filled. No values. */
  recent: OnePasswordUse[];
}

export interface OnePasswordUse {
  at: number;
  item: string;
  site: string;
  fields: OnePasswordFieldKind[];
  agentName: string;
}

/** `onePassword.*`: Settings → Accounts → 1Password. */
export interface OnePasswordApiMethods {
  "onePassword.status": { params: Record<string, never>; result: OnePasswordStatus };
  /** Save (after checking it with 1Password) a service account token. */
  "onePassword.connect": { params: { token: string }; result: OnePasswordStatus };
  /** Read the vaults again ("Test"). */
  "onePassword.test": { params: Record<string, never>; result: OnePasswordStatus };
  /** Forget the token. */
  "onePassword.disconnect": { params: Record<string, never>; result: OnePasswordStatus };
}

/** The fields Yo can fill from a login. */
export const ONE_PASSWORD_FIELDS = ["username", "password", "one_time_code"] as const;
export const OnePasswordFieldKind = z.enum(ONE_PASSWORD_FIELDS);
export type OnePasswordFieldKind = z.infer<typeof OnePasswordFieldKind>;

/** Plain words for a field, for cards and results ("username and password"). */
export const FIELD_WORDS: Record<OnePasswordFieldKind, string> = {
  username: "username",
  password: "password",
  one_time_code: "one-time code",
};

export function fieldList(kinds: readonly OnePasswordFieldKind[]): string {
  const words = kinds.map((k) => FIELD_WORDS[k]);
  if (words.length <= 1) return words[0] ?? "nothing";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

export const OnePasswordSearchInput = z.object({
  query: z.string().trim().max(200).default(""),
  limit: z.coerce.number().int().min(1).max(20).optional(),
});

export const OnePasswordFillInput = z.object({
  item_ref: z.string().trim().min(1, "item_ref is required (from onepassword_search)"),
  /** Which fields to fill. Absent: whichever of them the page shows and the login has. */
  fields: z.array(OnePasswordFieldKind).min(1).optional(),
});

/** The model's handle on an item: vault and item ids, nothing secret. */
export function itemRef(vaultId: string, itemId: string): string {
  return `1p:${vaultId}/${itemId}`;
}

export function parseItemRef(ref: string): { vaultId: string; itemId: string } | null {
  const m = /^1p:([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})$/.exec(ref.trim());
  return m ? { vaultId: m[1]!, itemId: m[2]! } : null;
}

/** 1Password's autofill rule for one of an item's websites. */
export type SiteMatchMode = "anywhere" | "exact" | "never";

export interface LoginSite {
  url: string;
  mode: SiteMatchMode;
}

/** A website as saved in 1Password ("github.com", "https://github.com/login") as a URL, or null. */
export function siteUrl(raw: string): URL | null {
  const s = raw.trim();
  if (!s) return null;
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    return u.protocol === "https:" || u.protocol === "http:" ? u : null;
  } catch {
    return null;
  }
}

/** The host a site is saved for, without "www." ("www.amazon.com" → "amazon.com"). */
export function siteHost(raw: string): string | null {
  const u = siteUrl(raw);
  return u ? u.hostname.toLowerCase().replace(/^www\./, "") : null;
}

/**
 * Whether a page may get this login.
 * - "anywhere": the saved host or one of its subdomains ("github.com" also fills on "gist.github.com", never on
 *   "evilgithub.com"). A public suffix ("github.io", "vercel.app", "co.uk") is not a host: it would match every
 *   site that shares that ending.
 * - "exact": the same host and port;
 * - "never": no page.
 * The page must be https, unless the login was saved for an http site on that same host.
 */
export function pageMatchesSite(pageUrl: string, site: LoginSite): boolean {
  if (site.mode === "never") return false;
  const want = siteUrl(site.url);
  let page: URL;
  try {
    page = new URL(pageUrl);
  } catch {
    return false;
  }
  if (!want) return false;
  if (page.protocol !== "https:" && !(page.protocol === "http:" && want.protocol === "http:")) return false;
  const pageHost = page.hostname.toLowerCase();
  if (site.mode === "exact") return pageHost === want.hostname.toLowerCase() && page.port === want.port;
  const base = want.hostname.toLowerCase().replace(/^www\./, "");
  // "www.github.io" is still the shared suffix github.io, not one site.
  if (base !== "localhost" && isPublicSuffix(base)) return false;
  if (!base.includes(".") && base !== "localhost") return false;
  return pageHost === base || pageHost.endsWith(`.${base}`);
}

export function pageMatchesAny(pageUrl: string, sites: readonly LoginSite[]): boolean {
  return sites.some((s) => pageMatchesSite(pageUrl, s));
}
