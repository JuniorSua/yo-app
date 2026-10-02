import { describe, expect, it } from "vitest";
import { ENABLED_PROVIDERS, isProviderEnabled, ProviderKind } from "./events";

describe("enabled providers", () => {
  it("offers Claude and ChatGPT (Codex) only, Claude first", () => {
    expect(ENABLED_PROVIDERS).toEqual(["claude", "codex"]);
    expect(isProviderEnabled("claude")).toBe(true);
    expect(isProviderEnabled("codex")).toBe(true);
  });

  it("keeps Grok a known provider kind, but never enabled", () => {
    expect(ProviderKind.safeParse("grok").success).toBe(true);
    expect(isProviderEnabled("grok")).toBe(false);
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
