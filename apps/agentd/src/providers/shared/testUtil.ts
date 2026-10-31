/**
 * Test helpers for adapter tests (not used at runtime).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderEvent } from "@yo/contracts";
import type { AccountContext, EmitFn, SessionStartInput } from "../ProviderAdapter";

export interface Recorder {
  emit: EmitFn;
  log: (msg: string) => void;
  events: ProviderEvent[];
  logs: string[];
  /** Resolves with the first event matching `pred` (including already-recorded ones after `from`). */
  waitFor(pred: (e: ProviderEvent) => boolean, timeoutMs?: number, from?: number): Promise<ProviderEvent>;
  types(from?: number): string[];
}

export function recorder(): Recorder {
  const events: ProviderEvent[] = [];
  const logs: string[] = [];
  const waiters: { pred: (e: ProviderEvent) => boolean; resolve: (e: ProviderEvent) => void }[] = [];
  return {
    events,
    logs,
    emit: (_key, ev) => {
      // Every emitted event must satisfy the contract schema.
      ProviderEvent.parse(ev);
      events.push(ev);
      for (const w of [...waiters]) {
        if (w.pred(ev)) {
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(ev);
        }
      }
    },
    log: (m) => logs.push(m),
    waitFor(pred, timeoutMs = 10_000, from = 0) {
      const found = events.slice(from).find(pred);
      if (found) return Promise.resolve(found);
      return new Promise((resolve, reject) => {
        const t = setTimeout(
          () =>
            reject(new Error(`timed out waiting for event; got: ${events.map((e) => e.type).join(", ")}`)),
          timeoutMs,
        );
        waiters.push({
          pred,
          resolve: (e) => {
            clearTimeout(t);
            resolve(e);
          },
        });
      });
    },
    types(from = 0) {
      return events.slice(from).map((e) => e.type);
    },
  };
}

export function tempDir(prefix = "yo-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function account(
  provider: AccountContext["provider"],
  secrets: AccountContext["secrets"] = {},
): AccountContext {
  return { accountId: `acc_${provider}`, provider, configDir: tempDir(`yo-${provider}-`), secrets };
}

export function sessionInput(acc: AccountContext, over: Partial<SessionStartInput> = {}): SessionStartInput {
  return {
    sessionKey: "s1",
    agentId: "agt_1",
    account: acc,
    runtimeMode: "full-access",
    systemAppend: "You are Yo. The user likes window seats.",
    cwd: tempDir("yo-cwd-"),
    env: { DISPLAY: ":7" },
    mcpServers: [
      { name: "yo", command: "node", args: ["/opt/yo/yo-mcp.js"], env: { YO_AGENT: "agt_1" } },
      { name: "browser", command: "playwright-mcp", args: ["--cdp-endpoint", "http://127.0.0.1:9301"] },
    ],
    ...over,
  };
}

/** Compact "type[kind]" rendering of an event sequence for snapshot-ish assertions. */
export function shape(events: ProviderEvent[]): string[] {
  return events.map((e) => {
    switch (e.type) {
      case "item.started":
      case "item.updated":
      case "item.completed":
        return `${e.type}:${e.item.kind}`;
      case "content.delta":
        return `delta:${e.stream}`;
      case "session.state":
        return `state:${e.state}`;
      case "turn.completed":
        return `turn.completed:${e.status}`;
      case "request.opened":
        return `request.opened:${e.request.kind}`;
      default:
        return e.type;
    }
  });
}
