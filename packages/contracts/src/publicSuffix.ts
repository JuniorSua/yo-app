/**
 * Public suffixes (the Public Suffix List, including its private section): "com", "co.uk", "github.io",
 * "vercel.app". A name that is only a suffix is shared by many unrelated sites, so it is not one website.
 */
import { parse } from "tldts";

/** Private suffixes count: github.io and vercel.app are each shared by many sites. */
const PSL = { allowPrivateDomains: true } as const;

/**
 * Whether `host` is a public suffix itself, not a site registered under one.
 * "github.io" and "vercel.app" are; "evil.github.io" and "uber.com" are not.
 * localhost and IP addresses are not suffixes.
 */
export function isPublicSuffix(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (!h || h === "localhost") return false;
  const parsed = parse(h, PSL);
  if (parsed.isIp) return false;
  return !!parsed.hostname && parsed.hostname === parsed.publicSuffix;
}

/**
 * A host a secure form may name: one website. A bare name ("uber") or a public suffix ("github.io",
 * "vercel.app", "co.uk") is not, because matching its subdomains would cover other people's sites.
 */
export function isSpecificSite(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  if (h === "localhost") return true;
  if (!h.includes(".")) return false;
  return !isPublicSuffix(h);
}
