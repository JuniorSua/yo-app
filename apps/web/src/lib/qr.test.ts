import qrcode from "qrcode-generator";
import { describe, expect, it } from "vitest";
import { QUIET_ZONE, qrModules, qrSvg } from "./qr";

const LINK = `https://yo-phone.vercel.app/#k=${"A".repeat(43)}&a=${"b".repeat(43)}&p=${"C-_".repeat(14)}x`;

/** Error correction level from the format bits next to the bottom-left finder (spec: L=01, M=00, Q=11, H=10). */
function ecLevel(grid: boolean[][]): string {
  const n = grid.length;
  const bits = ((grid[n - 1]![8] ? 2 : 0) | (grid[n - 2]![8] ? 1 : 0)) ^ 0b10; // undo the format mask
  return ["M", "L", "H", "Q"][bits]!;
}

/** Fill a grid back in from the SVG path, to check the path draws exactly the dark modules. */
function fromPath(path: string, size: number): boolean[][] {
  const out = Array.from({ length: size }, () => Array<boolean>(size).fill(false));
  for (const m of path.matchAll(/M(\d+) (\d+)h(\d+)v1h-(\d+)z/g)) {
    const [x, y, w, back] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])];
    expect(back).toBe(w);
    for (let i = 0; i < w; i++) out[y]![x + i] = true;
  }
  return out;
}

describe("qr", () => {
  it("reads the error correction level from the format bits", () => {
    for (const level of ["L", "M", "Q", "H"] as const) {
      const qr = qrcode(0, level);
      qr.addData("hello", "Byte");
      qr.make();
      const n = qr.getModuleCount();
      const grid = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
      expect(ecLevel(grid)).toBe(level);
    }
  });

  it("encodes a phone link with medium error correction", () => {
    const grid = qrModules(LINK);
    expect(LINK).toHaveLength(166);
    expect(grid).toHaveLength(53); // version 9: the smallest that holds 166 bytes at level M
    expect(ecLevel(grid)).toBe("M");
  });

  it("has the three finder patterns", () => {
    const grid = qrModules(LINK);
    const n = grid.length;
    const finder = (r0: number, c0: number) =>
      Array.from({ length: 7 }, (_, r) =>
        Array.from({ length: 7 }, (_, c) => (grid[r0 + r]![c0 + c] ? "#" : ".")).join(""),
      );
    const expected = ["#######", "#.....#", "#.###.#", "#.###.#", "#.###.#", "#.....#", "#######"];
    expect(finder(0, 0)).toEqual(expected);
    expect(finder(0, n - 7)).toEqual(expected);
    expect(finder(n - 7, 0)).toEqual(expected);
  });

  it("draws exactly the dark modules, inside a 4-module quiet zone", () => {
    const grid = qrModules(LINK);
    const { size, path } = qrSvg(LINK);
    expect(QUIET_ZONE).toBe(4);
    expect(size).toBe(grid.length + 8);
    const drawn = fromPath(path, size);
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const inside = y >= 4 && y < size - 4 && x >= 4 && x < size - 4;
        expect(drawn[y]![x]).toBe(inside ? grid[y - 4]![x - 4] : false);
      }
  });

  it("is the same for the same link and different for another", () => {
    expect(qrSvg(LINK)).toEqual(qrSvg(LINK));
    expect(qrSvg(LINK).path).not.toBe(qrSvg(LINK.replace("k=A", "k=B")).path);
  });
});
