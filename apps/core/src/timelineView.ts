import type { TimelineEntry } from "@yo/contracts";

/**
 * What the UI gets for a timeline entry. Tool-result screenshots (item.image, base64) are kept in the
 * database for the model's history but never shown by the UI; sending them cost the Mac several MB of
 * memory per open conversation (and tunnel traffic), so they stay on the server.
 */
export function forUi(e: TimelineEntry): TimelineEntry {
  if (!e.item.image) return e;
  const { image: _image, ...item } = e.item;
  return { ...e, item };
}
