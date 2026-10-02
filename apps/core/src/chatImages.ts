/**
 * Snapshots of the pictures an assistant message embeds (`![x](/path/on/agent/computer.png)`).
 *
 * Browsers reuse an already-loaded image for an identical URL within a page, whatever the cache headers
 * say, so a file the agent overwrites in place kept showing its old version. Each finished message now
 * points at content-addressed copies: a new version gets a new name, history keeps the picture it was
 * written with, and old pictures still show when the agent's computer is asleep.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const RASTER = /\.(png|jpe?g|gif|webp)$/i;
const MAX_IMAGES = 12;
const MAX_BYTES = 20 * 1024 * 1024;
export const CHAT_IMAGE_NAME = /^[0-9a-f]{64}\.(png|jpg|jpeg|gif|webp)$/;

/** Markdown image sources in `text` that refer to files on the agent's computer (same rules as the UI). */
export function computerImageSources(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g)) {
    const src = m[1]!;
    if (/^https?:\/\//i.test(src) || /^data:/i.test(src)) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(src) && !/^file:\/\//i.test(src)) continue;
    if (RASTER.test(toPath(src))) out.add(src);
    if (out.size >= MAX_IMAGES) break;
  }
  return [...out];
}

function toPath(src: string): string {
  let p = src;
  if (/^file:\/\//i.test(p)) p = decodeURI(p.replace(/^file:\/\//i, ""));
  return p.split(/[?#]/)[0]!;
}

/** Copy each picture once (by content hash). Returns markdown src -> stored name; unreadable ones are skipped. */
export async function snapshotChatImages(
  text: string,
  read: (filePath: string) => Promise<Buffer>,
  dataDir: string,
): Promise<Record<string, string>> {
  const sources = computerImageSources(text);
  if (!sources.length) return {};
  const dir = path.join(dataDir, "chat-images");
  fs.mkdirSync(dir, { recursive: true });
  const out: Record<string, string> = {};
  for (const src of sources) {
    try {
      const buf = await read(toPath(src));
      if (!buf.length || buf.length > MAX_BYTES) continue;
      const ext = path.extname(toPath(src)).slice(1).toLowerCase();
      const name = `${crypto.createHash("sha256").update(buf).digest("hex")}.${ext}`;
      const file = path.join(dir, name);
      if (!fs.existsSync(file)) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, buf);
        fs.renameSync(tmp, file);
      }
      out[src] = name;
    } catch {
      // Missing/unreadable file: the UI falls back to the live path for this one.
    }
  }
  return out;
}
