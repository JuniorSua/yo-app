import { describe, expect, it } from "vitest";
import { buildChildEnv, redact, redactDeep, secretValues } from "./env";
import { browserTitle, classifyMcp, parseToolName, yoTitle } from "./titles";
import { AsyncQueue, truncate } from "./util";

describe("titles", () => {
  it("parses MCP tool names", () => {
    expect(parseToolName("mcp__browser__browser_navigate")).toEqual({
      server: "browser",
      tool: "browser_navigate",
    });
    expect(parseToolName("mcp__my_server__do_it")).toEqual({ server: "my_server", tool: "do_it" });
    expect(parseToolName("Bash")).toEqual({ tool: "Bash" });
  });

  it("gives human browser titles", () => {
    expect(browserTitle("browser_navigate", { url: "https://www.amazon.com/dp/123" })).toBe(
      "Opened amazon.com",
    );
    expect(browserTitle("browser_click", { element: "Add to cart", ref: "e1" })).toBe(
      "Clicked 'Add to cart'",
    );
    expect(browserTitle("browser_type", { element: "search", text: "socks" })).toBe("Typed into search");
    expect(browserTitle("browser_press_key", { key: "Enter" })).toBe("Pressed Enter");
    expect(browserTitle("browser_take_screenshot", {})).toBe("Took a screenshot");
  });

  it("gives human Yo tool titles", () => {
    expect(yoTitle("remember", { fact: "x" })).toBe("Saved a memory");
    expect(yoTitle("schedule_task", { name: "Morning brief" })).toBe('Scheduled "Morning brief"');
    expect(classifyMcp("yo", "request_takeover", {})).toEqual({
      kind: "tool",
      title: "Asked you to take over",
    });
    expect(classifyMcp("browser", "browser_snapshot", {}).kind).toBe("browser");
  });
});

describe("env + redaction", () => {
  it("removes sensitive keys and applies overrides", () => {
    const env = buildChildEnv(
      { DISPLAY: ":3" },
      { CODEX_HOME: "/data/x", DROP: undefined },
      { PATH: "/bin", ANTHROPIC_API_KEY: "k", XAI_API_KEY: "k", YO_AGENTD_TOKEN: "t", DROP: "1" },
    );
    expect(env).toEqual({ PATH: "/bin", DISPLAY: ":3", CODEX_HOME: "/data/x" });
  });

  it("redacts known secrets and token-looking strings", () => {
    expect(redact("token sk-ant-oat01-abcdefghijklmnopqrstuvwxyz here")).toBe("token [redacted] here");
    expect(redact("my-secret-value!", ["my-secret-value"])).toBe("[redacted]!");
    expect(
      redactDeep({ a: ["xai-abcdefghijklmnopqrstuvwxyz0123"], image: "sk-ant-oat01-notscannedxxxxxxxxxx" }),
    ).toEqual({
      a: ["[redacted]"],
      image: "sk-ant-oat01-notscannedxxxxxxxxxx",
    });
  });
});

describe("seeded Codex login", () => {
  it("scrubs each token inside it, not just the whole file", () => {
    const codexAuthJson = JSON.stringify({
      tokens: { access_token: "FAKE_access_xyz", refresh_token: "FAKE_refresh_xyz" },
    });
    const secrets = secretValues({ codexAuthJson });
    expect(redact("refreshing FAKE_refresh_xyz with FAKE_access_xyz", secrets)).toBe(
      "refreshing [redacted] with [redacted]",
    );
    expect(secretValues({ codexAuthJson: "{not json" })).toEqual(["{not json"]);
  });
});

describe("util", () => {
  it("truncates long output", () => {
    const t = truncate("x".repeat(5000))!;
    expect(t.length).toBeLessThan(4200);
    expect(t).toContain("904 more characters");
  });

  it("AsyncQueue delivers pushed items and ends on close", async () => {
    const q = new AsyncQueue<number>();
    q.push(1);
    setTimeout(() => {
      q.push(2);
      q.close();
    }, 5);
    const got: number[] = [];
    for await (const n of q) got.push(n);
    expect(got).toEqual([1, 2]);
  });
});
