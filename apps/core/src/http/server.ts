import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { type Duplex, Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { AgentdPush, ApiMethod, ApiRequestFrame, AuthInfo, AuthMe } from "@yo/contracts";
import WebSocket, { WebSocketServer } from "ws";
import type { AgentdClient } from "../agentd/AgentdClient";
import {
  AuthError,
  type ControllerAuth,
  type Principal,
  readCookie,
  SESSION_COOKIE,
} from "../auth/ControllerAuth";
import { CHAT_IMAGE_NAME } from "../chatImages";
import type { CoreConfig } from "../config";
import type { Store } from "../db/store";
import type { DeviceHub } from "../devices/DeviceHub";
import type { Hub } from "../hub";
import { logger } from "../log";
import type { createApi } from "./api";
import { PeerDenyList } from "./denyPeers";
import { PtyEarlyOutput } from "./ptyEarly";
import type { ReleaseCheck } from "./releaseCheck";
import { serveDesktopUpdate, serverVersion } from "./updates";

const log = logger("http");

const INLINE_IMAGE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * A Page's rules: its own opaque origin (sandbox without allow-same-origin), inline code plus the chart CDN,
 * and no network calls, forms or plugins.
 */
export const PAGE_CSP = [
  "sandbox allow-scripts",
  "default-src 'none'",
  "script-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "style-src 'unsafe-inline' https://cdn.jsdelivr.net",
  "img-src data: blob:",
  "font-src data: https://cdn.jsdelivr.net",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
};

export interface ServerDeps {
  cfg: CoreConfig;
  hub: Hub;
  store: Store;
  agentd: AgentdClient;
  agentdToken: () => string;
  api: ReturnType<typeof createApi>;
  ptys: Map<string, { agentId: string }>;
  auth: ControllerAuth;
  devices: DeviceHub;
  coreId: string;
  /** PC edition: the newest release when it's newer than this core (for /api/version). */
  release?: ReleaseCheck;
}

const MAX_JSON_BODY = 64 * 1024;
/** UI sockets are pinged this often; one that misses a pong (a Mac that slept mid-tunnel) is dropped. */
const HEARTBEAT_MS = 30_000;
/** A UI socket this far behind is closed; the client reconnects and re-bootstraps instead of piling up. */
const SLOW_CLIENT_BYTES = 8 * 1024 * 1024;

/**
 * CSP for the UI. Scripts only from Yo itself (plus the inline theme script in index.html, by hash); pictures
 * may come from anywhere, as agents' Markdown can embed web images.
 */
function uiCsp(inlineScriptHashes: string[]) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval' ${inlineScriptHashes.map((h) => `'${h}'`).join(" ")}`.trim(),
    "style-src 'self' 'unsafe-inline'",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws: wss:",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

function inlineScriptHashes(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(
    (m) => `sha256-${crypto.createHash("sha256").update(m[1]!).digest("base64")}`,
  );
}

function isLoopback(req: http.IncomingMessage) {
  const a = req.socket.remoteAddress ?? "";
  return a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1";
}

function bearer(req: http.IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_JSON_BODY) throw new AuthError("request too large", 413);
    chunks.push(c as Buffer);
  }
  const v = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new AuthError("bad request", 400);
  return v as Record<string, unknown>;
}

