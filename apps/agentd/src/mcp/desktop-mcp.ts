/**
 * desktop-mcp: stdio MCP server for non-browser desktop control on the agent's display (DISPLAY=:N).
 * Uses xdotool for input and scrot for screenshots. Env: DISPLAY, YO_CDP_URL (optional), HOME, and on the
 * shared computer YO_SEAT_FILE: the agent's seat (a tile of the wide shared screen). Coordinates the agent
 * sees are seat-relative; screenshots show only the seat, and typing goes to a window in it.
 */
import { execFile, spawn } from "node:child_process";
import { promises as fsp, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const DISPLAY = process.env.DISPLAY ?? ":1";
const CDP_URL = process.env.YO_CDP_URL ?? "";
const SCREEN_W = 1280;
const SCREEN_H = 800;
const SEAT_FILE = process.env.YO_SEAT_FILE ?? "";

/** The agent's area of the screen: the whole display, or its seat on the shared computer (read each time). */
function seat(): { x: number; y: number } {
  if (!SEAT_FILE) return { x: 0, y: 0 };
  try {
    const s = JSON.parse(readFileSync(SEAT_FILE, "utf8")) as { x?: unknown; y?: unknown };
    return { x: Number(s.x) || 0, y: Number(s.y) || 0 };
  } catch {
    return { x: 0, y: 0 };
  }
}

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { env: { ...process.env, DISPLAY }, timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`${cmd} failed: ${stderr?.toString().trim() || err.message}`));
        else resolve(stdout.toString());
      },
    );
  });
}

const xdo = (...args: string[]) => run("xdotool", args);

/**
 * Starts a program in the background and returns its pid. A failed spawn (missing program) is an error the
 * agent sees, not an unhandled "error" event that would kill this server and every desktop tool with it.
 */
function spawnDetached(cmd: string, args: string[]): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, DISPLAY },
      cwd: process.env.HOME,
      detached: true,
      stdio: "ignore",
    });
    child.once("error", (err) => reject(new Error(`${cmd} failed to start: ${err.message}`)));
    child.once("spawn", () => {
      child.unref();
      resolve(child.pid);
    });
  });
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});
const num = (description: string) => ({ type: "number", description });

const TOOLS = [
  {
    name: "screenshot",
    description: `Capture the agent's whole desktop (${SCREEN_W}x${SCREEN_H}) as an image. Use to see non-browser apps; for web pages prefer the browser tools.`,
    inputSchema: obj({
      format: { type: "string", enum: ["jpeg", "png"], description: "Default jpeg (smaller)." },
    }),
  },
  {
    name: "click",
    description: "Click at screen coordinates (pixels).",
    inputSchema: obj(
      {
        x: num("X in pixels"),
        y: num("Y in pixels"),
        button: { type: "string", enum: ["left", "right", "middle"] },
        double: { type: "boolean" },
      },
      ["x", "y"],
    ),
  },
  {
    name: "type",
    description: "Type text into the focused window.",
    inputSchema: obj({ text: { type: "string" } }, ["text"]),
  },
  {
    name: "key",
    description:
      "Press key combinations (xdotool syntax), space-separated for sequences, e.g. 'ctrl+l', 'Return', 'ctrl+shift+t Tab'.",
    inputSchema: obj({ keys: { type: "string" } }, ["keys"]),
  },
  {
    name: "scroll",
    description: "Scroll at a position.",
    inputSchema: obj(
      {
        x: num("X"),
        y: num("Y"),
        direction: { type: "string", enum: ["up", "down", "left", "right"] },
        amount: num("Wheel clicks (default 3)"),
      },
      ["x", "y", "direction"],
    ),
  },
  {
    name: "move",
    description: "Move the mouse pointer.",
    inputSchema: obj({ x: num("X"), y: num("Y") }, ["x", "y"]),
  },
  {
    name: "drag",
    description: "Drag with the left button from one point to another.",
    inputSchema: obj({ fromX: num("start X"), fromY: num("start Y"), toX: num("end X"), toY: num("end Y") }, [
      "fromX",
      "fromY",
      "toX",
      "toY",
    ]),
  },
  {
    name: "launch_app",
    description:
      "Launch a desktop application or shell command in the background on the display, e.g. 'xterm'.",
    inputSchema: obj({ command: { type: "string" } }, ["command"]),
  },
  {
    name: "open_url",
    description: "Open a URL in a new tab of the agent's Chromium.",
    inputSchema: obj({ url: { type: "string" } }, ["url"]),
  },
];

const inX = (v: unknown) => Math.max(0, Math.min(SCREEN_W - 1, Math.round(Number(v) || 0)));
const inY = (v: unknown) => Math.max(0, Math.min(SCREEN_H - 1, Math.round(Number(v) || 0)));
/** Seat-relative (what the agent sees) -> screen coordinates for xdotool. */
const clampX = (v: unknown) => String(inX(v) + seat().x);
const clampY = (v: unknown) => String(inY(v) + seat().y);

/**
 * Keys go to the focused window, and on the shared computer that may be a teammate's: focus the topmost
 * window inside this seat first (no-op when the focus is already here).
 */
async function focusSeat() {
  if (!SEAT_FILE) return;
  const { x } = seat();
  const inSeat = async (id: string) => {
    const g = await xdo("getwindowgeometry", "--shell", id).catch(() => "");
    const wx = Number(/X=(-?\d+)/.exec(g)?.[1] ?? Number.NaN);
    const ww = Number(/WIDTH=(\d+)/.exec(g)?.[1] ?? 0);
    return wx >= x && wx < x + SCREEN_W && ww > 50;
  };
  const focused = (await xdo("getwindowfocus").catch(() => "")).trim();
  if (focused && (await inSeat(focused))) return;
  const ids = (await xdo("search", "--onlyvisible", "--name", ".").catch(() => ""))
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const id of ids.reverse()) {
    if (await inSeat(id)) {
      await xdo("windowactivate", "--sync", id).catch(() => undefined);
      return;
    }
  }
}

