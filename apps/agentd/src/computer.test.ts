import { describe, expect, it } from "vitest";
import { BROWSER_TOOL_TIMEOUT_MS, DESKTOP_TOOL_TIMEOUT_MS, getMcpServers, initComputer } from "./computer";
import type { DisplayManager } from "./displays/DisplayManager";

describe("getMcpServers", () => {
  it("bounds every browser tool call, run-code included (#114); Yo's tools keep the long default", () => {
    initComputer({
      displayNumber: () => 3,
      place: () => ({ display: 3 }),
      sharedComputer: false,
    } as unknown as DisplayManager);
    const servers = getMcpServers("agt_1", "ses_1");
    const browser = servers.find((s) => s.name === "browser")!;
    expect(BROWSER_TOOL_TIMEOUT_MS).toBe(120_000);
    expect(browser.toolTimeoutMs).toBe(BROWSER_TOOL_TIMEOUT_MS);
    // Real @playwright/mcp 0.0.83 flags: clicks/typing and page loads have their own, shorter limits.
    expect(browser.args.join(" ")).toContain("--timeout-action 5000 --timeout-navigation 60000");
    expect(servers.find((s) => s.name === "yo")!.toolTimeoutMs).toBeUndefined();
  });

  it("bounds every server except Yo's own (which waits on the user), the desktop included", () => {
    initComputer({
      displayNumber: () => 3,
      place: () => ({ display: 3 }),
      sharedComputer: false,
    } as unknown as DisplayManager);
    const servers = getMcpServers("agt_1", "ses_1");
    for (const s of servers.filter((x) => x.name !== "yo")) {
      expect(s.toolTimeoutMs, s.name).toBeGreaterThan(0);
      expect(s.toolTimeoutMs, s.name).toBeLessThanOrEqual(10 * 60_000);
    }
    expect(servers.find((s) => s.name === "desktop")!.toolTimeoutMs).toBe(DESKTOP_TOOL_TIMEOUT_MS);
  });

  it("passes the session's tool set to yo-mcp (a helper gets fewer tools); none from an older core", () => {
    initComputer({
      displayNumber: () => 3,
      place: () => ({ display: 3 }),
      sharedComputer: false,
    } as unknown as DisplayManager);
    const yo = (toolset?: string) => getMcpServers("agt_1", "ses_1", toolset).find((s) => s.name === "yo")!;
    expect(yo("helper").env?.YO_TOOLSET).toBe("helper");
    expect(yo().env).not.toHaveProperty("YO_TOOLSET");
  });
});