export function createServer(d: ServerDeps) {
  const allowedOrigins = new Set([
    `http://127.0.0.1:${d.cfg.port}`,
    `http://localhost:${d.cfg.port}`,
    // Vite's dev server (YO_DEV only): a browser now holds a real session, and any page on that port would
    // otherwise get it (cookies aren't per port).
    ...(d.cfg.dev ? ["http://127.0.0.1:5173", "http://localhost:5173"] : []),
    ...d.cfg.allowedOrigins,
  ]);

  /**
   * PC edition: requests must name this machine (or an origin added in YO_ALLOWED_ORIGINS) in their Host header, so
   * a DNS-rebinding page on some other name can't even read core's public pages. Other editions keep their setups.
   */
  const allowedHosts = new Set([
    `127.0.0.1:${d.cfg.port}`,
    `localhost:${d.cfg.port}`,
    `[::1]:${d.cfg.port}`,
    ...d.cfg.allowedOrigins.flatMap((o) => {
      try {
        return [new URL(o).host];
      } catch {
        return [];
      }
    }),
  ]);
  const hostOk = (req: http.IncomingMessage) =>
    d.cfg.edition !== "pc" || allowedHosts.has(String(req.headers.host ?? "").toLowerCase());

  const originOk = (req: http.IncomingMessage) => {
    const origin = req.headers.origin;
    // Non-browser clients (Electron main, CLI tools) send no Origin. Browsers always do for WS.
    if (!origin || origin === "null") return !origin;
    return allowedOrigins.has(origin);
  };

  const agentdHttp = (p: string) => `${d.cfg.agentdUrl}${p}`;

  /**
   * Browsers get a cookie named for this port: cookies aren't per port, so two Yos on one PC (or Yo and another
   * local app) would otherwise overwrite each other's. The Mac app installs `yo_session` itself.
   */
  const browserCookie = `${SESSION_COOKIE}_${d.cfg.port}`;
  /** The caller's session token: bearer (the Mac app's main, yo-ops) or a session cookie (UI, browsers). */
  const sessionToken = (req: http.IncomingMessage) =>
    bearer(req) ??
    readCookie(req.headers.cookie, browserCookie) ??
    readCookie(req.headers.cookie, SESSION_COOKIE);
  /** Who is calling: a signed-in controller (cookie or bearer), or the dev principal in YO_DEV mode. */
  const principalOf = (req: http.IncomingMessage): Principal | null =>
    d.auth.principal(sessionToken(req), { loopback: isLoopback(req) });

  /** The browser's session cookie. HttpOnly so page script never holds it; Strict so no other site sends it. */
  const sessionCookie = (value: string, maxAgeSeconds: number) =>
    `${browserCookie}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${d.cfg.cookieSecure ? "; Secure" : ""}`;

  const sendJson = (res: http.ServerResponse, status: number, body: unknown) =>
    res
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(body));

  /**
   * Sign-in endpoints for the desktop app's main process and for browsers (contracts/browser.ts). Requests from a
   * foreign Origin are refused, and the session cookie is SameSite=Strict, so another site can't use them.
   */
  async function handleAuth(url: URL, req: http.IncomingMessage, res: http.ServerResponse) {
    if (req.headers.origin && !originOk(req)) return sendJson(res, 403, { error: "forbidden" });
    try {
      if (url.pathname === "/auth/info" && req.method === "GET")
        return sendJson(res, 200, {
          protocol: 1,
          // YO_DEV cores accept unauthenticated loopback clients (development only).
          authRequired: !d.cfg.dev,
          enrolled: d.auth.hasControllers(),
          coreId: d.coreId,
          browserSignIn: true,
          edition: d.cfg.edition,
          helperCommand: d.cfg.helperCommand,
        } satisfies AuthInfo);
      if (url.pathname === "/auth/me" && req.method === "GET") {
        const s = d.auth.sessionInfo(sessionToken(req));
        const me: AuthMe = s
          ? { signedIn: true, kind: "controller", controllerId: s.controllerId, expiresAt: s.expiresAt }
          : principalOf(req)?.kind === "dev"
            ? { signedIn: true, kind: "dev" }
            : { signedIn: false };
        return sendJson(res, 200, me);
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "method not allowed" });
      const body = await readJson(req);
      if (url.pathname === "/auth/enroll") return sendJson(res, 200, d.auth.enroll(body as any));
      if (url.pathname === "/auth/challenge") return sendJson(res, 200, d.auth.challenge());
      if (url.pathname === "/auth/session") {
        // A browser asks for a cookie. Browsers always send Origin on POST; requiring it keeps non-browser
        // callers on bearer tokens and means the cookie is only ever set for an allowed origin.
        if (body.cookie === true && !req.headers.origin)
          return sendJson(res, 403, { error: "browser sign-in needs an Origin" });
        const { token, expiresAt } = d.auth.createSession(body as any);
        if (body.cookie !== true) return sendJson(res, 200, { token, expiresAt });
        res.setHeader(
          "set-cookie",
          sessionCookie(token, Math.max(1, Math.floor((expiresAt - Date.now()) / 1000))),
        );
        return sendJson(res, 200, { ok: true, expiresAt });
      }
      if (url.pathname === "/auth/signout") {
        const ended = d.auth.endSession(sessionToken(req));
        // Every tab of this browser shares the cookie that just ended: disconnect them all.
        if (ended) closeSockets(ended.controllerId);
        res.setHeader("set-cookie", sessionCookie("", 0));
        return sendJson(res, 200, { ok: true });
      }
      // Pairing is finished by main with its controller session, after a native confirmation dialog.
      if (url.pathname === "/auth/pair-device") {
        const who = principalOf(req);
        if (who?.kind !== "controller") return sendJson(res, 401, { error: "sign in first" });
        return sendJson(res, 200, d.devices.finishPairing(body as any));
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err: any) {
      const status = err instanceof AuthError ? err.status : 400;
      return sendJson(res, status, { error: String(err?.message ?? err).slice(0, 200) });
    }
  }

  const denyList = new PeerDenyList(d.cfg.denyPeers);
  const ptyEarly = new PtyEarlyOutput();
  const onEarlyPush = (p: AgentdPush) => ptyEarly.onPush(p);
  d.agentd.on("push", onEarlyPush);

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://local");
      if (url.pathname === "/healthz") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      if (!hostOk(req)) {
        res.writeHead(421, { "content-type": "text/plain" }).end("unknown host");
        return;
      }
      if (url.pathname.startsWith("/auth/")) {
        await handleAuth(url, req, res);
        return;
      }
      if (url.pathname.startsWith("/api/")) {
        if (req.headers.origin && !originOk(req)) {
          res.writeHead(403).end("forbidden");
          return;
        }
        if (!principalOf(req)) {
          res.writeHead(401, { "content-type": "text/plain" }).end("sign in with the Yo app");
          return;
        }
        await handleApiHttp(url, req, res);
        return;
      }
      serveStatic(url.pathname, res);
    } catch (err: any) {
      log.warn(`http error ${req.url}`, err);
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end("internal error");
    }
  });

  async function proxyGet(p: string, res: http.ServerResponse, extraHeaders: Record<string, string> = {}) {
    const upstream = await fetch(agentdHttp(p), { headers: { Authorization: `Bearer ${d.agentdToken()}` } });
    if (!upstream.ok) {
      res.writeHead(upstream.status, { "content-type": "text/plain" }).end(await upstream.text());
      return;
    }
    // Streamed, so a big download from the agent's computer never sits in core's memory.
    const length = upstream.headers.get("content-length");
    res.writeHead(200, {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store",
      ...(length ? { "content-length": length } : {}),
      ...extraHeaders,
    });
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as any), res).catch((err) => {
      log.debug(`download stream ended early: ${err?.message ?? err}`);
      res.destroy();
    });
  }

  async function handleApiHttp(url: URL, _req: http.IncomingMessage, res: http.ServerResponse) {
    const parts = url.pathname.split("/").filter(Boolean); // ["api", kind, id]
    const kind = parts[1];
    const id = decodeURIComponent(parts[2] ?? "");
    if (kind === "version" && parts.length === 2) {
      sendJson(res, 200, serverVersion(d.cfg, d.release?.latest() ?? null));
      return;
    }
    if (kind === "updates" && id === "desktop" && parts.length === 4) {
      serveDesktopUpdate(d.cfg.dataDir, decodeURIComponent(parts[3]!), res);
      return;
    }
    if (kind === "screenshot" && id) {
      await proxyGet(`/screenshot/${encodeURIComponent(id)}`, res);
      return;
    }
    if (kind === "files" && id) {
      const p = url.searchParams.get("path") ?? "";
      const name = path.basename(p) || "file";
      // ?inline=1 lets chat show pictures from the agent's computer. Raster images only (never SVG/HTML).
      const image =
        url.searchParams.get("inline") === "1"
          ? INLINE_IMAGE_TYPES[path.extname(p).toLowerCase()]
          : undefined;
      await proxyGet(
        `/files/${encodeURIComponent(id)}?path=${encodeURIComponent(p)}`,
        res,
        image
          ? { "content-type": image, "content-disposition": "inline", "x-content-type-options": "nosniff" }
          : { "content-disposition": `attachment; filename="${name.replace(/"/g, "")}"` },
      );
      return;
    }
    if (kind === "chat-images" && id) {
      // Content-addressed snapshots: the name is the hash, so they never change and can be cached forever.
      if (!CHAT_IMAGE_NAME.test(id)) {
        res.writeHead(404).end("not found");
        return;
      }
      const file = path.join(d.cfg.dataDir, "chat-images", id);
      if (!fs.existsSync(file)) {
        res.writeHead(404).end("not found");
        return;
      }
      res.writeHead(200, {
        "content-type": INLINE_IMAGE_TYPES[path.extname(id)] ?? "application/octet-stream",
        "cache-control": "private, max-age=31536000, immutable",
        "content-disposition": "inline",
        "x-content-type-options": "nosniff",
      });
      fs.createReadStream(file).pipe(res);
      return;
    }
    if (kind === "artifacts" && id) {
      const art = d.store.artifactFile(id);
      if (!art || !fs.existsSync(art.storedPath)) {
        res.writeHead(404).end("not found");
        return;
      }
      if (url.searchParams.get("view") === "page" && art.kind === "page") {
        // A Page (create_page) opens in Yo's page viewer. The CSP sandbox gives it an opaque origin (no
        // cookies, storage or access to Yo), and it can load scripts and styles only from the one chart CDN.
        res.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-disposition": "inline",
          "x-content-type-options": "nosniff",
          "cache-control": "no-store",
          "content-security-policy": PAGE_CSP,
        });
        fs.createReadStream(art.storedPath).pipe(res);
        return;
      }
      // Agent-made files never run in Yo's own origin: only raster images display inline; everything
      // else downloads, and the sandbox CSP neutralizes active content even if it's opened directly.
      const inline =
        url.searchParams.get("inline") === "1" && Object.values(INLINE_IMAGE_TYPES).includes(art.mime);
      res.writeHead(200, {
        "content-type": art.mime,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${path.basename(art.storedPath).replace(/^\d+-/, "").replace(/"/g, "")}"`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      });
      fs.createReadStream(art.storedPath).pipe(res);
      return;
    }
    res.writeHead(404).end("not found");
  }

  function serveStatic(pathname: string, res: http.ServerResponse) {
    const root = d.cfg.webDist;
    if (!root || !fs.existsSync(root)) {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end(
          "<!doctype html><title>Yo</title><body style='font-family:system-ui;background:#0B0C0E;color:#ECECEE;padding:40px'>Yo core is running. The web UI hasn't been built yet (<code>pnpm --filter @yo/web build</code>).</body>",
        );
      return;
    }
    let file = path.normalize(path.join(root, decodeURIComponent(pathname)));
    const rel = path.relative(root, file);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, "index.html");
    const ext = path.extname(file);
    const headers: http.OutgoingHttpHeaders = {
      "content-type": STATIC_TYPES[ext] ?? "application/octet-stream",
      // The page and its manifest keep their names across releases; everything else is content-hashed.
      "cache-control":
        ext === ".html" || ext === ".webmanifest" ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    };
    if (ext === ".html") {
      const html = fs.readFileSync(file, "utf8");
      headers["content-security-policy"] = uiCsp(inlineScriptHashes(html));
      headers["referrer-policy"] = "no-referrer";
      res.writeHead(200, headers).end(html);
      return;
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  }

  /* ------------------------------ WebSockets ------------------------------ */

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 64 * 1024 * 1024,
    handleProtocols: (protocols) => (protocols.has("binary") ? "binary" : false),
  });

  server.on("upgrade", (req, socket, head) => {
    // An exception in an upgrade listener would take core down: answer anything unexpected with a plain 400.
    try {
      onUpgrade(req, socket, head);
    } catch (err: any) {
      log.warn(`bad upgrade request ${req.url}: ${err?.message ?? err}`);
      if (socket.writable) socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
    }
  });

  function onUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer) {
    const url = new URL(req.url ?? "/", "http://local");
    if (!originOk(req) || !hostOk(req)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    // Devices authenticate inside the socket with their own key (see DeviceHub); never with a UI session.
    if (url.pathname === "/device") {
      wss.handleUpgrade(req, socket, head, (ws) => d.devices.handleSocket(ws));
      return;
    }
    const who = principalOf(req);
    if (!who) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      keepAlive(ws);
      if (who.kind === "controller") track(who.controllerId, ws);
      if (url.pathname === "/ws") return onApiSocket(ws, url.searchParams.get("channels"));
      const m = url.pathname.match(/^\/api\/(vnc|pty)\/([^/]+)$/);
      if (m?.[1] === "vnc") return onVncSocket(ws, decodeURIComponent(m[2]!));
      if (m?.[1] === "pty") return onPtySocket(ws, decodeURIComponent(m[2]!));
      ws.close(4404, "not found");
    });
  }

  /** Open UI sockets per signed-in controller, so signing one out disconnects its windows at once. */
  const socketsByController = new Map<string, Set<WebSocket>>();
  function track(controllerId: string, ws: WebSocket) {
    const set = socketsByController.get(controllerId) ?? new Set<WebSocket>();
    socketsByController.set(controllerId, set);
    set.add(ws);
    ws.on("close", () => {
      set.delete(ws);
      if (!set.size && socketsByController.get(controllerId) === set)
        socketsByController.delete(controllerId);
    });
  }
  /** 4401 tells the UI it was signed out (not a network drop), so it goes to sign-in instead of reconnecting. */
  function closeSockets(controllerId: string) {
    // On the next tick, so a browser signing itself out still gets the answer to its own revoke call first.
    setImmediate(() => {
      for (const ws of socketsByController.get(controllerId) ?? []) ws.close(4401, "signed out");
    });
  }
  const offRevoke = d.auth.onRevoke(closeSockets);

  // YO_DENY_PEERS: drop the agent's computer before reading a byte (./denyPeers).
  server.on("connection", (socket) => {
    if (denyList.denies(socket.remoteAddress)) {
      log.debug(`dropped a connection from denied peer ${socket.remoteAddress}`);
      socket.destroy();
    }
  });

  /** UI sockets (/ws, live screen, terminal): ping, and drop the ones that stopped answering. */
  const alive = new WeakMap<WebSocket, boolean>();
  function keepAlive(ws: WebSocket) {
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
  }
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!alive.has(ws)) continue; // device sockets run their own heartbeat (DeviceHub)
      if (!alive.get(ws)) {
        ws.terminate();
        continue;
      }
      alive.set(ws, false);
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  /** `channels` (comma-separated) limits pushes to those channels, e.g. the desktop app's main process. */
  function onApiSocket(ws: WebSocket, channels: string | null) {
    const only = channels ? new Set(channels.split(",").filter(Boolean)) : null;
    const unsub = d.hub.subscribe((channel, _data, frame) => {
      if (ws.readyState !== WebSocket.OPEN || (only && !only.has(channel))) return;
      if (ws.bufferedAmount > SLOW_CLIENT_BYTES) {
        log.warn(`closing a UI socket that fell ${Math.round(ws.bufferedAmount / 1e6)} MB behind`);
        ws.terminate();
        return;
      }
      ws.send(frame());
    });
    ws.on("message", async (raw) => {
      let frame: ApiRequestFrame;
      try {
        frame = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const handler = (d.api as Record<string, (p: unknown) => Promise<unknown>>)[frame.method as ApiMethod];
      if (!handler) {
        ws.send(JSON.stringify({ id: frame.id, error: `Unknown method ${frame.method}` }));
        return;
      }
      try {
        const result = await handler(frame.params ?? {});
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: frame.id, result }));
      } catch (err: any) {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ id: frame.id, error: String(err?.message ?? err) }));
      }
    });
    ws.on("close", () => unsub());
  }

  function onVncSocket(client: WebSocket, agentId: string) {
    // A bare close() is code 1005 with no reason, so the live view can't tell the computer is off.
    const COMPUTER_OFF = "computer is not running";
    const endClient = (code: number, reason: string) => {
      if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    };
    if (!d.agentd.connected) {
      endClient(4404, COMPUTER_OFF);
      return;
    }
    const upstreamUrl = `${d.cfg.agentdUrl.replace(/^http/, "ws")}/vnc/${encodeURIComponent(agentId)}`;
    const upstream = new WebSocket(upstreamUrl, ["binary"], {
      headers: { Authorization: `Bearer ${d.agentdToken()}` },
    });
    const pending: Buffer[] = [];
    let upstreamOpen = false;
    let ended = false;
    const closeBoth = (code: number, reason: string) => {
      if (ended) return;
      ended = true;
      endClient(code, reason);
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
        upstream.terminate();
    };
    upstream.on("open", () => {
      upstreamOpen = true;
      for (const b of pending.splice(0)) upstream.send(b);
    });
    upstream.on("message", (data, isBinary) => {
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: isBinary || true });
    });
    client.on("message", (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      if (upstream.readyState === WebSocket.OPEN) upstream.send(buf);
      else if (!ended) pending.push(buf);
    });
    upstream.on("close", (code, reason) => {
      if (!upstreamOpen) closeBoth(4404, COMPUTER_OFF);
      else {
        // 1005/1006/1015 can't be sent onward. Anything else is the upstream's own close.
        const forward = code >= 1000 && code !== 1005 && code !== 1006 && code !== 1015 ? code : 1000;
        closeBoth(forward, reason.toString() || "closed");
      }
    });
    upstream.on("error", (err) => {
      log.debug(`vnc upstream error: ${err.message}`);
      if (!upstreamOpen) closeBoth(4404, COMPUTER_OFF);
      else closeBoth(1011, "screen disconnected");
    });
    client.on("close", () => {
      if (ended) return;
      ended = true;
      if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING)
        upstream.terminate();
    });
  }

  function onPtySocket(ws: WebSocket, ptyId: string) {
    if (!d.ptys.has(ptyId)) {
      ws.close(4404, "unknown pty");
      return;
    }
    // What the shell printed before this socket attached (its first prompt), then live output.
    const early = ptyEarly.attach(ptyId);
    if (early.output) ws.send(early.output);
    if (early.exited) {
      ws.close(1000, "exited");
      ptyEarly.detach(ptyId);
      d.ptys.delete(ptyId);
      return;
    }
    const onPush = (p: AgentdPush) => {
      if (p.type === "pty.data" && p.ptyId === ptyId && ws.readyState === WebSocket.OPEN) ws.send(p.data);
      if (p.type === "pty.exit" && p.ptyId === ptyId) ws.close(1000, "exited");
    };
    d.agentd.on("push", onPush);
    ws.on("message", (raw) => {
      const text = raw.toString();
      if (text.startsWith('{"type":"resize"')) {
        try {
          const m = JSON.parse(text) as { cols: number; rows: number };
          d.agentd.send("pty.resize", { ptyId, cols: m.cols, rows: m.rows });
          return;
        } catch {
          /* fall through as input */
        }
      }
      d.agentd.send("pty.input", { ptyId, data: text });
    });
    ws.on("close", () => {
      d.agentd.off("push", onPush);
      d.agentd.send("pty.close", { ptyId });
      d.ptys.delete(ptyId);
      ptyEarly.detach(ptyId);
    });
  }

  return {
    listen: async () => {
      await denyList.start();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(d.cfg.port, d.cfg.host, () => resolve());
      });
    },
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(heartbeat);
        denyList.stop();
        d.agentd.off("push", onEarlyPush);
        offRevoke();
        for (const client of wss.clients) client.terminate();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
    server,
  };
}
