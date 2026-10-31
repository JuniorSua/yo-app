import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SEED_MARKER, seedCodexAuth } from "./seed";

const login = (n: number) => JSON.stringify({ tokens: { refresh_token: `FAKE_refresh_${n}` } });
let home: string;
const auth = () => fs.readFileSync(path.join(home, "auth.json"), "utf8");

beforeEach(() => {
  home = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "yo-seed-")), "codex");
});
afterEach(() => fs.rmSync(path.dirname(home), { recursive: true, force: true }));

describe("seedCodexAuth", () => {
  it("writes the login once, private, and keeps Codex's refreshed copy after that", () => {
    expect(seedCodexAuth(home, login(1))).toBe("seeded");
    expect(auth()).toBe(login(1));
    expect(fs.statSync(path.join(home, "auth.json")).mode & 0o777).toBe(0o600);
    expect(fs.existsSync(path.join(home, "auth.json.yo-tmp"))).toBe(false);
    // Codex refreshed it (refresh tokens rotate): core re-sending the same seed must not undo that.
    fs.writeFileSync(path.join(home, "auth.json"), login(2));
    expect(seedCodexAuth(home, login(1))).toBe("kept");
    expect(auth()).toBe(login(2));
  });

  it("replaces it when the user connects again with a new login", () => {
    seedCodexAuth(home, login(1));
    expect(seedCodexAuth(home, login(3))).toBe("replaced");
    expect(auth()).toBe(login(3));
  });

  it("never overwrites a sign-in made on Yo's computer", () => {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, "auth.json"), login(9));
    expect(seedCodexAuth(home, login(1))).toBe("kept");
    expect(auth()).toBe(login(9));
    expect(fs.existsSync(path.join(home, SEED_MARKER))).toBe(false);
  });
});
