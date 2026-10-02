import {
  type Account,
  type AccountSecrets,
  type AgentdPush,
  ENABLED_PROVIDERS,
  isProviderEnabled,
  type ProviderKind,
} from "@yo/contracts";
import type { AgentdClient } from "../agentd/AgentdClient";
import type { Store } from "../db/store";
import type { Hub } from "../hub";
import { logger } from "../log";
import type { SecretStore } from "../secrets/SecretStore";

const log = logger("accounts");

const LOGIN_METHOD = {
  claude: "claude-setup-token",
  codex: "codex-device-code",
  grok: "grok-login",
} as const;

/** A pending sign-in link stays valid for a while; re-show it instead of restarting within this window. */
const LOGIN_REUSE_MS = 25 * 60_000;

interface ActiveLogin {
  startedAt: number;
  prompt: { url?: string; userCode?: string; needsInput: boolean; message?: string } | null;
}

const DEFAULT_LABEL: Record<ProviderKind, string> = {
  claude: "Claude",
  codex: "ChatGPT",
  grok: "Grok",
};

/** Subscription accounts: persistence, secrets (Keychain), agentd configuration, sign-in flows. */
export class AccountService {
  private activeLogins = new Map<string, ActiveLogin>();
  /** Boots Yo's computer when a sign-in needs it (set by main). */
  ensureComputer: () => Promise<void> = async () => {};

  constructor(
    private store: Store,
    private secrets: SecretStore,
    private agentd: AgentdClient,
    private hub: Hub,
  ) {
    // An unhandled rejection here would crash core (Node exits on them), e.g. a push landing after shutdown.
    agentd.on("push", (p) => void this.onPush(p).catch((err) => log.warn("account push failed", err)));
    agentd.on("connected", () => {
      // Can race a shutdown (database already closed); nothing to do then.
      void this.configureAll()
        .then(() => this.refreshAll())
        .catch((err) => log.debug("account refresh after connect skipped", err));
    });
  }

  /**
   * Boot-time repair, so onboarding has cards to show and nothing points at a provider Yo doesn't offer:
   * - at least one account per enabled provider;
   * - the default account is an enabled one (Claude first);
   * - agents pinned to an account of a disabled provider (e.g. Grok, from an older Yo) go back to the default
   *   account with the provider's default model and effort (a Grok model id means nothing to Claude).
   * Accounts of disabled providers stay in the database, hidden (see list()), so nothing is lost if the
   * provider comes back.
   */
  ensureDefaults() {
    const existing = new Set(this.store.listAccounts().map((a) => a.provider));
    for (const p of ENABLED_PROVIDERS) {
      if (!existing.has(p)) this.store.createAccount(p, DEFAULT_LABEL[p]);
    }
    this.ensureEnabledDefault();
    for (const agent of this.store.listAgents()) {
      if (this.isHiddenAccount(agent.accountId)) {
        log.info(`agent ${agent.id} was on a provider Yo doesn't offer; moved to the default account`);
        this.store.updateAgent(agent.id, { accountId: null, model: null, effort: null });
      }
    }
  }

  /** Keep the default account on an enabled provider (the first one in ENABLED_PROVIDERS order). */
  private ensureEnabledDefault() {
    const accounts = this.list();
    if (accounts.some((a) => a.isDefault)) return;
    const next = ENABLED_PROVIDERS.map((p) => accounts.find((a) => a.provider === p)).find(Boolean);
    if (next) this.store.setDefaultAccount(next.id);
  }

  /** The accounts users can see and use: only those of enabled providers. */
  list(): Account[] {
    return this.store.listAccounts().filter((a) => isProviderEnabled(a.provider));
  }

  /** True when the account exists but its provider isn't offered (its agents use the default account). */
  isHiddenAccount(accountId: string | null | undefined): boolean {
    if (!accountId) return false;
    const a = this.store.getAccount(accountId);
    return !!a && !isProviderEnabled(a.provider);
  }

  /** An account of an enabled provider, or a clear error (hidden accounts are never offered). */
  private usable(id: string): Account {
    const a = this.store.getAccount(id);
    if (!a) throw new Error("Unknown account");
    if (!isProviderEnabled(a.provider)) throw new Error(`${a.label} isn't available in Yo.`);
    return a;
  }

  private pushAccount(id: string) {
    const a = this.store.getAccount(id);
    if (a && isProviderEnabled(a.provider)) this.hub.push("account.updated", a);
    return a;
  }

