import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../sw.js", import.meta.url), "utf8");
const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8");

/** Runs the service worker in a sandbox and fires `activate` with these cache names; returns what it deleted. */
async function activate(names) {
  const handlers = {};
  const deleted = [];
  let waited;
  const self = {
    addEventListener: (type, fn) => {
      handlers[type] = fn;
    },
    clients: { claim: async () => {} },
    location: { origin: "https://phone.example" },
  };
  const caches = {
    keys: async () => names,
    delete: async (k) => {
      deleted.push(k);
      return true;
    },
  };
  runInNewContext(source, { self, caches, URL, fetch: async () => null });
  handlers.activate({ waitUntil: (p) => (waited = p) });
  await waited;
  return deleted;
}

describe("service worker", () => {
  it("on activation drops old shells but keeps the current one and the picture cache", async () => {
    const version = source.match(/const VERSION = "([^"]+)"/)[1];
    const deleted = await activate([
      `yo-phone-shell-${version}`,
      "yo-phone-shell-1.2.0",
      "yo-phone-pics",
      "someone-elses-cache",
    ]);
    expect(deleted).toEqual(["yo-phone-shell-1.2.0"]);
  });

  it("keeps the same picture cache name as the app", () => {
    const pics = appSource.match(/const PIC_CACHE = "([^"]+)"/)[1];
    expect(source).toContain(`"${pics}"`);
  });
});
