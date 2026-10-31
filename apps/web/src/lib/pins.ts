import type { Artifact } from "@yo/contracts";

/** Make: pinned ones first (newest pin on top), then the rest in the order core lists them (newest first). */
export function sortPinnedFirst(list: Artifact[]): Artifact[] {
  const pinned = list.filter((a) => a.pinnedAt).sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0));
  return [...pinned, ...list.filter((a) => !a.pinnedAt)];
}
