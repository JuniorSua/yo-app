import type RFB from "@novnc/novnc";
import type { AgentView } from "@yo/contracts";
import { Moon, Power, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { AgentAvatar } from "../brand";
import { Button } from "../ui/button";
import { Spinner } from "../ui/controls";
import { MockDesktop } from "./MockDesktop";
import { COMPUTER_OFF_MESSAGE, vncClosedBecauseOff } from "./screenOff";

type VncState = "connecting" | "connected" | "disconnected" | "off";

function computerDown(runtime: string | undefined): boolean {
  return !!runtime && runtime !== "running" && runtime !== "starting";
}

/** Live noVNC view of an agent's display. View-only unless `interactive` (user has control). */
function VncScreen({ agentId, interactive }: { agentId: string; interactive: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const runtime = useApp((s) => s.computer?.runtime);
  const down = computerDown(runtime);
  const [state, setState] = useState<VncState>(down ? "off" : "connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (down) {
      setState("off");
      return;
    }
    let cancelled = false;
    let retry: number | undefined;
    let sawOff = false;
    setState("connecting");
    import("@novnc/novnc").then(({ default: RFBClass }) => {
      if (cancelled || !el.current) return;
      // Our close listener is registered first, so it runs before noVNC turns the close into "disconnect".
      const ws = new WebSocket(api().vncUrl(agentId), ["binary"]);
      ws.addEventListener("close", (ev) => {
        if (vncClosedBecauseOff(ev.code, ev.reason)) sawOff = true;
      });
      const rfb = new RFBClass(el.current, ws, { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "transparent";
      rfb.qualityLevel = 7;
      rfb.viewOnly = !interactive;
      rfb.focusOnClick = interactive;
      rfb.addEventListener("connect", () => setState("connected"));
      rfb.addEventListener("disconnect", () => {
        if (cancelled) return;
        if (sawOff) {
          setState("off");
          return;
        }
        setState("disconnected");
        retry = window.setTimeout(() => setAttempt((a) => a + 1), 2500);
      });
      rfbRef.current = rfb;
    });
    return () => {
      cancelled = true;
      clearTimeout(retry);
      try {
        rfbRef.current?.disconnect();
      } catch {
        /* already closed */
      }
      rfbRef.current = null;
    };
  }, [agentId, attempt, down]);

  useEffect(() => {
    const rfb = rfbRef.current;
    if (!rfb) return;
    rfb.viewOnly = !interactive;
    rfb.focusOnClick = interactive;
    if (interactive) rfb.focus();
  }, [interactive, state]);

  return (
    <div className="relative h-full w-full">
      <div
        ref={el}
        className={cn("h-full w-full", !interactive && "pointer-events-none")}
        data-testid="vnc-screen"
      />
      {state === "off" ? (
        <div
          className="absolute inset-0 grid place-items-center bg-[#0c0d10] px-6 text-center text-sm"
          data-testid="screen-computer-off"
        >
          <div className="font-medium text-[#d4d4d8]">{COMPUTER_OFF_MESSAGE}</div>
        </div>
      ) : (
        state !== "connected" && (
          <div className="absolute inset-0 grid place-items-center bg-[#0c0d10] text-[#9a9aa0] text-sm">
            <div className="flex items-center gap-2">
              {state === "connecting" ? <Spinner /> : <RefreshCw className="size-3.5" />}
              {state === "connecting" ? "Connecting to screen…" : "Screen disconnected · retrying"}
            </div>
          </div>
        )
      )}
    </div>
  );
}

function Asleep({ agent, compact }: { agent: AgentView; compact?: boolean }) {
  const runtime = useApp((s) => s.computer?.runtime);
  // Never set up on this Mac (the customer picked "Do this later"): starting it isn't the next step, setting it up is.
  const notSetUp = useApp(
    (s) => s.computer?.host.kind === "local" && (s.settings.computerSetup ?? "done") !== "done",
  );
  const owner = useApp((s) => Object.values(s.agents).find((a) => a.isPrimary)?.name ?? "Yo");
  const booting = agent.computer.state === "booting";
  const off = runtime !== "running";
  return (
    <div className="relative grid h-full w-full place-items-center overflow-hidden bg-[radial-gradient(120%_90%_at_50%_120%,#1d1e25,#0b0c0e)] text-[#a1a1a7]">
      <div className="flex flex-col items-center gap-3 text-center">
        <AgentAvatar
          agent={agent}
          size={compact ? 44 : 84}
          state={booting ? "working" : "sleeping"}
          className="text-[#8a8a90]"
        />
        <div className={cn("font-medium text-[#d4d4d8]", compact ? "text-sm" : "text-lg")}>
          {booting
            ? "Waking up…"
            : off && notSetUp
              ? "Not set up yet"
              : off
                ? COMPUTER_OFF_MESSAGE
                : `${agent.name}'s computer is asleep`}
        </div>
        {!compact && !booting && (
          <div className="max-w-[320px] text-sm" data-testid="screen-off-hint">
            {off && notSetUp
              ? `${owner}'s computer isn't set up yet. You can set it up in Settings → Computer.`
              : off
                ? `Start ${owner}'s computer in Settings → Computer to see the live screen.`
                : "It's hibernating to save memory. Wake it to watch live."}
          </div>
        )}
        {!compact && !booting && !off && (
          <Button
            variant="brand"
            size="sm"
            onClick={() => run(api().call("computer.wake", { agentId: agent.id }))}
          >
            <Power className="size-3.5" /> Wake
          </Button>
        )}
      </div>
      {!booting && <Moon className="absolute top-3 right-3 size-3.5 opacity-40" />}
    </div>
  );
}

export function ScreenView({
  agent,
  interactive = false,
  compact = false,
}: {
  agent: AgentView;
  interactive?: boolean;
  compact?: boolean;
}) {
  if (agent.computer.state !== "ready") return <Asleep agent={agent} compact={compact} />;
  if (api().mock) return <MockDesktop agent={agent} interactive={interactive} />;
  return <VncScreen agentId={agent.id} interactive={interactive} />;
}
