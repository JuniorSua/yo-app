/**
 * Settings → Accounts → 1Password, and the logins behind Yo's onepassword_* tools.
 *
 * The user makes a 1Password service account limited to the vault(s) Yo may use and pastes its token once. The
 * token lives only in the SecretStore (Keychain on a Mac, the 0600 secrets file on a home server); the database
 * keeps only what Settings shows (vault names, last check, the last few uses, never a value). Vaults and login
 * lists are cached for a few minutes and lookups are capped per hour, because service accounts have small
 * request quotas (personal plans: 1,000 reads an hour, 1,000 requests a day).
 */
import type { OnePasswordApiMethods, OnePasswordStatus, OnePasswordUse } from "@yo/contracts";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { addSecret, logger, redact } from "../log";
import type { SecretStore } from "../secrets/SecretStore";
import {
  type BackendFactory,
  classifyError,
  type LoginOverview,
  type LoginSecrets,
  MESSAGES,
  type OnePasswordBackend,
  OnePasswordError,
  type VaultInfo,
} from "./backend";

const log = logger("1password");

export const TOKEN_KEY = "onepassword:token";
const KV = "onePassword";
/** Vaults and login lists are read again after this long. */
const CACHE_MS = 10 * 60_000;
/** Yo's own cap on 1Password calls, well under the service account's hourly quota. */
const MAX_CALLS_PER_HOUR = 120;
const RECENT_USES = 5;

interface Saved {
  connected: boolean;
  vaults: VaultInfo[];
  checkedAt: number | null;
  state: "ok" | "error";
  lastError: string | null;
  recent: OnePasswordUse[];
}

const EMPTY: Saved = {
  connected: false,
  vaults: [],
  checkedAt: null,
  state: "ok",
  lastError: null,
  recent: [],
};

/** Service account tokens start with "ops_" (a base64url blob after it). */
export function looksLikeToken(token: string): boolean {
  return /^ops_[A-Za-z0-9_\-.=+/]{20,}$/.test(token);
}

export interface OnePasswordDeps {
  store: Store;
  hub: Hub;
  secrets: SecretStore;
  /** The SDK backend in Yo; tests pass a fake. */
  backend: BackendFactory;
  now?: () => number;
}

export class OnePassword {
  private client: Promise<OnePasswordBackend> | null = null;
  private logins: { at: number; list: LoginOverview[] } | null = null;
  private calls: number[] = [];
  /** Not checked against 1Password since core started. */
  private checked = false;
  private readonly now: () => number;

  constructor(private readonly d: OnePasswordDeps) {
    this.now = d.now ?? Date.now;
  }

  private saved(): Saved {
    return { ...EMPTY, ...(this.d.store.getKv<Saved>(KV) ?? {}) };
  }

  private save(patch: Partial<Saved>): OnePasswordStatus {
    this.d.store.setKv(KV, { ...this.saved(), ...patch });
    const s = this.status();
    this.d.hub.push("onePassword.updated", s);
    return s;
  }

  /** `onePassword.*` for Settings (served on the UI socket, so only to a signed-in controller). */
  readonly api: {
    [M in keyof OnePasswordApiMethods]: (
      p: OnePasswordApiMethods[M]["params"],
    ) => Promise<OnePasswordApiMethods[M]["result"]>;
  } = {
    "onePassword.status": async () => this.status(),
    "onePassword.connect": async (p) => this.connect(String(p?.token ?? "")),
    "onePassword.test": async () => this.test(),
    "onePassword.disconnect": async () => this.disconnect(),
  };

  get connected(): boolean {
    return this.saved().connected;
  }

  status(): OnePasswordStatus {
    const s = this.saved();
    return {
      connected: s.connected,
      state: !s.connected ? "off" : s.state === "error" ? "error" : this.checked ? "ok" : "unchecked",
      vaults: s.connected ? s.vaults : [],
      checkedAt: s.connected ? s.checkedAt : null,
      lastError: s.connected ? s.lastError : null,
      recent: s.connected ? s.recent : [],
    };
  }

  /** What the agents' prompt says: the vault names, or null when 1Password isn't connected. */
  promptInfo(): { vaults: string[] } | null {
    const s = this.saved();
    return s.connected ? { vaults: s.vaults.map((v) => v.title) } : null;
  }

  /** Check a token with 1Password (it must see at least one vault), then save it. */
  async connect(raw: string): Promise<OnePasswordStatus> {
    const token = raw.trim();
    if (!looksLikeToken(token))
      throw new Error(
        "That doesn't look like a service account token. It starts with ops_ and is shown once, when the service account is made.",
      );
    addSecret(token);
    let vaults: VaultInfo[];
    try {
      const backend = await this.d.backend(token);
      vaults = await backend.vaults();
      if (!vaults.length) throw new OnePasswordError(NO_VAULTS, "no_access");
      this.client = Promise.resolve(backend);
    } catch (err) {
      const e = classifyError(err);
      log.warn(`connect failed: ${e.message}`);
      throw new Error(e.message);
    }
    await this.d.secrets.set(TOKEN_KEY, token);
    this.logins = null;
    this.checked = true;
    log.info(`connected; ${vaults.length} vault(s)`);
    return this.save({ connected: true, vaults, checkedAt: this.now(), state: "ok", lastError: null });
  }

