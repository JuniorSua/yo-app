import "@xterm/xterm/css/xterm.css";
import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { Spinner } from "../ui/controls";

/**
 * xterm.js terminal bound to a pty on the agent's computer.
 * Flow: `pty.open {agentId, cols, rows}` -> ptyId, then WS `/api/pty/:ptyId` (see WsClient.openPty for
 * the frame protocol, incl. the `{"type":"resize",cols,rows}` control message).
 */
export function TerminalView({ agentId }: { agentId: string }) {
  const el = useRef<HTMLDivElement>(null);
  const [status, setStatus] = useState<"opening" | "open" | "exited" | "error">("opening");

  useEffect(() => {
    if (!el.current) return;
    const term = new Terminal({
      fontFamily: '"Geist Mono Variable", ui-monospace, Menlo, monospace',
      fontSize: 12.5,
      lineHeight: 1.35,
      cursorBlink: true,
      cursorStyle: "bar",
      allowTransparency: true,
      theme: {
        background: "#00000000",
        foreground: "#e4e4e7",
        cursor: "#FFD43B",
        cursorAccent: "#141518",
        selectionBackground: "#3b82f655",
        black: "#18181b",
        brightBlack: "#52525b",
        red: "#ef4444",
        green: "#4ecb71",
        yellow: "#ffd43b",
        blue: "#60a5fa",
        magenta: "#c084fc",
        cyan: "#22d3ee",
        white: "#e4e4e7",
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el.current);
    try {
      fit.fit();
    } catch {
      /* not visible yet */
    }

    let disposed = false;
    let conn: ReturnType<ReturnType<typeof api>["openPty"]> | null = null;
    const subs: (() => void)[] = [];
    api()
      .call("pty.open", { agentId, cols: term.cols, rows: term.rows })
      .then(({ ptyId }) => {
        if (disposed) return;
        conn = api().openPty(ptyId);
        subs.push(conn.onData((d) => term.write(d)));
        subs.push(conn.onExit(() => setStatus("exited")));
        const input = term.onData((d) => conn?.send(d));
        subs.push(() => input.dispose());
        setStatus("open");
        term.focus();
      })
      .catch(() => setStatus("error"));

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        conn?.resize(term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(el.current);

    return () => {
      disposed = true;
      ro.disconnect();
      for (const s of subs) s();
      conn?.close();
      term.dispose();
    };
  }, [agentId]);

  return (
    <div className="absolute inset-0" data-testid="terminal">
      <div ref={el} className="h-full w-full" />
      {status !== "open" && (
        <div className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
          <span className="flex items-center gap-2 rounded-full bg-black/50 px-3 py-1 text-[#a1a1a7] text-xs">
            {status === "opening" && <Spinner />}
            {status === "opening"
              ? "Opening terminal…"
              : status === "exited"
                ? "Session ended"
                : "Couldn't open a terminal"}
          </span>
        </div>
      )}
    </div>
  );
}
