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

type VncState = "connecting" | "connected" | "disconnected";

/** Live noVNC view of an agent's display. View-only unless `interactive` (user has control). */
function VncScreen({ agentId, interactive }: { agentId: string; interactive: boolean }) {
  const el = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [state, setState] = useState<VncState>("connecting");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let retry: number | undefined;
    setState("connecting");
    import("@novnc/novnc").then(({ default: RFBClass }) => {
      if (cancelled || !el.current) return;
      const rfb = new RFBClass(el.current, api().vncUrl(agentId), { shared: true });
      rfb.scaleViewport = true;
      rfb.resizeSession = false;
      rfb.background = "transparent";
      rfb.qualityLevel = 7;
      rfb.viewOnly = !interactive;
      rfb.focusOnClick = interactive;
      rfb.addEventListener("connect", () => setState("connected"));
      rfb.addEventListener("disconnect", () => {
        if (cancelled) return;
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
  }, [agentId, attempt]);

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
      {state !== "connected" && (
        <div className="absolute inset-0 grid place-items-center bg-[#0c0d10] text-[#9a9aa0] text-sm">
          <div className="flex items-center gap-2">
            {state === "connecting" ? <Spinner /> : <RefreshCw className="size-3.5" />}
            {state === "connecting" ? "Connecting to screen…" : "Screen disconnected · retrying"}
          </div>
        </div>
      )}
    </div>
  );
}

function Asleep({ agent, compact }: { agent: AgentView; compact?: boolean }) {
  const runtime = useApp((s) => s.computer?.runtime);
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
          {booting ? "Waking up…" : off ? "Computer is off" : `${agent.name}'s computer is asleep`}
        </div>
        {!compact && !booting && (
          <div className="max-w-[320px] text-sm">
            {off
              ? "Start Yo's computer from Settings to see the live screen."
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