async function screenshot(format: "jpeg" | "png") {
  const file = path.join(
    os.tmpdir(),
    `yo-desktop-${process.pid}-${Date.now()}.${format === "png" ? "png" : "jpg"}`,
  );
  try {
    const { x, y } = seat();
    await run("scrot", [
      "--overwrite",
      "--pointer",
      "--silent",
      ...(SEAT_FILE ? ["-a", `${x},${y},${SCREEN_W},${SCREEN_H}`] : []),
      ...(format === "jpeg" ? ["--quality", "70"] : []),
      file,
    ]);
    const data = await fsp.readFile(file);
    return {
      content: [
        {
          type: "image" as const,
          data: data.toString("base64"),
          mimeType: format === "png" ? "image/png" : "image/jpeg",
        },
        { type: "text" as const, text: `Screen ${SCREEN_W}x${SCREEN_H}.` },
      ],
    };
  } finally {
    await fsp.rm(file, { force: true });
  }
}

async function openUrl(url: string): Promise<string> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    u = new URL(`https://${url}`);
  }
  if (!["http:", "https:", "about:", "file:"].includes(u.protocol))
    throw new Error(`unsupported URL scheme ${u.protocol}`);
  if (CDP_URL) {
    try {
      const res = await fetch(`${CDP_URL}/json/new?${encodeURIComponent(u.toString())}`, {
        method: "PUT",
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const target = (await res.json()) as { id?: string };
        if (target.id)
          await fetch(`${CDP_URL}/json/activate/${target.id}`, { signal: AbortSignal.timeout(3000) }).catch(
            () => undefined,
          );
        return `Opened ${u.toString()} in Chromium.`;
      }
    } catch {
      // fall through to xdg-open
    }
  }
  await spawnDetached("xdg-open", [u.toString()]);
  return `Opened ${u.toString()} with xdg-open.`;
}

async function callTool(
  name: string,
  a: Record<string, any>,
): Promise<{ content: any[]; isError?: boolean }> {
  const text = (t: string) => ({ content: [{ type: "text", text: t }] });
  switch (name) {
    case "screenshot":
      return screenshot(a.format === "png" ? "png" : "jpeg");
    case "click": {
      const btn = a.button === "right" ? "3" : a.button === "middle" ? "2" : "1";
      await xdo(
        "mousemove",
        "--sync",
        clampX(a.x),
        clampY(a.y),
        "click",
        ...(a.double ? ["--repeat", "2", "--delay", "80"] : []),
        btn,
      );
      return text(`Clicked ${a.button ?? "left"}${a.double ? " (double)" : ""} at ${inX(a.x)},${inY(a.y)}.`);
    }
    case "type": {
      const s = String(a.text ?? "");
      await focusSeat();
      // Chunk long text so xdotool doesn't choke.
      for (let i = 0; i < s.length; i += 200) {
        await run("xdotool", ["type", "--delay", "12", "--", s.slice(i, i + 200)], 120_000);
      }
      return text(`Typed ${s.length} characters.`);
    }
    case "key": {
      const keys = String(a.keys ?? "")
        .split(/\s+/)
        .filter(Boolean);
      if (keys.length === 0) throw new Error("keys is empty");
      await focusSeat();
      await xdo("key", "--delay", "40", "--", ...keys);
      return text(`Pressed ${keys.join(" ")}.`);
    }
    case "scroll": {
      const btn = { up: "4", down: "5", left: "6", right: "7" }[String(a.direction)] ?? "5";
      const n = String(Math.max(1, Math.min(50, Math.round(Number(a.amount) || 3))));
      await xdo(
        "mousemove",
        "--sync",
        clampX(a.x),
        clampY(a.y),
        "click",
        "--repeat",
        n,
        "--delay",
        "30",
        btn,
      );
      return text(`Scrolled ${a.direction} ${n} at ${inX(a.x)},${inY(a.y)}.`);
    }
    case "move":
      await xdo("mousemove", "--sync", clampX(a.x), clampY(a.y));
      return text(`Moved pointer to ${inX(a.x)},${inY(a.y)}.`);
    case "drag":
      await xdo("mousemove", "--sync", clampX(a.fromX), clampY(a.fromY), "mousedown", "1");
      await xdo("mousemove", "--sync", clampX(a.toX), clampY(a.toY));
      await xdo("mouseup", "1");
      return text(`Dragged from ${inX(a.fromX)},${inY(a.fromY)} to ${inX(a.toX)},${inY(a.toY)}.`);
    case "launch_app": {
      const command = String(a.command ?? "").trim();
      if (!command) throw new Error("command is empty");
      // New windows open under the pointer (the shared computer's openbox config): put it in this seat.
      if (SEAT_FILE)
        await xdo("mousemove", "--sync", clampX(SCREEN_W / 2), clampY(SCREEN_H / 2)).catch(() => "");
      const pid = await spawnDetached("bash", ["-lc", command]);
      return text(`Launched: ${command} (pid ${pid}).`);
    }
    case "open_url":
      return text(await openUrl(String(a.url ?? "")));
    default:
      return { isError: true, content: [{ type: "text", text: `Unknown tool: ${name}` }] };
  }
}

const server = new Server({ name: "desktop", version: "0.1.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS as never }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return (await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, any>)) as never;
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
    };
  }
});

await server.connect(new StdioServerTransport());
process.stderr.write(`[desktop-mcp] ready on ${DISPLAY}\n`);
