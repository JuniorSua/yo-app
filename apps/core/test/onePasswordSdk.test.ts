/**
 * The SDK backend's mapping, against a stand-in for @1password/sdk (the real one needs a 1Password account):
 * logins only, websites with their autofill rule, and which fields count as username, password and code.
 * Every value here is made up.
 */
import { describe, expect, it, vi } from "vitest";

const created: unknown[] = [];

vi.mock("@1password/sdk", () => {
  const ItemCategory = { Login: "Login", Password: "Password", SecureNote: "SecureNote" };
  const ItemFieldType = { Text: "Text", Email: "Email", Concealed: "Concealed", Totp: "Totp" };
  const items: Record<string, any> = {
    login: {
      id: "login",
      title: "GitHub",
      websites: [
        { url: "https://github.com", autofillBehavior: "AnywhereOnWebsite" },
        { url: "https://gist.github.com", autofillBehavior: "ExactDomain" },
      ],
      fields: [
        { id: "username", title: "username", fieldType: "Text", value: "fake-user" },
        { id: "password", title: "password", fieldType: "Concealed", value: "fake-pass" },
        {
          id: "x1",
          title: "one-time password",
          fieldType: "Totp",
          value: "otpauth://totp/x",
          details: { type: "Otp", content: { code: "123456" } },
        },
      ],
    },
    other: {
      id: "other",
      title: "Router",
      websites: [{ url: "http://router.lan", autofillBehavior: "Never" }],
      fields: [
        { id: "a", title: "Email", fieldType: "Email", value: "fake@example.com" },
        { id: "b", title: "Admin password", fieldType: "Concealed", value: "fake-admin" },
      ],
    },
  };
  return {
    ItemCategory,
    ItemFieldType,
    createClient: async (config: { auth: string; integrationName: string }) => {
      created.push(config);
      if (config.auth === "ops_bad") {
        const e = new Error("token revoked");
        Object.defineProperty(e, "constructor", { value: { name: "AuthExpiredError" } });
        throw e;
      }
      return {
        vaults: { list: async () => [{ id: "v1", title: "Yo", activeItemCount: 3 }] },
        items: {
          list: async (vaultId: string) => [
            { id: "login", title: "GitHub", category: "Login", vaultId, websites: items.login.websites },
            { id: "note", title: "Notes", category: "SecureNote", vaultId, websites: [] },
            { id: "other", title: "Router", category: "Password", vaultId, websites: items.other.websites },
          ],
          get: async (_v: string, id: string) => items[id],
        },
      };
    },
  };
});

const { sdkBackend } = await import("../src/onepassword/sdkBackend");

describe("1Password SDK backend", () => {
  it("lists vaults and only Login/Password items, with their websites' autofill rules", async () => {
    const b = await sdkBackend("ops_good");
    expect(created.at(-1)).toMatchObject({ auth: "ops_good", integrationName: "Yo" });
    expect(await b.vaults()).toEqual([{ id: "v1", title: "Yo", items: 3 }]);
    expect(await b.logins("v1")).toEqual([
      {
        vaultId: "v1",
        itemId: "login",
        title: "GitHub",
        hasCode: null,
        sites: [
          { url: "https://github.com", mode: "anywhere" },
          { url: "https://gist.github.com", mode: "exact" },
        ],
      },
      {
        vaultId: "v1",
        itemId: "other",
        title: "Router",
        hasCode: null,
        sites: [{ url: "http://router.lan", mode: "never" }],
      },
    ]);
  });

  it("reads username, password and the current one-time code", async () => {
    const b = await sdkBackend("ops_good");
    expect(await b.login("v1", "login")).toEqual({
      title: "GitHub",
      sites: [
        { url: "https://github.com", mode: "anywhere" },
        { url: "https://gist.github.com", mode: "exact" },
      ],
      username: "fake-user",
      password: "fake-pass",
      oneTimeCode: "123456",
    });
    // Not a built-in Login: the closest fields by type and title.
    expect(await b.login("v1", "other")).toMatchObject({
      username: "fake@example.com",
      password: "fake-admin",
    });
  });

  it("a refused token is a plain bad_token error", async () => {
    await expect(sdkBackend("ops_bad")).rejects.toMatchObject({ code: "bad_token" });
  });
});
