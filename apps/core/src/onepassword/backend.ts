/**
 * What Yo needs from 1Password, behind one small interface: the real one is the official SDK with a service
 * account token (sdkBackend.ts); tests use a fake. Only `login()` returns secret values, and only core calls it.
 */
import type { LoginSite } from "@yo/contracts";

export interface VaultInfo {
  id: string;
  title: string;
  items: number;
}

/** A login as listed: nothing secret (no username, no password). */
export interface LoginOverview {
  vaultId: string;
  itemId: string;
  title: string;
  sites: LoginSite[];
  /** The item has a one-time code (only known once it's been read; list results say null). */
  hasCode?: boolean | null;
}

/** A login as read for filling. Never logged, never returned to the model. */
export interface LoginSecrets {
  title: string;
  sites: LoginSite[];
  username?: string;
  password?: string;
  oneTimeCode?: string;
}

export interface OnePasswordBackend {
  vaults(): Promise<VaultInfo[]>;
  /** Login and Password items in one vault. */
  logins(vaultId: string): Promise<LoginOverview[]>;
  login(vaultId: string, itemId: string): Promise<LoginSecrets>;
}

export type BackendFactory = (token: string) => Promise<OnePasswordBackend>;

/** A 1Password failure in plain words, with a code core can act on. Never carries the token. */
export class OnePasswordError extends Error {
  constructor(
    message: string,
    readonly code: "bad_token" | "rate_limited" | "offline" | "no_access" | "not_connected" | "other",
  ) {
    super(message);
  }
}

export const MESSAGES = {
  bad_token:
    "1Password turned the token down. It may have been revoked, or copied incompletely. Make a new service account token and connect again.",
  rate_limited:
    "1Password's limit for this service account is used up for now (it allows about 1,000 lookups an hour on personal plans). Try again later.",
  offline: "Couldn't reach 1Password. Check the internet connection of the computer Yo runs on.",
  no_access: "The service account can't open that vault or item. Check which vaults it was given.",
  not_connected: "1Password isn't connected. Connect it in Settings → Accounts → 1Password.",
} as const;

/** Map whatever the SDK threw to a OnePasswordError (its message never contains the token). */
export function classifyError(err: unknown): OnePasswordError {
  if (err instanceof OnePasswordError) return err;
  const name = (err as { constructor?: { name?: string } })?.constructor?.name ?? "";
  const msg = String((err as { message?: string })?.message ?? err);
  if (
    name === "AuthExpiredError" ||
    /unauthori[sz]ed|invalid (service account )?token|auth.*(fail|expired|invalid)|revoked|signature|malformed/i.test(
      msg,
    )
  )
    return new OnePasswordError(MESSAGES.bad_token, "bad_token");
  if (name === "RateLimitExceededError" || /rate.?limit|too many requests|\b429\b/i.test(msg))
    return new OnePasswordError(MESSAGES.rate_limited, "rate_limited");
  if (
    /error sending request|dns|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|timed? ?out|network|offline|connect/i.test(
      msg,
    )
  )
    return new OnePasswordError(MESSAGES.offline, "offline");
  if (/not found|no (such )?vault|permission|forbidden|access denied|\b40[34]\b/i.test(msg))
    return new OnePasswordError(MESSAGES.no_access, "no_access");
  return new OnePasswordError(`1Password couldn't do that: ${msg.slice(0, 200)}`, "other");
}
