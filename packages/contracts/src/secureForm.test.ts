import { describe, expect, it } from "vitest";
import {
  cleanSecureValues,
  isSpecificSite,
  PendingRequest,
  RequestSecureInputInput,
  type SecureField,
  secureFieldList,
  secureFillKinds,
  secureFormAskLine,
  secureFormFailedHint,
  secureFormPasswordCaution,
  secureFormTitle,
  YO_TOOLS,
} from "./index";

const code: SecureField = { kind: "one_time_code", label: "Code from the text" };
const email: SecureField = { kind: "email", label: "Email" };
const pw: SecureField = { kind: "password", label: "Password" };

describe("request_secure_input", () => {
  it("is offered with the same kinds the input schema takes", () => {
    const def = YO_TOOLS.find((t) => t.name === "request_secure_input")!;
    expect(def.description).toMatch(/instead of asking in chat/);
    expect(def.description).toMatch(/never see the values/);
    const props = def.inputSchema.properties as Record<string, any>;
    expect(props.fields.items.properties.kind.enum).toEqual([
      "one_time_code",
      "password",
      "username",
      "email",
      "phone",
      "text",
    ]);
    expect(def.inputSchema.required).toEqual(["site", "reason", "fields"]);
  });

  it("parses the agent's call and refuses empty or oversized forms", () => {
    expect(RequestSecureInputInput.parse({ site: " uber.com ", reason: "A code", fields: [code] })).toEqual({
      site: "uber.com",
      reason: "A code",
      fields: [code],
    });
    expect(RequestSecureInputInput.safeParse({ site: "uber.com", fields: [] }).success).toBe(false);
    expect(
      RequestSecureInputInput.safeParse({ site: "uber.com", fields: [code, pw, email, code] }).success,
    ).toBe(false);
    expect(
      RequestSecureInputInput.safeParse({ site: "uber.com", fields: [{ kind: "pin", label: "PIN" }] })
        .success,
    ).toBe(false);
    expect(
      RequestSecureInputInput.safeParse({ site: "uber.com", fields: [{ kind: "text", label: " " }] }).success,
    ).toBe(false);
  });

  it("maps fields onto the sign-in page's boxes, one of each", () => {
    expect(secureFillKinds([email, pw, code])).toEqual({ kinds: ["username", "password", "one_time_code"] });
    expect(secureFillKinds([{ kind: "phone", label: "Phone" }])).toEqual({ kinds: ["username"] });
    expect(secureFillKinds([email, { kind: "text", label: "Member ID" }])).toMatchObject({
      error: expect.stringMatching(/one name field/),
    });
    expect(secureFillKinds([code, code])).toMatchObject({
      error: expect.stringMatching(/one one-time code/),
    });
  });

  it("checks the typed values without ever quoting them", () => {
    expect(cleanSecureValues([code, pw], ["482 913", " pass word "])).toEqual({
      values: ["482913", " pass word "],
    });
    expect(cleanSecureValues([email], ["  me@example.com "])).toEqual({ values: ["me@example.com"] });
    for (const bad of [undefined, [], ["1", "2"], [42], ["   "]]) {
      const r = cleanSecureValues([code], bad);
      expect(r).toHaveProperty("error");
    }
    const long = cleanSecureValues([pw], ["x".repeat(600)]);
    expect(long).toEqual({ error: '"Password" is too long.' });
  });

  it("names fields in plain words", () => {
    expect(secureFieldList([code])).toBe("one-time code");
    expect(secureFieldList([email, pw, { kind: "text", label: "Member ID" }])).toBe(
      'email, password and "Member ID"',
    );
  });

  it("the card's title and ask line use the real host, never an agent-written label", () => {
    const phishing = { kind: "text" as const, label: "GitHub password — account locked" };
    expect(secureFormTitle([phishing], "login.evil.github.io")).toBe("Text for login.evil.github.io");
    expect(secureFormTitle([email, pw], "auth.uber.com")).toBe("Email and password for auth.uber.com");
    expect(secureFormAskLine("Yo", "auth.uber.com")).toBe(
      "Yo is asking you to type this into the page on auth.uber.com.",
    );
    expect(secureFormAskLine("Yo", "auth.uber.com")).not.toContain("GitHub");
    expect(secureFormPasswordCaution("online.bank.example")).toContain("online.bank.example");
    expect(secureFormPasswordCaution("online.bank.example")).toMatch(/password/i);
    expect(secureFormFailedHint("Yo")).toMatch(/try again/i);
    expect(isSpecificSite("uber.com")).toBe(true);
    expect(isSpecificSite("auth.uber.com")).toBe(true);
    expect(isSpecificSite("evil.github.io")).toBe(true);
    expect(isSpecificSite("my-app.vercel.app")).toBe(true);
    expect(isSpecificSite("github.io")).toBe(false);
    expect(isSpecificSite("vercel.app")).toBe(false);
    expect(isSpecificSite("co.uk")).toBe(false);
    expect(isSpecificSite("com")).toBe(false);
    expect(isSpecificSite("uber")).toBe(false);
    expect(isSpecificSite("localhost")).toBe(true);
    expect(isSpecificSite("router.lan")).toBe(true);
  });

  it("travels on a pending request without any value", () => {
    const r = PendingRequest.parse({
      requestId: "r1",
      kind: "user_input",
      title: "One-time code for uber.com",
      secureForm: { site: "uber.com", reason: "A code", fields: [code] },
    });
    expect(r.secureForm?.fields).toEqual([code]);
  });
});
