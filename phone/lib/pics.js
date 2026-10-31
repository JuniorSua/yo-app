// Pictures and the send queue for Yo Phone (docs/phone/PROTOCOL.md, "v2.1"). Plain ESM, no DOM, so it's unit
// tested in phone/test/pics.test.js.
//
// A reply that embeds pictures arrives first (with `pics`: how many follow), then one `images` message points at
// encrypted blobs on the relay. The app fetches each blob, checks its hash and shows it in place of the markdown
// image it replaces (`src`), or under the reply.

import { BLOB_ID_RE } from "./crypto.js";

export const PIC_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
/** Longest a reply waits for its pictures before saying they're in Yo. */
export const PICS_WAIT_MS = 3 * 60 * 1000;
/** A message waiting for a connection is resent only while the core would still run it (it refuses 10+ min). */
export const QUEUE_FOR_MS = 9 * 60 * 1000;
const HASH_RE = /^[A-Za-z0-9_-]{43}$/;
const MAX_ITEMS = 8;
const MAX_BYTES = 1_000_000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, Math.round(n)));

/**
 * The picture references of an `images` message that this app will try to show. Anything malformed is dropped.
 * @returns {Array<{ id: string, hash: string, mime: string, w: number, h: number, size: number, src?: string, alt?: string }>}
 */
export function cleanPicRefs(items) {
  if (!Array.isArray(items)) return [];
  const out = [];
  for (const i of items) {
    if (out.length >= MAX_ITEMS) break;
    if (!i || typeof i !== "object") continue;
    if (typeof i.id !== "string" || !BLOB_ID_RE.test(i.id)) continue;
    if (typeof i.hash !== "string" || !HASH_RE.test(i.hash)) continue;
    if (!PIC_TYPES.includes(i.mime)) continue;
    if (!Number.isFinite(i.size) || i.size <= 0 || i.size > MAX_BYTES) continue;
    out.push({
      id: i.id,
      hash: i.hash,
      mime: i.mime,
      w: Number.isFinite(i.w) ? clamp(i.w, 1, 8192) : 1,
      h: Number.isFinite(i.h) ? clamp(i.h, 1, 8192) : 1,
      size: i.size,
      ...(typeof i.src === "string" && i.src ? { src: i.src.slice(0, 2000) } : {}),
      ...(typeof i.alt === "string" && i.alt ? { alt: i.alt.slice(0, 200) } : {}),
    });
  }
  return out;
}

/**
 * Puts an `images` message's pictures on the reply it belongs to. Returns false if that reply isn't here (yet).
 * @param {Array<any>} messages
 * @param {{ replyId?: unknown, items?: unknown, more?: unknown }} msg
 */
export function attachImages(messages, msg) {
  const m = messages.find((x) => x.k === "yo" && x.id === msg?.replyId);
  if (!m) return false;
  m.images = cleanPicRefs(msg.items);
  const more = Number(msg.more);
  m.more = Number.isFinite(more) ? clamp(more, 0, 99) : 0;
  m.picsDone = true;
  return true;
}

/** Whether a reply is still waiting for its pictures (show placeholders, not "in Yo"). */
export function waitingForPics(m, now = Date.now()) {
  return m?.k === "yo" && m.pics > 0 && !m.picsDone && now - m.at < PICS_WAIT_MS;
}

/** The picture that replaces this markdown source in a reply, if one arrived. */
export function picForSrc(m, src) {
  return m?.images?.find((p) => p.src === src) ?? null;
}

/** Pictures of a reply that don't replace an image in its text: shown under it. */
export function loosePics(m, inlineSrcs) {
  const used = new Set(inlineSrcs);
  return (m?.images ?? []).filter((p) => !p.src || !used.has(p.src));
}

/** "2 more pictures in Yo" */
export function moreLabel(n) {
  return n === 1 ? "1 more picture in Yo" : `${n} more pictures in Yo`;
}

/** "2 helpers working" (empty when none). */
export function helpersLabel(n) {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n === 1 ? "1 helper working" : `${n} helpers working`;
}

/** Messages that went out while offline and can still be sent (the core runs a message for 10 minutes). */
export function resendable(messages, now = Date.now()) {
  return messages.filter((m) => m.k === "me" && m.st === "queued" && now - m.at < QUEUE_FOR_MS);
}

/** Queued messages that waited too long: they become "Not sent" with Retry. */
export function expireQueued(messages, now = Date.now()) {
  let changed = false;
  for (const m of messages) {
    if (m.k === "me" && m.st === "queued" && now - m.at >= QUEUE_FOR_MS) {
      m.st = "failed";
      m.err = "Not sent";
      changed = true;
    }
  }
  return changed;
}
