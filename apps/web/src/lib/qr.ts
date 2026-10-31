/**
 * QR codes made on this computer (no network): Settings → Phone shows the phone link as one, so the owner can
 * scan it with the Yo app or the iPhone Camera. Uses `qrcode-generator` (MIT, no dependencies) for the
 * encoding and draws it as one SVG path.
 */
import qrcode from "qrcode-generator";

/** Blank modules around the code. The QR spec asks for 4; scanners struggle with less. */
export const QUIET_ZONE = 4;

export interface QrSvg {
  /** Width and height in modules, quiet zone included. */
  size: number;
  /** The dark modules as an SVG path in module units, already offset by the quiet zone. */
  path: string;
}

/** The module grid for `text`: medium error correction (15%), byte mode, smallest version that fits. */
export function qrModules(text: string): boolean[][] {
  const qr = qrcode(0, "M");
  qr.addData(text, "Byte");
  qr.make();
  const n = qr.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
}

/** `text` as an SVG path. Each run of dark modules in a row is one rectangle, which keeps the path short. */
export function qrSvg(text: string): QrSvg {
  const grid = qrModules(text);
  const n = grid.length;
  let path = "";
  for (let r = 0; r < n; r++) {
    const row = grid[r]!;
    for (let c = 0; c < n; c++) {
      if (!row[c]) continue;
      let end = c;
      while (end + 1 < n && row[end + 1]) end++;
      const w = end - c + 1;
      path += `M${c + QUIET_ZONE} ${r + QUIET_ZONE}h${w}v1h-${w}z`;
      c = end;
    }
  }
  return { size: n + QUIET_ZONE * 2, path };
}
