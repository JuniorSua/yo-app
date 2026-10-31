/**
 * The life map: memories tagged with the area of the owner's life they belong to ("[area:work] Desk quotes go
 * out by Friday"). The tag is plain text at the start of the memory, so it shows, edits and syncs like any
 * memory, and needs no database change.
 */

const TAG = /^\s*\[area:([^\]]{1,40})\]\s*/i;

/** "Work Stuff!" -> "work-stuff": one spelling per area, so memories group together. */
export function normalizeArea(area: string): string {
  return area
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/** `{ area, text }` for a memory: `area` is null when it has no tag. */
export function parseArea(content: string): { area: string | null; text: string } {
  const m = TAG.exec(content);
  if (!m) return { area: null, text: content };
  const area = normalizeArea(m[1] ?? "");
  return area ? { area, text: content.slice(m[0].length) } : { area: null, text: content };
}

/** Put (or replace) the area tag on a memory's text. An empty area leaves the text untagged. */
export function tagArea(area: string | null | undefined, text: string): string {
  const clean = parseArea(text).text;
  const a = area ? normalizeArea(area) : "";
  return a ? `[area:${a}] ${clean}` : clean;
}

/** Yo writes this line (tagged with the area) when it suggests a permanent agent, so it doesn't ask again soon. */
export const SUGGESTION_PREFIX = "Suggested a permanent agent on ";
/** At most one suggestion per area in this many days. */
export const SUGGESTION_COOLDOWN_DAYS = 30;

/** Areas Yo suggested an agent for recently, with the date, from the memories. */
export function recentSuggestions(
  memories: { content: string }[],
  now: Date,
  days = SUGGESTION_COOLDOWN_DAYS,
): { area: string; date: string }[] {
  const out = new Map<string, string>();
  for (const m of memories) {
    const { area, text } = parseArea(m.content);
    if (!area || !text.startsWith(SUGGESTION_PREFIX)) continue;
    const date = /^\d{4}-\d{2}-\d{2}/.exec(text.slice(SUGGESTION_PREFIX.length))?.[0];
    if (!date) continue;
    const ageDays = (now.getTime() - new Date(`${date}T00:00:00Z`).getTime()) / 86_400_000;
    if (ageDays >= 0 && ageDays < days && (out.get(area) ?? "") < date) out.set(area, date);
  }
  return [...out].map(([area, date]) => ({ area, date }));
}
