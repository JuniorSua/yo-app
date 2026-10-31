import { describe, expect, it } from "vitest";
import {
  base64Bytes,
  hasZipMagic,
  isZipAttachment,
  MAX_ZIP_BYTES,
  ZIP_LISTING_MAX,
  zipListing,
  zipNote,
  zipProblem,
} from "../src/zipUploads";
import { makeZip } from "./zipFixture";

const att = (buf: Buffer, name = "project.zip", mediaType = "application/zip") => ({
  name,
  mediaType,
  data: buf.toString("base64"),
});

describe("zip uploads", () => {
  it("recognizes zips by media type or by extension", () => {
    expect(isZipAttachment({ name: "a.zip", mediaType: "application/zip" })).toBe(true);
    expect(isZipAttachment({ name: "a", mediaType: "application/x-zip-compressed" })).toBe(true);
    expect(isZipAttachment({ name: "Photos.ZIP", mediaType: "application/octet-stream" })).toBe(true);
    expect(isZipAttachment({ name: "Photos.zip", mediaType: "" })).toBe(true);
    expect(isZipAttachment({ name: "a.png", mediaType: "image/png" })).toBe(false);
    expect(isZipAttachment({ name: "notes.txt", mediaType: "text/plain" })).toBe(false);
  });

  it("checks the magic bytes, not the name", () => {
    expect(hasZipMagic(makeZip([{ name: "a.txt", data: "hi" }]))).toBe(true);
    expect(hasZipMagic(makeZip([]))).toBe(true); // an empty archive starts with its end record
    expect(hasZipMagic(Buffer.from("PK"))).toBe(false);
    expect(hasZipMagic(Buffer.from("%PDF-1.7"))).toBe(false);
    expect(zipProblem(att(makeZip([{ name: "a.txt" }])))).toBeNull();
    expect(zipProblem(att(makeZip([])))).toBeNull();
    expect(zipProblem(att(Buffer.from("just text, renamed")))).toMatch(/isn't a zip file/);
  });

  it("caps the size, measured without decoding", () => {
    for (const n of [0, 1, 2, 3, 4, 5, 1000, 1001])
      expect(base64Bytes(Buffer.alloc(n).toString("base64"))).toBe(n);
    const head = makeZip([]);
    const atCap = Buffer.concat([head, Buffer.alloc(MAX_ZIP_BYTES - head.length)]);
    expect(zipProblem(att(atCap))).toBeNull();
    const over = Buffer.concat([atCap, Buffer.alloc(1)]);
    expect(zipProblem(att(over, "big.zip"))).toBe('"big.zip" is 20.0 MB. Zip files can be up to 20.0 MB.');
  });

  it("lists names from the central directory", () => {
    const zip = makeZip([
      { name: "src/", data: "" },
      { name: "src/main.py", data: "print('hi')" },
      { name: "README.md", data: "# hi" },
    ]);
    expect(zipListing(zip)).toEqual({
      total: 3,
      names: ["src/", "src/main.py", "README.md"],
      uncompressed: 15,
      unsafeNames: false,
    });
    expect(zipListing(makeZip([]))).toEqual({ total: 0, names: [], uncompressed: 0, unsafeNames: false });
  });

  it("caps the listing, cleans long or odd names and flags paths that climb out", () => {
    const many = makeZip(Array.from({ length: 80 }, (_, i) => ({ name: `f${i}.txt` })));
    const l = zipListing(many)!;
    expect(l.total).toBe(80);
    expect(l.names).toHaveLength(ZIP_LISTING_MAX);
    expect(l.names.at(-1)).toBe("f49.txt");

    const odd = zipListing(makeZip([{ name: `${"x".repeat(5000)}.txt` }, { name: "bad\u0007name\n.txt" }]))!;
    expect(odd.names[0]).toHaveLength(201);
    expect(odd.names[0]!.endsWith("…")).toBe(true);
    expect(odd.names[1]).toBe("bad?name?.txt");
    expect(odd.unsafeNames).toBe(false);

    expect(zipListing(makeZip([{ name: "../../etc/passwd" }]))!.unsafeNames).toBe(true);
    expect(zipListing(makeZip([{ name: "/abs/file" }]))!.unsafeNames).toBe(true);
    expect(zipListing(makeZip([{ name: "a\\..\\..\\b" }]))!.unsafeNames).toBe(true);
    expect(zipListing(makeZip([{ name: "a..b/c" }]))!.unsafeNames).toBe(false);
  });

  it("gives up safely on damaged archives", () => {
    const zip = makeZip([{ name: "a.txt", data: "hello" }, { name: "b.txt" }]);
    expect(zipListing(Buffer.from("PK\u0003\u0004 nothing else"))).toBeNull();
    // Truncated: the end record is gone.
    expect(zipListing(zip.subarray(0, zip.length - 10))).toBeNull();
    // The end record points past itself.
    const bad = Buffer.from(zip);
    bad.writeUInt32LE(0xfffff, bad.length - 6);
    expect(zipListing(bad)).toBeNull();
    // A name length running past the directory.
    const long = Buffer.from(zip);
    const cd = long.readUInt32LE(long.length - 6);
    long.writeUInt16LE(0xffff, cd + 28);
    expect(zipListing(long)).toBeNull();
    // ZIP64 markers are not followed.
    const z64 = Buffer.from(zip);
    z64.writeUInt32LE(0xffffffff, z64.length - 6);
    expect(zipListing(z64)).toBeNull();
  });

  it("tells the agent where the zip is, to extract it safely itself, and what's inside", () => {
    const zip = makeZip([{ name: "a.txt", data: "hello" }]);
    const note = zipNote("x.zip", zip.length, "~/uploads/x.zip", zipListing(zip));
    expect(note).toContain('zip file "x.zip"');
    expect(note).toContain("saved on your computer at ~/uploads/x.zip and isn't extracted");
    expect(note).toContain("Python's zipfile");
    expect(note).toContain('<zip contents name="x.zip" entries="1">\na.txt\n</zip contents>');
    expect(note).toContain("Uncompressed, that's 5 B in total.");
    expect(zipNote("y.zip", 10, "~/uploads/y.zip", null)).toContain("couldn't list");
    const many = makeZip(Array.from({ length: 60 }, (_, i) => ({ name: `f${i}` })));
    expect(zipNote("m.zip", 1, "~/uploads/m.zip", zipListing(many))).toContain(
      'entries="60" (first 50 shown)',
    );
  });
});
