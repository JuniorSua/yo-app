/** Provider registry: one adapter instance per provider kind. */
import type { ProviderKind } from "@yo/contracts";
import { errMsg, type Logger } from "../log";
import { createClaudeAdapter } from "./claude/ClaudeAdapter";
import { createCodexAdapter } from "./codex/CodexAdapter";
import { createGrokAdapter } from "./grok/GrokAdapter";
import type { AdapterFactory, EmitFn, ProviderAdapter } from "./ProviderAdapter";

const FACTORIES: Record<ProviderKind, AdapterFactory> = {
  claude: createClaudeAdapter,
  codex: createCodexAdapter,
  grok: createGrokAdapter,
};

export class ProviderRegistry {
  private adapters = new Map<ProviderKind, ProviderAdapter>();
  private versionCache = new Map<ProviderKind, Promise<string | null>>();

  constructor(emit: EmitFn, log: Logger) {
    for (const [kind, factory] of Object.entries(FACTORIES) as [ProviderKind, AdapterFactory][]) {
      const plog = log.child(kind);
      try {
        this.adapters.set(kind, factory({ emit, log: (msg: string) => plog.info(msg) }));
      } catch (err) {
        log.error("adapter init failed", { provider: kind, err: errMsg(err) });
      }
    }
  }

  get(kind: ProviderKind): ProviderAdapter {
    const a = this.adapters.get(kind);
    if (!a) throw new Error(`provider ${kind} unavailable`);
    return a;
  }

  all(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  /** Adapter currently owning a session (fallback lookup). */
  findBySession(sessionKey: string): ProviderAdapter | undefined {
    return this.all().find((a) => a.hasSession(sessionKey));
  }

  /** CLI versions, cached after first successful lookup. */
  async versions(): Promise<{ kind: ProviderKind; version: string | null }[]> {
    const kinds = Object.keys(FACTORIES) as ProviderKind[];
    return Promise.all(
      kinds.map(async (kind) => {
        const a = this.adapters.get(kind);
        if (!a) return { kind, version: null };
        let p = this.versionCache.get(kind);
        if (!p) {
          p = Promise.race([
            a.version().catch(() => null),
            new Promise<null>((r) => setTimeout(() => r(null), 8000)),
          ]);
          this.versionCache.set(kind, p);
          p.then((v) => {
            if (v === null) this.versionCache.delete(kind);
          });
        }
        return { kind, version: await p };
      }),
    );
  }

  async dispose(): Promise<void> {
    await Promise.all(this.all().map((a) => a.dispose().catch(() => undefined)));
  }
}
