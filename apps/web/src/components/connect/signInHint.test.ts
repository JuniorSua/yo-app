import type { ConnectDetection } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { claudeSignInHint, codexSignInHint, grokSignInHint } from "./signInHint";

const detect = (platform: string, name: string, installed = true): ConnectDetection => ({
  host: { platform, name },
  claude: { installed, signedIn: null },
  codex: { installed, signedIn: false },
});

const localMac = detect("darwin", "This Mac");
const homePc = detect("linux", "ProDesktop");

describe("claudeSignInHint", () => {
  it("never sends anyone to Terminal or asks for a token: Claude Code signs in on Yo's computer", () => {
    for (const d of [localMac, homePc, null]) {
      const hint = claudeSignInHint(d);
      expect(hint).toContain("nothing to install or type in Terminal");
      expect(hint).toContain("Claude's own page");
      expect(hint).not.toMatch(/token|setup-token/);
    }
  });

  it("names the PC Yo runs on when it isn't this Mac", () => {
    expect(claudeSignInHint(homePc)).toContain("a private workspace on ProDesktop");
    expect(claudeSignInHint(localMac)).not.toContain("This Mac");
  });
});

describe("codexSignInHint", () => {
  it("never sends anyone to Terminal: Codex signs in on Yo's computer, on ChatGPT's own page", () => {
    for (const d of [localMac, homePc, null]) {
      const hint = codexSignInHint(d);
      expect(hint).toContain("nothing to install or type in Terminal");
      expect(hint).toContain("ChatGPT's own page");
      expect(hint).not.toMatch(/CODEX_HOME|codex login|\.yo\/codex/);
    }
  });

  it("names the PC Yo runs on when it isn't this Mac", () => {
    expect(codexSignInHint(homePc)).toContain("a private workspace on ProDesktop");
    expect(codexSignInHint(localMac)).not.toContain("This Mac");
  });
});

describe("grokSignInHint", () => {
  it("never sends anyone to Terminal: Yo's computer signs in, any browser confirms", () => {
    for (const d of [localMac, homePc, null]) {
      const hint = grokSignInHint(d);
      expect(hint).toContain("nothing to install or type in Terminal");
      expect(hint).toContain("on this computer or your phone");
    }
  });

  it("names the PC Yo runs on when it isn't this Mac (the friend's case)", () => {
    expect(grokSignInHint(homePc)).toContain("a private workspace on ProDesktop");
    expect(grokSignInHint(localMac)).not.toContain("This Mac");
  });
});