  async getSecrets(id: string): Promise<AccountSecrets> {
    const raw = await this.secrets.get(`account:${id}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as AccountSecrets;
    } catch {
      return {};
    }
  }

  private async setSecrets(id: string, s: AccountSecrets) {
    const merged = { ...(await this.getSecrets(id)), ...s };
    await this.secrets.set(`account:${id}`, JSON.stringify(merged));
  }

  async configure(id: string) {
    const a = this.store.getAccount(id);
    if (!a || !this.agentd.connected) return;
    await this.agentd.request("account.configure", {
      accountId: id,
      provider: a.provider,
      secrets: await this.getSecrets(id),
    });
  }

  async configureAll() {
    for (const a of this.list()) {
      await this.configure(a.id).catch((err) => log.warn(`configure ${a.id} failed`, err));
    }
  }

  async refreshAll() {
    await Promise.all(this.list().map((a) => this.refresh(a.id).catch(() => {})));
  }

  async add(provider: ProviderKind, label?: string): Promise<Account> {
    if (!isProviderEnabled(provider)) throw new Error(`${DEFAULT_LABEL[provider]} isn't available in Yo.`);
    const count = this.store.listAccounts().filter((a) => a.provider === provider).length;
    const a = this.store.createAccount(
      provider,
      label ?? `${DEFAULT_LABEL[provider]}${count ? ` ${count + 1}` : ""}`,
    );
    await this.configure(a.id).catch(() => {});
    this.hub.push("account.updated", a);
    return a;
  }

  async remove(id: string) {
    const a = this.store.getAccount(id);
    if (!a) return;
    if (this.agentd.connected)
      await this.agentd.request("account.remove", { accountId: id, provider: a.provider }).catch(() => {});
    await this.secrets.delete(`account:${id}`);
    this.store.deleteAccount(id);
    // The store hands "default" to the oldest account, which may be a hidden one.
    if (!this.list().some((acc) => acc.isDefault)) {
      const next = this.list()[0];
      if (next) this.store.setDefaultAccount(next.id);
    }
    this.hub.push("account.removed", { id });
    for (const acc of this.list()) this.hub.push("account.updated", acc);
  }

  setDefault(id: string) {
    this.usable(id);
    this.store.setDefaultAccount(id);
    for (const a of this.list()) this.hub.push("account.updated", a);
  }

  async refresh(id: string): Promise<Account> {
    const a = this.usable(id);
    if (!this.agentd.connected) return a;
    // Never clobber an in-progress sign-in (the paste-code box keys off "signing_in").
    if (this.activeLogins.has(id)) return a;
    try {
      const st = await this.agentd.request("auth.probe", { accountId: id, provider: a.provider }, 45000);
      if (this.activeLogins.has(id)) return this.store.getAccount(id)!;
      const label = a.label;
      this.store.updateAccount(id, {
        status: st.status,
        email: st.email ?? null,
        plan: st.plan ?? st.label ?? null,
        message: st.message ?? null,
        label,
      });
      if (st.status === "authenticated") {
        const { models } = await this.agentd.request(
          "models.list",
          { accountId: id, provider: a.provider },
          45000,
        );
        if (models.length) this.store.updateAccount(id, { models });
      }
    } catch (err: any) {
      this.store.updateAccount(id, { status: "error", message: String(err?.message ?? err) });
    }
    return this.pushAccount(id)!;
  }

  /**
   * Start (or resume) a sign-in. Returns immediately: booting Yo's computer can take a minute on a cold start,
   * so progress and errors are delivered as `account.login` pushes rather than by holding the request open.
   * Clicking Connect again while a flow is waiting re-shows the SAME link — restarting would invalidate the
   * code the user is about to paste (PKCE), which is what produced "OAuth error 400".
   */
  async loginStart(id: string, opts: { restart?: boolean } = {}) {
    const a = this.usable(id);
    const active = this.activeLogins.get(id);
    if (active && !opts.restart) {
      if (active.prompt && Date.now() - active.startedAt < LOGIN_REUSE_MS) {
        this.hub.push("account.login", { accountId: id, phase: "prompt", ...active.prompt });
        return;
      }
      if (!active.prompt && Date.now() - active.startedAt < 3 * 60_000) return; // still starting
    }
    const login: ActiveLogin = { startedAt: Date.now(), prompt: null };
    this.activeLogins.set(id, login);
    this.store.updateAccount(id, { status: "signing_in", message: null });
    this.pushAccount(id);
    void (async () => {
      try {
        if (!this.agentd.connected) {
          this.hub.push("account.login", {
            accountId: id,
            phase: "prompt",
            message: "Starting Yo's computer…",
          });
          await this.ensureComputer();
          await this.agentd.waitReady(180_000);
        }
        if (this.activeLogins.get(id) !== login) return;
        await this.configure(id);
        await this.agentd.request("auth.login.start", {
          accountId: id,
          provider: a.provider,
          method: LOGIN_METHOD[a.provider],
        });
      } catch (err: any) {
        if (this.activeLogins.get(id) !== login) return;
        this.activeLogins.delete(id);
        log.warn(`login start failed for ${id}`, err);
        this.store.updateAccount(id, { status: "unauthenticated", message: null });
        this.pushAccount(id);
        this.hub.push("account.login", {
          accountId: id,
          phase: "error",
          message: `Couldn't start sign-in: ${err?.message ?? err}`,
        });
      }
    })();
  }

  async loginInput(id: string, input: string) {
    await this.agentd.request("auth.login.input", { accountId: id, input });
  }

  async loginCancel(id: string) {
    this.activeLogins.delete(id);
    await this.agentd.request("auth.login.cancel", { accountId: id }).catch(() => {});
    this.hub.push("account.login", { accountId: id, phase: "done", message: "Sign-in canceled." });
    await this.refresh(id).catch(() => {});
  }

  async setApiKey(id: string, key: string): Promise<Account> {
    const a = this.usable(id);
    const field =
      a.provider === "claude" ? "anthropicApiKey" : a.provider === "codex" ? "openaiApiKey" : "xaiApiKey";
    await this.setSecrets(id, { [field]: key.trim() || undefined });
    await this.configure(id);
    return this.refresh(id);
  }

  /**
   * Save a sign-in made outside Yo's computer (the "Connect your model" walkthrough). With no computer to
   * check it yet, the account is honestly "unverified" until agentd probes it; if the computer is up, it's
   * configured and probed right away.
   */
  async connectWithSecrets(id: string, secrets: AccountSecrets): Promise<Account> {
    const a = this.store.getAccount(id);
    if (!a) throw new Error("Unknown account");
    await this.setSecrets(id, secrets);
    this.activeLogins.delete(id);
    this.store.updateAccount(id, {
      status: "unverified",
      email: null,
      plan: null,
      message: UNVERIFIED_MESSAGE,
    });
    this.pushAccount(id);
    const def = this.list().find((x) => x.isDefault);
    if (isProviderEnabled(a.provider) && (!def || (def.id !== id && !usable(def)))) this.setDefault(id);
    if (this.agentd.connected) {
      await this.configure(id).catch((err) => log.warn(`configure ${id} failed`, err));
      await this.refresh(id).catch(() => {});
    }
    return this.store.getAccount(id)!;
  }

  /** The account the walkthrough connects for a provider: the default one if it's that provider, else the first. */
  accountFor(provider: ProviderKind, id?: string): Account | null {
    if (id) {
      const a = this.store.getAccount(id);
      return a?.provider === provider && isProviderEnabled(provider) ? a : null;
    }
    const all = this.list().filter((a) => a.provider === provider);
    return all.find((a) => a.isDefault) ?? all[0] ?? null;
  }

  private async onPush(p: AgentdPush) {
    if (p.type === "auth.login.prompt") {
      const login = this.activeLogins.get(p.accountId);
      const prompt = { url: p.url, userCode: p.userCode, needsInput: p.needsInput, message: p.message };
      if (login) login.prompt = prompt;
      this.hub.push("account.login", { accountId: p.accountId, phase: "prompt", ...prompt });
    } else if (p.type === "auth.login.result") {
      this.activeLogins.delete(p.accountId);
      if (p.ok && p.secrets && Object.keys(p.secrets).length) {
        await this.setSecrets(p.accountId, p.secrets);
        await this.configure(p.accountId).catch(() => {});
      }
      this.hub.push("account.login", {
        accountId: p.accountId,
        phase: p.ok ? "done" : "error",
        message: p.message,
      });
      await this.refresh(p.accountId).catch(() => {});
      if (p.ok) {
        const a = this.store.getAccount(p.accountId);
        // Make the first working subscription the default.
        const def = this.list().find((x) => x.isDefault);
        if (a?.status === "authenticated" && isProviderEnabled(a.provider) && (!def || !usable(def)))
          this.setDefault(a.id);
      }
    }
  }

  /**
   * Resolve the account an agent should use. Never one of a disabled provider: an agent still pinned to a
   * hidden account runs on the default account instead.
   */
  resolveFor(agentAccountId: string | null): Account | null {
    if (agentAccountId) {
      const a = this.store.getAccount(agentAccountId);
      if (a && isProviderEnabled(a.provider)) return a;
    }
    const accounts = this.list();
    const def = accounts.find((a) => a.isDefault) ?? null;
    if (def?.status === "authenticated") return def;
    return (
      accounts.find((a) => a.status === "authenticated") ??
      (def && usable(def) ? def : null) ??
      accounts.find((a) => a.status === "unverified") ??
      def ??
      accounts[0] ??
      null
    );
  }
}

export const UNVERIFIED_MESSAGE = "Connected. Yo will check it when its computer starts.";

/** Signed in, or saved by the walkthrough and waiting for the computer to check it. */
export function usable(a: Pick<Account, "status">): boolean {
  return a.status === "authenticated" || a.status === "unverified";
}
