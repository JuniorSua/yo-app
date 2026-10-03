import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { coreHealthy, coreTroubleHtml, coreTroubleText, portInUse } from "./coreCheck";

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

async function serve(handler: http.RequestListener) {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  return (s.address() as AddressInfo).port;
}

/** A port nothing listens on (bound, then released). */
async function freePort() {
  const port = await serve(() => {});
  await new Promise((r) => servers.pop()!.close(r));
  return port;
}

describe("is Yo's core answering?", () => {
  it("yes when /healthz says ok", async () => {
    const port = await serve((_req, res) => res.end("ok"));
    expect(await coreHealthy(`http://127.0.0.1:${port}`)).toBe(true);
  });

  it("no when another app answers every path with its own page", async () => {
    const port = await serve((_req, res) => res.end("<!doctype html><title>Some dev server</title>"));
    expect(await coreHealthy(`http://127.0.0.1:${port}`)).toBe(false);
    expect(await portInUse(port)).toBe(true);
  });

  it("no, and the port is free, when nothing is listening (core crashed or is restarting)", async () => {
    const port = await freePort();
    expect(await coreHealthy(`http://127.0.0.1:${port}`)).toBe(false);
    expect(await portInUse(port)).toBe(false);
  });
});

describe("what the window says while core isn't answering", () => {
  const logFile = "/Users/me/Library/Application Support/Yo/logs/core.log";

  it("names the port when another app holds it", () => {
    const t = coreTroubleText({ portTaken: true, port: 7777, logFile });
    expect(t.title).toBe("Another app is using port 7777");
    expect(t.body).toMatch(/Quit the other app/);
  });

  it("otherwise says Yo keeps trying and where the details are", () => {
    const t = coreTroubleText({ portTaken: false, port: 7777, logFile });
    expect(t.body).toContain(logFile);
    expect(t.body).toMatch(/keeps trying/);
  });

  it("is a page with the log path escaped (it holds the user's folder name)", () => {
    const html = coreTroubleHtml({
      portTaken: false,
      port: 7777,
      logFile: "/tmp/a<b>/core.log",
      dark: true,
    });
    expect(html).toContain("Yo is taking longer than usual to start");
    expect(html).toContain("/tmp/a&lt;b&gt;/core.log");
    expect(html).not.toContain("<b>/core.log");
  });
});
