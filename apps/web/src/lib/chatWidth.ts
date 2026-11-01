/**
 * The chat column beside the workspace (Dots): drag its edge to make it wider or narrower. The width is saved in
 * px; the CSS keeps clamping it to the window, so a smaller window never squeezes the workspace out.
 */

/** The narrowest the chat gets. */
export const CHAT_MIN = 360;
/** The widest it gets, as a share of the window. */
export const CHAT_MAX_SHARE = 0.6;
/** One arrow-key step; Shift moves further. */
export const CHAT_STEP = 16;
export const CHAT_STEP_BIG = 64;

/** The widest the chat can be in a window this wide. */
export const chatMax = (windowWidth: number) => Math.max(CHAT_MIN, Math.round(windowWidth * CHAT_MAX_SHARE));

/** A width kept within the bounds for this window. */
export const clampChat = (width: number, windowWidth: number) =>
  Math.round(Math.min(chatMax(windowWidth), Math.max(CHAT_MIN, width)));

/** The width with nothing saved, as the CSS works it out: clamp(400px, 38vw, 580px). */
export const defaultChatWidth = (windowWidth: number) =>
  Math.round(Math.min(580, Math.max(400, windowWidth * 0.38)));

/** The column's CSS width for a saved width, clamped by the window's size at any moment. */
export const chatWidthCss = (width: number) =>
  `clamp(${CHAT_MIN}px, ${Math.round(width)}px, ${CHAT_MAX_SHARE * 100}vw)`;

/**
 * The width after a key on the separator: arrows step it (Shift: further), Home and End go to the narrowest and
 * widest. Null for any other key.
 */
export function chatWidthAfterKey(
  key: string,
  shift: boolean,
  current: number,
  windowWidth: number,
): number | null {
  const step = shift ? CHAT_STEP_BIG : CHAT_STEP;
  switch (key) {
    case "ArrowLeft":
      return clampChat(current - step, windowWidth);
    case "ArrowRight":
      return clampChat(current + step, windowWidth);
    case "Home":
      return CHAT_MIN;
    case "End":
      return chatMax(windowWidth);
    default:
      return null;
  }
}
