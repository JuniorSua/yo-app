/** Splits plain text into text and web links, so a message the user typed can show its links as links. */
export type TextPart = { text: string; href?: string };

const URL = /https?:\/\/[^\s<>"']+/g;
/** Punctuation that usually ends the sentence, not the link: "see https://x.com." */
const TRAILING = /[.,;:!?)\]}]+$/;

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL)) {
    let url = m[0];
    const trail = TRAILING.exec(url)?.[0] ?? "";
    // Keep a closing bracket that belongs to the link, like Wikipedia's ".../Foo_(bar)".
    const keep = trail.startsWith(")") && url.includes("(") ? 1 : 0;
    url = url.slice(0, url.length - trail.length + keep);
    const start = m.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start) });
    parts.push({ text: url, href: url });
    last = start + url.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
