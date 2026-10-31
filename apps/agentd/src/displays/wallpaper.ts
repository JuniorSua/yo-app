/** Generates a soft vertical-gradient wallpaper (PPM) tinted by time of day. */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type RGB = [number, number, number];

/** [top, bottom] colors by hour. */
export function paletteForHour(h: number): [RGB, RGB] {
  if (h >= 5 && h < 9)
    return [
      [255, 196, 150],
      [120, 160, 220],
    ]; // dawn: peach -> sky
  if (h >= 9 && h < 16)
    return [
      [132, 190, 245],
      [226, 238, 250],
    ]; // day: blue -> haze
  if (h >= 16 && h < 20)
    return [
      [252, 160, 92],
      [104, 72, 160],
    ]; // dusk: orange -> violet
  return [
    [14, 18, 40],
    [48, 36, 92],
  ]; // night: navy -> indigo
}

export function renderPpm(width: number, height: number, top: RGB, bottom: RGB): Buffer {
  const header = Buffer.from(`P6\n${width} ${height}\n255\n`, "ascii");
  const body = Buffer.allocUnsafe(width * height * 3);
  const row = Buffer.allocUnsafe(width * 3);
  for (let y = 0; y < height; y++) {
    const t = y / Math.max(1, height - 1);
    const r = Math.round(top[0] + (bottom[0] - top[0]) * t);
    const g = Math.round(top[1] + (bottom[1] - top[1]) * t);
    const b = Math.round(top[2] + (bottom[2] - top[2]) * t);
    for (let x = 0; x < width; x++) {
      row[x * 3] = r;
      row[x * 3 + 1] = g;
      row[x * 3 + 2] = b;
    }
    row.copy(body, y * width * 3);
  }
  return Buffer.concat([header, body]);
}

/** Writes (or reuses) the wallpaper for the current hour bucket; returns its path. */
export function wallpaperFile(dir: string, width: number, height: number, date = new Date()): string {
  const [top, bottom] = paletteForHour(date.getHours());
  const name = `wallpaper-${top.join("-")}-${bottom.join("-")}-${width}x${height}.ppm`;
  const file = path.join(dir, name);
  mkdirSync(dir, { recursive: true });
  try {
    writeFileSync(file, renderPpm(width, height, top, bottom), { flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return file;
}
