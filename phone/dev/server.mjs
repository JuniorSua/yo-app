// Local dev server for Yo Phone: serves phone/ statically and mounts the relay with the in-memory store at
// /api/relay. Applies the same headers as vercel.json so CSP problems show up locally.
//   node phone/dev/server.mjs            (PORT defaults to 5199)

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRelay } from "../api/relay.js";
import { createMemoryStore } from "../lib/memoryStore.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const port = Number(process.env.PORT ?? 5199);
// The register key is the HMAC key for admission (X-Yo-Admit) and the core credential (X-Yo-Core), and mailboxes
// must be registered before they accept writes. Locally it defaults to a fixed dev value that dev/fake-core.mjs
// also uses; set YO_PHONE_REGISTER_KEY to override both.
export const DEV_REGISTER_KEY = "yo-dev-register-key";
const relay = createRelay(createMemoryStore(), {
  registerKey: process.env.YO_PHONE_REGISTER_KEY || DEV_REGISTER_KEY,
  // dev/shots.mjs drives the phone (and the fake core, from the same address) faster than a person would.
  ...(process.env.YO_PHONE_DEV_FAST ? { ipPerMinute: 1000, phonePerMinute: 300, corePerMinute: 300 } : {}),
});
const vercel = JSON.parse(await readFile(join(root, "vercel.json"), "utf8"));

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const PRIVATE = new Set(["dev", "test", "api", "core", "node_modules"]);

function headersFor(pathname) {
  const out = {};
  for (const rule of vercel.headers ?? []) {
    const re = new RegExp(`^${rule.source.replace(/\(\.\*\)/g, "(.*)").replace(/\./g, "\\.")}$`);
    if (re.test(pathname)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

async function toWebRequest(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${req.headers.host ?? "localhost"}${req.url}`, {
    method: req.method,
    headers: Object.entries(req.headers).flatMap(([k, v]) =>
      Array.isArray(v) ? v.map((x) => [k, x]) : [[k, v]],
    ),
    body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
  });
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/api/relay" || url.pathname.startsWith("/api/relay/")) {
      const response = await relay(await toWebRequest(req));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith("/")) rel += "index.html";
    const file = normalize(join(root, rel));
    const top = rel.split("/").filter(Boolean)[0];
    if (!file.startsWith(root.endsWith(sep) ? root : root + sep) || PRIVATE.has(top)) {
      res.writeHead(404).end("Not found");
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-cache",
      ...headersFor(url.pathname),
    });
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    res.writeHead(500).end("Server error");
  }
});

server.listen(port, () => {
  console.log(`Yo Phone dev server on http://localhost:${port} (relay: in-memory store, register key set)`);
});
