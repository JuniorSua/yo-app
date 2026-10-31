import { describe, expect, it } from "vitest";
import { ENABLED_PROVIDERS, isProviderEnabled, ProviderKind } from "./events";

describe("enabled providers", () => {
  it("offers Claude, ChatGPT (Codex) and Grok, Claude first", () => {
    expect(ENABLED_PROVIDERS).toEqual(["claude", "codex", "grok"]);
    expect(isProviderEnabled("claude")).toBe(true);
    expect(isProviderEnabled("codex")).toBe(true);
    expect(isProviderEnabled("grok")).toBe(true);
  });

  it("is false for unknown or missing values", () => {
    expect(isProviderEnabled("gemini")).toBe(false);
    expect(isProviderEnabled("")).toBe(false);
    expect(isProviderEnabled(null)).toBe(false);
    expect(isProviderEnabled(undefined)).toBe(false);
  });

  it("only lists known provider kinds", () => {
    for (const p of ENABLED_PROVIDERS) expect(ProviderKind.options).toContain(p);
  });
});
