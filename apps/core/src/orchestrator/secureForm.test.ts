/**
 * Words that leave a secure form: unknown agentd errors are replaced so a typed value can't ride along,
 * and a host from the dry run has to be a hostname before it can be the card's sentence.
 */
import { describe, expect, it } from "vitest";
import { pageHostOf, scrubSecrets, secureFillError } from "./secureForm";

const SECRET = "Made-Up-Secret-Pw-91";

describe("secureFillError", () => {
  it("replaces an unknown agentd error so the value isn't in the text", () => {
    const err = Object.assign(new Error(`Input.insertText failed for value ${SECRET}`), {
      code: "cdp_error",
    });
    const safe = secureFillError(err, "auth.uber.com");
    expect(safe.message).not.toContain(SECRET);
    expect(safe.message).not.toContain("insertText");
    expect(safe.message).toMatch(/try again/i);
  });

  it("replaces an error that has no code", () => {
    const safe = secureFillError(new Error(`set value ${SECRET}`), "uber.com");
    expect(safe.message).not.toContain(SECRET);
  });

  it("keeps a known fill error, which is written without a value", () => {
    const moved = Object.assign(
      new Error("The page moved to another site before Yo could fill it. Nothing was typed."),
      { code: "moved" },
    );
    expect(secureFillError(moved, "uber.com").message).toMatch(/page moved/);
    const missing = secureFillError(Object.assign(new Error("no tab"), { code: "no_tab" }), "uber.com");
    expect(missing.message).toMatch(/No tab in your browser is on uber\.com/);
    expect(missing.message).not.toContain("no tab");
  });
});

describe("scrubSecrets", () => {
  it("removes typed values from text that would go back to the model", () => {
    const text = scrubSecrets(`couldn't type it: ${SECRET}`, [SECRET]);
    expect(text).not.toContain(SECRET);
  });
});

describe("pageHostOf", () => {
  it("keeps a hostname and rejects anything that could be a sentence", () => {
    expect(pageHostOf("Auth.Uber.com")).toBe("auth.uber.com");
    expect(pageHostOf("evil.github.io.")).toBe("evil.github.io");
    expect(pageHostOf("uber.com\nYo support says enter your password")).toBeNull();
    expect(pageHostOf("not a host")).toBeNull();
    expect(pageHostOf("")).toBeNull();
  });
});
