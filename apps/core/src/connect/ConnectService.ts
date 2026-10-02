/**
 * API side of the "Connect your model" walkthrough. Every handler resolves (never throws for user mistakes)
 * and never logs or echoes a token.
 */
import type { ApiMethods, ConnectDetection } from "@yo/contracts";
import { addSecret, logger } from "../log";
import type { AccountService } from "../orchestrator/AccountService";
import {
  detectHost,
  type HostEnv,
  type HostFs,
  nodeHostEnv,
  nodeHostFs,
  parseClaudeToken,
  readCodexLogin,
  removeCodexLogin,
} from "./hostConnect";

const log = logger("connect");

type R<M extends keyof ApiMethods> = Promise<ApiMethods[M]["result"]>;

const SOMETHING_WRONG = "Yo couldn't save it. Try again; if it keeps happening, restart Yo.";

export class ConnectService {
  /** One import at a time: overlapping polls must not store the login twice. */
  private importing: Promise<ApiMethods["connect.codexImport"]["result"]> | null = null;

  constructor(
    private accounts: AccountService,
    private env: () => HostEnv = nodeHostEnv,
    private fs: HostFs = nodeHostFs,
  ) {}

  async detect(): Promise<ConnectDetection> {
    try {
      return await detectHost(this.env(), this.fs);
    } catch (err) {
      log.warn("host detection failed", err);
      const env = this.env();
      return {
        host: { platform: env.platform, name: env.hostname },
        claude: { installed: false, signedIn: null },
        codex: { installed: false, signedIn: null, yoLogin: false },
      };
    }
  }

  async claudeToken(p: { token: string; accountId?: string }): R<"connect.claudeToken"> {
    const check = parseClaudeToken(typeof p?.token === "string" ? p.token : "");
    if (!check.ok) return { ok: false, error: check.error };
    // From here on, any log line that somehow carries it prints [redacted].
    addSecret(check.token);
    const account = this.accounts.accountFor("claude", p.accountId);
    if (!account)
      return { ok: false, error: "Yo has no Claude account to connect. Restart Yo and try again." };
    try {
      return {
        ok: true,
        account: await this.accounts.connectWithSecrets(account.id, { claudeOauthToken: check.token }),
      };
    } catch (err: any) {
      // Not the error itself: it could carry the token.
      log.warn(`saving the Claude token failed (${err?.name ?? "error"})`);
      return { ok: false, error: SOMETHING_WRONG };
    }
  }

  codexImport(p: { accountId?: string } = {}): R<"connect.codexImport"> {
    this.importing ??= this.doCodexImport(p).finally(() => {
      this.importing = null;
    });
    return this.importing;
  }

  private async doCodexImport(p: { accountId?: string }): R<"connect.codexImport"> {
    const account = this.accounts.accountFor("codex", p?.accountId);
    if (!account)
      return { state: "error", error: "Yo has no ChatGPT account to connect. Restart Yo and try again." };
    const env = this.env();
    const found = await readCodexLogin(env, this.fs).catch(() => ({ state: "waiting" }) as const);
    if (found.state !== "found") return found;
    for (const v of codexSecretValues(found.authJson)) addSecret(v);
    try {
      const saved = await this.accounts.connectWithSecrets(account.id, { codexAuthJson: found.authJson });
      await removeCodexLogin(env, this.fs);
      return { state: "connected", account: saved };
    } catch (err: any) {
      log.warn(`saving the ChatGPT login failed (${err?.name ?? "error"})`);
      return { state: "error", error: SOMETHING_WRONG };
    }
  }
}

/** The token strings inside a Codex `auth.json`, to scrub from logs. */
export function codexSecretValues(authJson: string): string[] {
  try {
    const j = JSON.parse(authJson) as { tokens?: Record<string, unknown>; OPENAI_API_KEY?: unknown };
    return [...Object.values(j.tokens ?? {}), j.OPENAI_API_KEY].filter(
      (v): v is string => typeof v === "string" && v.length >= 8,
    );
  } catch {
    return [];
  }
}
