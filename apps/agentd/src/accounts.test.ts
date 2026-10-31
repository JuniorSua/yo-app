import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// config.ts reads the data dir when it's first imported: point it at a temp folder before that.
vi.hoisted(() => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  process.env.YO_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "yo-accounts-"));
});

const { AccountStore } = await import("./accounts");

describe("AccountStore", () => {
  it("drops a legacy Claude token once Claude Code has its own sign-in, keeping other secrets", () => {
    const store = new AccountStore();
    store.configure("acc_1", "claude", {
      claudeOauthToken: `sk-ant-oat01-${"FAKElegacy".repeat(3)}`,
      anthropicApiKey: `sk-ant-api03-${"FAKEkey".repeat(2)}`,
    });
    store.dropSecret("acc_1", "claudeOauthToken");
    expect(store.get("acc_1")!.secrets).toEqual({ anthropicApiKey: `sk-ant-api03-${"FAKEkey".repeat(2)}` });
    // Unknown accounts and missing keys are fine.
    store.dropSecret("acc_1", "claudeOauthToken");
    store.dropSecret("nope", "claudeOauthToken");
    expect(store.get("acc_1")!.configDir).toBe(join(process.env.YO_DATA_DIR!, "accounts", "claude", "acc_1"));
  });
});
