import type { AgentView } from "@yo/contracts";
import { FolderOpen, Globe, Hand, Square, SquareTerminal, Undo2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { hasTrafficLights } from "../../lib/desktop";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { AgentAvatar, pillFor, StatusPill } from "../brand";
import { Button } from "../ui/button";
import { Tip } from "../ui/overlay";
import { FilesView } from "./FilesWindow";
import { FloatingWindow } from "./FloatingWindow";
import { ScreenView } from "./ScreenView";
import { TerminalView } from "./TerminalWindow";

type Win = "terminal" | "files";

function useFit16x10(pad = 0) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const W = el.clientWidth - pad * 2;
      const H = el.clientHeight - pad * 2;
      const w = Math.min(W, H * 1.6);
      setSize({ w, h: w / 1.6 });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [pad]);
  return { ref, size };
}

function DockButton({
  label,
  active,
  onClick,
  children,
  testId,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Tip label={label}>
      <button
        aria-label={label}
        data-testid={testId}
        onClick={onClick}
        className="relative grid size-11 place-items-center rounded-xl text-white/85 transition-all duration-150 hover:scale-[1.06] hover:bg-white/10 hover:text-white active:scale-95 [&_svg]:size-5"
      >
        {children}
        {active && <span className="-bottom-1 absolute size-1 rounded-full bg-white/80" />}
      </button>
    </Tip>
  );
}

function FittedScreen({ agent, control }: { agent: AgentView; control: boolean }) {
  const { ref, size } = useFit16x10(0);
  return (
    <div ref={ref} className="relative mx-5 mb-24 grid min-h-0 flex-1 place-items-center">
      <div
        className={cn(
          "relative overflow-hidden rounded-[14px] bg-black shadow-[0_40px_120px_-20px_rgba(0,0,0,0.9)] ring-1 transition-[box-shadow] duration-300",
          control ? "ring-2 ring-success/80" : "ring-white/8",
        )}
        style={{ width: size.w || "100%", height: size.h || "100%" }}
      >
        <ScreenView agent={agent} interactive={control} />
      </div>
      {control && (
        <div className="-translate-x-1/2 absolute top-3 left-1/2 flex items-center gap-2 rounded-full bg-success px-3 py-1 font-medium text-black text-xs shadow-pop animate-rise">
          <Hand className="size-3.5" /> You have control — {agent.name} is paused
        </div>
      )}
    </div>
  );
}

export function ComputerOverlay() {
  const agentId = useUI((s) => s.computerAgentId);
  const agent = useApp((s) => (agentId ? s.agents[agentId] : undefined));
  const [wins, setWins] = useState<Win[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agentId) setWins([]);
  }, [agentId]);

  if (!agentId || !agent) return null;
  const control = agent.computer.lease === "user";
  const working = agent.activity === "working" || agent.activity === "waiting";
  const close = () => useUI.setState({ computerAgentId: null });
  const toggle = (w: Win) => setWins((s) => (s.includes(w) ? s.filter((x) => x !== w) : [...s, w]));
  const focus = (w: Win) => setWins((s) => [...s.filter((x) => x !== w), w]);

  const takeover = async () => {
    setBusy(true);
    await run(api().call(control ? "computer.release" : "computer.takeover", { agentId: agent.id }));
    setBusy(false);
  };

  return (
    <div
      data-testid="computer-overlay"
      className="dark fixed inset-0 z-40 flex flex-col bg-[#060607] text-fg animate-fade-in"
    >
      <div
        className={cn("app-drag flex h-14 shrink-0 items-center gap-3 px-4", hasTrafficLights && "pl-[84px]")}
      >
        <AgentAvatar agent={agent} size={28} />
        <div className="font-semibold">{agent.name}'s computer</div>
        <StatusPill kind={pillFor(agent)} />
        <div className="flex-1" />
        {working && !control && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => run(api().call("chat.interrupt", { agentId: agent.id }))}
          >
            <Square className="size-3 fill-current" /> Stop agent
          </Button>
        )}
        {control ? (
          <Button
            variant="primary"
            size="sm"
            disabled={busy}
            onClick={takeover}
            data-testid="give-back"
            className="bg-success text-black hover:bg-success/90"
          >
            <Undo2 className="size-3.5" /> Give back to {agent.name}
          </Button>
        ) : (
          <Button
            variant="brand"
            size="sm"
            disabled={busy || agent.computer.state !== "ready"}
            onClick={takeover}
            data-testid="take-over"
          >
            <Hand className="size-3.5" /> Take over
          </Button>
        )}
        <Tip label="Close" shortcut="Esc" side="bottom">
          <button
            aria-label="Close computer"
            data-testid="close-computer"
            onClick={close}
            className="grid size-8 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
          >
            <X className="size-[18px]" />
          </button>
        </Tip>
      </div>

      <FittedScreen agent={agent} control={control} />

      <div className="-translate-x-1/2 absolute bottom-5 left-1/2 flex items-center gap-1 rounded-2xl border border-white/10 bg-white/[0.07] p-1.5 shadow-[0_20px_60px_-10px_rgba(0,0,0,0.8)] backdrop-blur-2xl">
        <DockButton label="Browser" onClick={() => setWins([])} active={wins.length === 0}>
          <Globe />
        </DockButton>
        <DockButton
          label="Terminal"
          testId="dock-terminal"
          onClick={() => toggle("terminal")}
          active={wins.includes("terminal")}
        >
          <SquareTerminal />
        </DockButton>
        <DockButton
          label="Files"
          testId="dock-files"
          onClick={() => toggle("files")}
          active={wins.includes("files")}
        >
          <FolderOpen />
        </DockButton>
      </div>

      {wins.map((w, i) =>
        w === "terminal" ? (
          <FloatingWindow
            key="terminal"
            testId="terminal-window"
            title="Terminal"
            icon={<SquareTerminal className="size-3.5" />}
            initial={{ x: Math.max(24, window.innerWidth / 2 - 420), y: 110, w: 680, h: 400 }}
            z={50 + i}
            onFocus={() => focus("terminal")}
            onClose={() => toggle("terminal")}
          >
            <TerminalView agentId={agent.id} />
          </FloatingWindow>
        ) : (
          <FloatingWindow
            key="files"
            testId="files-window"
            title="Files"
            icon={<FolderOpen className="size-3.5" />}
            initial={{ x: Math.max(24, window.innerWidth / 2 - 40), y: 150, w: 520, h: 400 }}
            z={50 + i}
            onFocus={() => focus("files")}
            onClose={() => toggle("files")}
          >
            <FilesView agentId={agent.id} />
          </FloatingWindow>
        ),
      )}
    </div>
  );
}
