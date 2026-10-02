import { AVATAR_ACCESSORIES, AVATAR_EYES, AVATAR_SHAPES } from "@yo/contracts";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AGENT_TEMPLATES, Avatar, colorById, randomAvatar, YoLogo } from "./index";

describe("avatar", () => {
  it("renders every shape × eyes × accessory as SVG", () => {
    for (const shape of AVATAR_SHAPES)
      for (const eyes of AVATAR_EYES)
        for (const accessory of AVATAR_ACCESSORIES) {
          const html = renderToStaticMarkup(
            createElement(Avatar, { avatar: { shape, eyes, accessory, color: "cobalt" }, size: 40 }),
          );
          expect(html).toContain("<svg");
          expect(html).not.toContain("NaN");
        }
  });

  it("encodes the activity state as a class", () => {
    const html = renderToStaticMarkup(
      createElement(Avatar, { avatar: AGENT_TEMPLATES[0]!.avatar, state: "sleeping" }),
    );
    expect(html).toContain("yo-av--sleeping");
    expect(html).toContain(">z<");
  });

  it("resolves palette ids and raw hex colors", () => {
    expect(colorById("violet").hex).toBe("#8B5CF6");
    expect(colorById("#ffffff").eye).toBe("#111111");
    expect(colorById("nope").id).toBe("yo");
  });

  it("randomAvatar yields valid values and templates include the primary Yo", () => {
    const a = randomAvatar();
    expect(AVATAR_SHAPES).toContain(a.shape);
    expect(AGENT_TEMPLATES.find((t) => t.primary)?.avatar.color).toBe("yo");
    expect(renderToStaticMarkup(createElement(YoLogo, { size: 24 }))).toContain('aria-label="Yo"');
  });
});
