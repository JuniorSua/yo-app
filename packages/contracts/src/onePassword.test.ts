import { describe, expect, it } from "vitest";
import {
  fieldList,
  itemRef,
  OnePasswordFillInput,
  pageMatchesAny,
  pageMatchesSite,
  parseItemRef,
  siteHost,
} from "./onePassword";
import { toolAllowed, YO_TOOLS } from "./tools";

describe("1Password item refs", () => {
  it("round-trips vault and item ids, and refuses anything else", () => {
    const ref = itemRef("vlt123", "itm_456-x");
    expect(ref).toBe("1p:vlt123/itm_456-x");
    expect(parseItemRef(ref)).toEqual({ vaultId: "vlt123", itemId: "itm_456-x" });
    for (const bad of ["op://vault/item/password", "1p:vault", "1p:a/b/c", "1p:../x", "", "1p:a b/c"])
      expect(parseItemRef(bad)).toBeNull();
  });

  it("fill input: an item_ref is required, fields are the three kinds", () => {
    expect(OnePasswordFillInput.safeParse({}).success).toBe(false);
    expect(OnePasswordFillInput.safeParse({ item_ref: "1p:a/b", fields: ["pin"] }).success).toBe(false);
    expect(OnePasswordFillInput.parse({ item_ref: "1p:a/b", fields: ["one_time_code"] }).fields).toEqual([
      "one_time_code",
    ]);
  });

  it("says fields in plain words", () => {
    expect(fieldList(["username", "password"])).toBe("username and password");
    expect(fieldList(["username", "password", "one_time_code"])).toBe("username, password and one-time code");
    expect(fieldList(["one_time_code"])).toBe("one-time code");
  });
});

describe("which pages may get a login", () => {
  const anywhere = (url: string) => ({ url, mode: "anywhere" as const });

  it("fills on the saved site and its subdomains only", () => {
    expect(pageMatchesSite("https://github.com/login", anywhere("github.com"))).toBe(true);
    expect(pageMatchesSite("https://gist.github.com/", anywhere("https://github.com"))).toBe(true);
    expect(pageMatchesSite("https://www.amazon.com/ap/signin", anywhere("https://www.amazon.com"))).toBe(
      true,
    );
    // Look-alikes and other sites never match.
    expect(pageMatchesSite("https://evilgithub.com/login", anywhere("github.com"))).toBe(false);
    expect(pageMatchesSite("https://github.com.evil.example/login", anywhere("github.com"))).toBe(false);
    expect(pageMatchesSite("https://example.com/?next=github.com", anywhere("github.com"))).toBe(false);
  });

  it("wants https unless the login was saved for an http site", () => {
    expect(pageMatchesSite("http://github.com/login", anywhere("https://github.com"))).toBe(false);
    expect(pageMatchesSite("http://github.com/login", anywhere("github.com"))).toBe(false);
    expect(pageMatchesSite("http://router.lan/", anywhere("http://router.lan"))).toBe(true);
    expect(pageMatchesSite("file:///tmp/login.html", anywhere("github.com"))).toBe(false);
    expect(pageMatchesSite("not a url", anywhere("github.com"))).toBe(false);
  });

  it("exact: same host and port; never: no page", () => {
    const exact = { url: "https://accounts.example.com:8443", mode: "exact" as const };
    expect(pageMatchesSite("https://accounts.example.com:8443/in", exact)).toBe(true);
    expect(pageMatchesSite("https://accounts.example.com/in", exact)).toBe(false);
    expect(pageMatchesSite("https://x.accounts.example.com:8443/in", exact)).toBe(false);
    expect(pageMatchesSite("https://github.com", { url: "github.com", mode: "never" })).toBe(false);
  });

  it("refuses bare names that would match too much", () => {
    expect(pageMatchesSite("https://com/", anywhere("com"))).toBe(false);
    expect(pageMatchesAny("https://a.github.com", [anywhere(""), anywhere("github.com")])).toBe(true);
    expect(siteHost("https://www.Amazon.com/x")).toBe("amazon.com");
    expect(siteHost("ftp://example.com")).toBeNull();
  });

  it("refuses a public suffix, including private ones like github.io", () => {
    expect(pageMatchesSite("https://evil.github.io/login", anywhere("github.io"))).toBe(false);
    expect(pageMatchesSite("https://github.io/", anywhere("github.io"))).toBe(false);
    expect(pageMatchesSite("https://evil.github.io/", anywhere("https://www.github.io"))).toBe(false);
    expect(pageMatchesSite("https://other.vercel.app/", anywhere("vercel.app"))).toBe(false);
    expect(pageMatchesSite("https://evil.co.uk/", anywhere("co.uk"))).toBe(false);
    // A site registered under the suffix is one website, and its own subdomains still match.
    expect(pageMatchesSite("https://my-app.vercel.app/login", anywhere("my-app.vercel.app"))).toBe(true);
    expect(pageMatchesSite("https://foo.my-app.vercel.app/", anywhere("my-app.vercel.app"))).toBe(true);
    expect(pageMatchesSite("https://other.vercel.app/", anywhere("my-app.vercel.app"))).toBe(false);
    expect(pageMatchesSite("https://example.co.uk/", anywhere("example.co.uk"))).toBe(true);
    expect(pageMatchesSite("https://login.evil.github.io/", anywhere("evil.github.io"))).toBe(true);
    // Exact is one host, even when that host is a suffix.
    expect(pageMatchesSite("https://github.io/", { url: "https://github.io", mode: "exact" })).toBe(true);
    expect(pageMatchesSite("https://evil.github.io/", { url: "https://github.io", mode: "exact" })).toBe(
      false,
    );
  });
});

describe("1Password tools", () => {
  it("are offered to every agent and helper, and never take a secret as input", () => {
    for (const name of ["onepassword_search", "onepassword_fill"]) {
      const t = YO_TOOLS.find((x) => x.name === name)!;
      expect(t).toBeDefined();
      expect(toolAllowed("helper", name)).toBe(true);
      expect(Object.keys((t.inputSchema as { properties: object }).properties)).not.toContain("password");
    }
  });
});
