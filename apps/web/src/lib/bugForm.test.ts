import { describe, expect, it } from "vitest";
import { bugFormUrl } from "./bugForm";

describe("bugFormUrl", () => {
  it("opens the bug form with the version filled in", () => {
    const url = new URL(bugFormUrl("JuniorSua/yo-app", "0.1.313")!);
    expect(url.origin + url.pathname).toBe("https://github.com/JuniorSua/yo-app/issues/new");
    expect(url.searchParams.get("template")).toBe("bug_report.yml");
    expect(url.searchParams.get("version")).toBe("0.1.313");
  });

  it("leaves the version out when it isn't known", () => {
    expect(bugFormUrl("JuniorSua/yo-app", null)).toBe(
      "https://github.com/JuniorSua/yo-app/issues/new?template=bug_report.yml",
    );
    expect(bugFormUrl("JuniorSua/yo-app", "  ")).not.toContain("version=");
  });

  it("refuses anything that isn't owner/name", () => {
    for (const bad of ["", "yo-app", "JuniorSua/yo-app/issues", "evil.com/x?y", "a/b c"])
      expect(bugFormUrl(bad, "1")).toBeNull();
  });
});