  /** "Test": read the vaults again. A failure is shown on the card, not thrown. */
  async test(): Promise<OnePasswordStatus> {
    if (!this.connected) return this.status();
    try {
      const vaults = await this.withClient((c) => c.vaults());
      if (!vaults.length) throw new OnePasswordError(NO_VAULTS, "no_access");
      this.logins = null;
      this.checked = true;
      return this.save({ vaults, checkedAt: this.now(), state: "ok", lastError: null });
    } catch (err) {
      return this.save({ state: "error", lastError: classifyError(err).message, checkedAt: this.now() });
    }
  }

  async disconnect(): Promise<OnePasswordStatus> {
    await this.d.secrets.delete(TOKEN_KEY);
    this.client = null;
    this.logins = null;
    this.checked = false;
    log.info("disconnected");
    return this.save({ ...EMPTY });
  }

  /** Logins whose name or websites match the query, best first. Nothing secret. */
  async search(query: string, limit = 10): Promise<(LoginOverview & { vault: string })[]> {
    const list = await this.allLogins();
    const vaults = new Map(this.saved().vaults.map((v) => [v.id, v.title]));
    const q = query
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/.*$/, "");
    const score = (l: LoginOverview) => {
      if (!q) return 1;
      const title = l.title.toLowerCase();
      const hosts = l.sites.map((s) => s.url.toLowerCase());
      if (
        hosts.some(
          (h) =>
            h
              .replace(/^https?:\/\//, "")
              .replace(/^www\./, "")
              .split("/")[0] === q,
        )
      )
        return 4;
      if (title === q) return 3;
      if (hosts.some((h) => h.includes(q))) return 2;
      return title.includes(q) ? 1 : 0;
    };
    return list
      .map((l) => ({ l, s: score(l) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || a.l.title.localeCompare(b.l.title))
      .slice(0, limit)
      .map(({ l }) => ({ ...l, vault: vaults.get(l.vaultId) ?? "Vault" }));
  }

  /**
   * Read one login's values for filling. Every value is registered for redaction (log.ts), so it's scrubbed
   * from logs and bug reports even if something ever quoted it.
   */
  async login(vaultId: string, itemId: string): Promise<LoginSecrets> {
    if (!this.saved().vaults.some((v) => v.id === vaultId))
      throw new OnePasswordError(MESSAGES.no_access, "no_access");
    const secrets = await this.withClient((c) => c.login(vaultId, itemId));
    for (const v of [secrets.username, secrets.password, secrets.oneTimeCode]) if (v) addSecret(v);
    return secrets;
  }

  /** Audit: Settings shows the last few uses (which login, where, what), never a value. */
  recordUse(use: OnePasswordUse) {
    const recent = [use, ...this.saved().recent].slice(0, RECENT_USES);
    this.save({ recent });
  }

  private async allLogins(): Promise<LoginOverview[]> {
    if (this.logins && this.now() - this.logins.at < CACHE_MS) return this.logins.list;
    const list = await this.withClient(async (c) => {
      const vaults = await c.vaults();
      if (vaults.length) this.save({ vaults });
      const out: LoginOverview[] = [];
      for (const v of vaults) out.push(...(await c.logins(v.id)));
      return out;
    });
    this.logins = { at: this.now(), list };
    return list;
  }

  /** Run 1Password calls on the saved token's client, under Yo's hourly cap; failures become plain words. */
  private async withClient<T>(fn: (c: OnePasswordBackend) => Promise<T>): Promise<T> {
    if (!this.connected) throw new OnePasswordError(MESSAGES.not_connected, "not_connected");
    const now = this.now();
    this.calls = this.calls.filter((t) => now - t < 3_600_000);
    if (this.calls.length >= MAX_CALLS_PER_HOUR)
      throw new OnePasswordError(
        "Yo has used 1Password a lot in the last hour, so it's pausing lookups to stay under 1Password's limits. Try again later.",
        "rate_limited",
      );
    this.calls.push(now);
    try {
      this.client ??= this.d.secrets.get(TOKEN_KEY).then((token) => {
        if (!token) throw new OnePasswordError(MESSAGES.not_connected, "not_connected");
        return this.d.backend(token);
      });
      const client = await this.client.catch((err) => {
        this.client = null; // a client that couldn't be made is made again next time
        throw err;
      });
      const out = await fn(client);
      if (this.saved().state === "error") this.save({ state: "ok", lastError: null });
      this.checked = true;
      return out;
    } catch (err) {
      const e = classifyError(err);
      // A token that stopped working needs the user; anything else may pass.
      if (e.code === "bad_token" || e.code === "not_connected") {
        this.client = null;
        this.save({ state: "error", lastError: e.message });
      }
      log.warn(`1Password call failed: ${redact(e.message)}`);
      throw e;
    }
  }
}

const NO_VAULTS =
  "The service account can't see any vault. Make it again and give it access to the vault Yo should use.";
