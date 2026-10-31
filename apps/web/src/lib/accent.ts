import { type AvatarLike, contrast, mix, softieOf, softiePalette } from "@yo/avatar";
import type { CSSProperties } from "react";

/**
 * Each agent's accent colour tints its own world (Dots-style): your bubbles to it, the send button, its computer
 * frame, its unread dot. Everything else stays neutral. Set the variables on a container with `accentVars` and use
 * `var(--accent)`, `var(--accent-ink)` (text on the accent), `var(--accent-soft)` (a light wash for chips and
 * delegated-work rows) and `var(--accent-text)` (the accent as readable text on the page background).
 *
 * The accent is the colour the agent's Softie wears, so older avatars (mapped to a Softie) agree with what's drawn.
 * Pass `{ primary: true }` for the main agent: an older Yo avatar is drawn as Yo, in Yo yellow.
 */
export function agentAccent(avatar: AvatarLike, opts: { primary?: boolean } = {}): string {
  return softieOf(avatar, opts).color;
}

/** Black or white, whichever reads better on `bg`. */
function inkOn(bg: string): string {
  return contrast("#111111", bg) >= contrast("#ffffff", bg) ? "#111111" : "#ffffff";
}

export function accentVars(
  avatar: AvatarLike,
  theme: "light" | "dark" = "light",
  opts: { primary?: boolean } = {},
): CSSProperties {
  const accent = agentAccent(avatar, opts);
  const page = theme === "dark" ? "#171717" : "#ffffff";
  // Readable text in the accent's hue: the Softie palette's ink (AA), deepened further if a page ever needs it.
  const ink = softiePalette(accent)[theme === "dark" ? "inkDark" : "ink"];
  let text = ink;
  for (let i = 1; i <= 10 && contrast(text, page) < 4.5; i++)
    text = mix(ink, theme === "dark" ? "#ffffff" : "#000000", i * 0.08);
  return {
    "--accent": accent,
    "--accent-ink": inkOn(accent),
    "--accent-soft": mix(accent, page, theme === "dark" ? 0.82 : 0.86),
    "--accent-text": text,
  } as CSSProperties;
}
