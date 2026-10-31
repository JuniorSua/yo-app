/**
 * Zip files the user attaches in the chat. Core only checks them (size, magic bytes) and reads the names in the
 * archive's central directory; it never decompresses anything. The archive is saved on the agent's computer
 * (agentd fs.write, ~/uploads) and the agent extracts it there, in its sandbox, if it needs the contents.
 */
import type { Attachment } from "@yo/contracts";

/** Same cap as any file saved on the agent's computer (agentd MAX_INCOMING_BYTES). */
export const MAX_ZIP_BYTES = 20 * 1024 * 1024;
/** Names shown to the model without a tool call. */
export const ZIP_LISTING_MAX = 50;
const NAME_MAX = 200;

const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
]);

/** By media type or by extension: browsers label zips differently (or not at all). */
export function isZipAttachment(a: Pick<Attachment, "name" | "mediaType">): boolean {
  return ZIP_TYPES.has(a.mediaType.toLowerCase()) || /\.zip$/i.test(a.name);
}

/** Decoded size of a base64 string without decoding it. */
export function base64Bytes(b64: string): number {
  const s = b64.replace(/\s/g, "");
  const pad = s.endsWith("==") ? 2 : s.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - pad);
}

/** `PK\x03\x04` (a local file header) or `PK\x05\x06` (the end record of an empty archive). */
export function hasZipMagic(buf: Buffer): boolean {
  if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) return false;
  return (buf[2] === 0x03 && buf[3] === 0x04) || (buf[2] === 0x05 && buf[3] === 0x06);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** What's wrong with an attached zip, in words for the user; null when it's fine. */
export function zipProblem(a: Attachment): string | null {
  const size = base64Bytes(a.data);
  if (size > MAX_ZIP_BYTES)
    return `"${a.name}" is ${formatBytes(size)}. Zip files can be up to ${formatBytes(MAX_ZIP_BYTES)}.`;
  const head = Buffer.from(a.data.slice(0, 8), "base64");
  if (!hasZipMagic(head)) return `"${a.name}" isn't a zip file Yo can read. Try zipping it again.`;
  return null;
}

export interface ZipListing {
  /** Entry count from the archive's end record. */
  total: number;
  /** Up to ZIP_LISTING_MAX names, control characters removed, each at most NAME_MAX characters. */
  names: string[];
  /** Sum of the listed entries' uncompressed sizes. */
  uncompressed: number;
  /** Some listed names are absolute or climb out with `..`. */
  unsafeNames: boolean;
}

const EOCD = 0x06054b50;
const CDH = 0x02014b50;

/**
 * Reads entry names from the central directory, bounds-checked at every step. Nothing is inflated. Returns
 * null when there is no readable directory (ZIP64, a damaged or truncated file).
 */
export function zipListing(buf: Buffer, max = ZIP_LISTING_MAX): ZipListing | null {
  if (buf.length < 22) return null;
  // The end record is the last 22 bytes plus a comment of up to 65535.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return null;
  const total = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) return null; // ZIP64
  if (cdOffset + cdSize > eocd) return null;
  const names: string[] = [];
  let uncompressed = 0;
  let unsafeNames = false;
  let p = cdOffset;
  for (let n = 0; n < total && names.length < max; n++) {
    if (p + 46 > eocd || buf.readUInt32LE(p) !== CDH) return null;
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const end = p + 46 + nameLen;
    if (end > eocd) return null;
    const raw = buf
      .subarray(p + 46, Math.min(end, p + 46 + NAME_MAX * 4))
      .toString("utf8")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
      .replace(/[\u0000-\u001f\u007f]/g, "?");
    const name = raw.length > NAME_MAX ? `${raw.slice(0, NAME_MAX)}…` : raw;
    if (/^([/\\]|[a-z]:)/i.test(raw) || /(^|[/\\])\.\.([/\\]|$)/.test(raw)) unsafeNames = true;
    names.push(name);
    uncompressed += size;
    p = end + extraLen + commentLen;
  }
  return { total, names, uncompressed, unsafeNames };
}

/** What the agent is told about a zip saved at `where` on its computer. */
export function zipNote(name: string, size: number, where: string, listing: ZipListing | null): string {
  const lines = [
    `(The user attached the zip file "${name}" (${formatBytes(size)}). It's saved on your computer at ${where} and isn't extracted.`,
    "If you need what's inside, extract it on your computer into a new folder next to it, never over existing files. Use Python's zipfile and skip any entry whose resolved path would land outside that folder (absolute paths, `..`, links). Check the total uncompressed size first.)",
  ];
  if (listing) {
    const more = listing.total > listing.names.length ? ` (first ${listing.names.length} shown)` : "";
    lines.push(
      `<zip contents name="${name}" entries="${listing.total}"${more}>`,
      ...listing.names,
      "</zip contents>",
    );
    if (listing.total === listing.names.length && listing.uncompressed > 0)
      lines.push(`Uncompressed, that's ${formatBytes(listing.uncompressed)} in total.`);
    if (listing.unsafeNames) lines.push("Careful: some entries have absolute paths or `..` in their names.");
  } else {
    lines.push("(Yo couldn't list what's inside without extracting it.)");
  }
  return lines.join("\n");
}

/** Small text the model reads inline (code, CSV, JSON...): it isn't saved as a file. */
export function isInlineText(a: Pick<Attachment, "mediaType" | "data">): boolean {
  // Exact types: Excel/Word (application/vnd.openxmlformats-…) contain "xml" in the name but are zip binaries.
  const t = a.mediaType.toLowerCase().split(";")[0]!.trim();
  const text =
    t.startsWith("text/") ||
    /^application\/(json|xml|csv|markdown|x-ndjson|x-yaml|yaml|javascript|x-sh)$/.test(t) ||
    /\+(json|xml)$/.test(t);
  return text && a.data.length < 400_000;
}

/**
 * Files the model can't read from the message itself (PDFs, spreadsheets, Word documents, archives, other
 * binaries) are saved on the agent's computer, so it can open them there (#139).
 */
export function isSavedAsFile(a: Pick<Attachment, "name" | "mediaType" | "data">): boolean {
  return isZipAttachment(a) || (!a.mediaType.startsWith("image/") && !isInlineText(a));
}
