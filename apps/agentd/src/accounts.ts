/**
 * Provider account contexts. Config dirs live on the volume (0700); secrets are held in memory only —
 * yo-core re-sends them with account.configure after every hello. The one exception is a Codex login made
 * for Yo outside the computer (`codexAuthJson`): Codex only reads its login from CODEX_HOME, so it is seeded
 * there once (0600, like a device-code sign-in made here would be). See providers/codex/seed.ts.
 */
import { mkdirSync, rmSync } from "node:fs";
import type { AccountSecrets, ProviderKind } from "@yo/contracts";
import { assertSafeId, paths } from "./config";
import { seedCodexAuth } from "./providers/codex/seed";
import type { AccountContext } from "./providers/ProviderAdapter";

export type SeedLog = (msg: string) => void;

export class AccountStore {
  private accounts = new Map<string, AccountContext>();

  constructor(private log: SeedLog = () => {}) {}

  configure(accountId: string, provider: ProviderKind, secrets: AccountSecrets): AccountContext {
    assertSafeId(accountId, "accountId");
    const configDir = paths.accountDir(provider, accountId);
    mkdirSync(configDir, { recursive: true, mode: 0o700 });
    if (provider === "codex" && secrets.codexAuthJson) {
      try {
        const r = seedCodexAuth(configDir, secrets.codexAuthJson);
        if (r !== "kept") this.log(`codex login for ${accountId}: ${r} from the walkthrough`);
      } catch (err: any) {
        // Never the error text verbatim: keep secrets out of logs. Probe will report "not signed in".
        this.log(`codex login for ${accountId}: seeding failed (${err?.code ?? "error"})`);
      }
    }
    const ctx: AccountContext = { accountId, provider, configDir, secrets: { ...secrets } };
    this.accounts.set(accountId, ctx);
    return ctx;
  }

  /** Existing context, or a secret-less one (CLI-login providers keep their auth in configDir). */
  getOrCreate(accountId: string, provider: ProviderKind): AccountContext {
    const existing = this.accounts.get(accountId);
    if (existing) {
      if (existing.provider !== provider) {
        throw new Error(`account ${accountId} is ${existing.provider}, not ${provider}`);
      }
      return existing;
    }
    return this.configure(accountId, provider, {});
  }

  get(accountId: string): AccountContext | undefined {
    return this.accounts.get(accountId);
  }

  mergeSecrets(accountId: string, secrets: AccountSecrets): void {
    const a = this.accounts.get(accountId);
    if (a) a.secrets = { ...a.secrets, ...secrets };
  }

  remove(accountId: string, provider: ProviderKind, deleteFiles = true): void {
    assertSafeId(accountId, "accountId");
    this.accounts.delete(accountId);
    if (deleteFiles) rmSync(paths.accountDir(provider, accountId), { recursive: true, force: true });
  }
}
