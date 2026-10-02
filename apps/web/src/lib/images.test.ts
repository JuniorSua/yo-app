import { describe, expect, it } from "vitest";
import { chatImageSource } from "./images";

describe("chat images", () => {
  it("loads pictures from the agent's computer", () => {
    expect(chatImageSource("/data/home/agents/agt_1/desk/shot.png")).toEqual({
      kind: "computer",
      path: "/data/home/agents/agt_1/desk/shot.png",
    });
    expect(chatImageSource("~/desk/shot.JPG")).toEqual({ kind: "computer", path: "~/desk/shot.JPG" });
    expect(chatImageSource("file:///data/home/agents/agt_1/a%20b.webp")).toEqual({
      kind: "computer",
      path: "/data/home/agents/agt_1/a b.webp",
    });
  });

  it("passes web and data images through", () => {
    expect(chatImageSource("https://example.com/a.png")).toEqual({
      kind: "url",
      url: "https://example.com/a.png",
    });
    expect(chatImageSource("data:image/png;base64,AAAA")?.kind).toBe("url");
  });

  it("refuses non-images and other schemes", () => {
    expect(chatImageSource("javascript:alert(1)")).toBeNull();
    expect(chatImageSource("/data/home/agents/agt_1/page.svg")).toBeNull();
    expect(chatImageSource("data:image/svg+xml,<svg/>")).toBeNull();
    expect(chatImageSource("")).toBeNull();
  });
});
