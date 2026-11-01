import { describe, expect, it } from "vitest";
import { CHAT_MIN, chatMax, chatWidthAfterKey, chatWidthCss, clampChat, defaultChatWidth } from "./chatWidth";

describe("the chat column's width", () => {
  it("stays between 360px and 60% of the window", () => {
    expect(chatMax(1440)).toBe(864);
    expect(chatMax(1100)).toBe(660);
    expect(clampChat(200, 1440)).toBe(CHAT_MIN);
    expect(clampChat(2000, 1440)).toBe(864);
    expect(clampChat(512.4, 1440)).toBe(512);
    // A tiny window still allows the narrowest chat.
    expect(chatMax(400)).toBe(CHAT_MIN);
  });

  it("defaults to the CSS's clamp(400px, 48vw, 700px)", () => {
    expect(defaultChatWidth(1440)).toBe(691);
    expect(defaultChatWidth(1100)).toBe(528);
    expect(defaultChatWidth(1920)).toBe(700);
  });

  it("is still clamped by the window in CSS", () => {
    expect(chatWidthCss(700.6)).toBe("clamp(360px, 701px, 60vw)");
  });

  it("moves with the arrow keys, Home and End", () => {
    expect(chatWidthAfterKey("ArrowRight", false, 500, 1440)).toBe(516);
    expect(chatWidthAfterKey("ArrowLeft", false, 500, 1440)).toBe(484);
    expect(chatWidthAfterKey("ArrowLeft", true, 500, 1440)).toBe(436);
    expect(chatWidthAfterKey("ArrowLeft", false, 365, 1440)).toBe(CHAT_MIN);
    expect(chatWidthAfterKey("ArrowRight", true, 850, 1440)).toBe(864);
    expect(chatWidthAfterKey("Home", false, 500, 1440)).toBe(CHAT_MIN);
    expect(chatWidthAfterKey("End", false, 500, 1100)).toBe(660);
    expect(chatWidthAfterKey("a", false, 500, 1440)).toBeNull();
  });
});
