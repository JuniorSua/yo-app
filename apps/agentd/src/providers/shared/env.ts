/**
 * Child-process environment construction and secret hygiene.
 *
 * Provider CLIs must never see API keys they were not explicitly configured with (a stray
 * ANTHROPIC_API_KEY silently switches Claude from the subscription to API billing), nor agentd's
 * own control token.
 */
import type { AccountSecrets } from "@yo/contracts";

/** Env vars that are always removed from a provider child unless re-added explicitly. */
export const SENSITIVE_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "OPENAI_API_KEY",
  "CODEX_API_KEY",
  "XAI_API_KEY",
  "GROK_API_KEY",
  "YO_AGENTD_TOKEN",
  "AGENTD_TOKEN",
  "YO_TOKEN",
];

export type Env = Record<string, string>;

/**
 * Build a child env: process env minus sensitive keys, then `extra` (display env etc.),
 * then `overrides`. `undefined` values in overrides delete the key.
 */
export function buildChildEnv(
  extra: Record<string, string | undefined> = {},
  overrides: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): Env {
  const env: Env = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined) continue;
    if (SENSITIVE_ENV.includes(k)) continue;
    env[k] = v;
  }
  for (const layer of [extra, overrides]) {
    for (const [k, v] of Object.entries(layer)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

const TOKEN_PATTERNS: RegExp[] = [
  /sk-ant-[a-z0-9]{2,6}-[A-Za-z0-9_-]{8,}/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /xai-[A-Za-z0-9_-]{20,}/g,
];

/** Collect the literal secret values of an account so they can be scrubbed from any output. */
export function secretValues(secrets: AccountSecrets | undefined): string[] {
  if (!secrets) return [];
  const out = Object.values(secrets).filter((v): v is string => typeof v === "string" && v.length >= 8);
  // A seeded Codex login: also scrub the tokens inside it, not just the whole file.
  if (secrets.codexAuthJson) {
    try {
      const j = JSON.parse(secrets.codexAuthJson) as {
        tokens?: Record<string, unknown>;
        OPENAI_API_KEY?: unknown;
      };
      for (const v of [...Object.values(j.tokens ?? {}), j.OPENAI_API_KEY])
        if (typeof v === "string" && v.length >= 8) out.push(v);
    } catch {
      // Not JSON: the whole value is already listed.
    }
  }
  return out;
}

/** Replace known secret values and anything that looks like a provider key/token. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) {
    if (s && out.includes(s)) out = out.split(s).join("[redacted]");
  }
  for (const re of TOKEN_PATTERNS) out = out.replace(re, "[redacted]");
  return out;
}

/** Deep-redact any JSON-ish value (used on every emitted event). */
export function redactDeep<T>(value: T, secrets: string[] = []): T {
  if (typeof value === "string") return redact(value, secrets) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, secrets)) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Base64 images are large and never contain secrets; skip the regex work.
      out[k] = k === "image" ? v : redactDeep(v, secrets);
    }
    return out as T;
  }
  return value;
}
