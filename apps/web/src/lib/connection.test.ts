import { describe, expect, it } from "vitest";
import { connectionHelp, friendlyError, SLOW_CONNECT_MS, shortDuration } from "./connection";

describe("connection help", () => {
  it("stays a plain spinner line at first", () => {
    expect(connectionHelp(2000, true)).toEqual({ slow: false, title: "Connecting to Yo…", body: "" });
    expect(connectionHelp(2000, false).title).toBe("Reconnecting to Yo…");
  });

  it("explains how to recover once it takes a while", () => {
    const first = connectionHelp(SLOW_CONNECT_MS, true);
    expect(first.slow).toBe(true);
    expect(first.title).toBe("Yo is taking longer than usual to answer");
    expect(first.body).toMatch(/quit Yo and open it again/);
    expect(first.body).not.toMatch(/home PC/);
    expect(connectionHelp(95_000, false).title).toBe("Can't reach Yo · trying for 1 min");
  });

  it("never mentions a home PC to someone whose Yo runs on this Mac", () => {
    const mac = connectionHelp(SLOW_CONNECT_MS, false, "this-mac").body;
    expect(mac).toMatch(/quit Yo and open it again/);
    expect(mac).not.toMatch(/PC|another computer/);
  });

  it("points at the home PC only when Yo runs there", () => {
    expect(connectionHelp(SLOW_CONNECT_MS, false, "home-pc").body).toMatch(/home PC.*on and awake/);
    expect(connectionHelp(SLOW_CONNECT_MS, false, "custom-remote").body).toMatch(
      /another computer.*on and awake/,
    );
  });
});

describe("shortDuration", () => {
  it("is coarse past a minute", () => {
    expect(shortDuration(40_000)).toBe("40s");
    expect(shortDuration(3 * 60_000 + 20_000)).toBe("3 min");
    expect(shortDuration(65 * 60_000)).toBe("1 h 5 min");
    expect(shortDuration(2 * 3600_000)).toBe("2 h");
  });
});

describe("friendlyError", () => {
  it("turns the client's own timeout into a next step", () => {
    expect(friendlyError(new Error("chat.send timed out"))).toMatch(/didn't answer in time/);
  });

  it("keeps core's messages, which are written for people", () => {
    expect(friendlyError(new Error("No model connected"))).toBe("No model connected");
    expect(friendlyError(undefined)).toMatch(/Something went wrong/);
  });
});

describe("connectionHelp in a browser", () => {
  const slow = 60_000;
  it("PC edition on Windows: Docker Desktop and the Start menu, never 'quit Yo'", () => {
    const h = connectionHelp(slow, true, null, {
      browser: true,
      edition: "pc",
      helper: "yo-app",
      windows: true,
    });
    expect(h.body).toContain("Docker Desktop is running");
    expect(h.body).toContain("Start menu");
    expect(h.body).toContain("`yo-app status`");
    expect(h.body).not.toContain("quit Yo");
    expect(connectionHelp(slow, false, "this-pc", { browser: true, windows: true }).body).toContain(
      "Docker Desktop",
    );
  });
  it("PC edition on Linux: Docker and `yo-app start`, no Start menu", () => {
    const h = connectionHelp(slow, true, null, { browser: true, edition: "pc", helper: "yo-app" });
    expect(h.body).toContain("Make sure Docker is running");
    expect(h.body).toContain("`yo-app start`");
    expect(h.body).not.toContain("Start menu");
    expect(h.body).not.toContain("Docker Desktop");
  });
  it("any other browser: check the computer running Yo", () => {
    const h = connectionHelp(slow, true, "this-mac", { browser: true, edition: "mac" });
    expect(h.body).toContain("computer running Yo is on");
    expect(h.body).not.toContain("quit Yo");
  });
  it("the Mac app keeps its advice", () => {
    expect(connectionHelp(slow, true, "this-mac", { browser: false }).body).toContain(
      "quit Yo and open it again",
    );
  });
});
