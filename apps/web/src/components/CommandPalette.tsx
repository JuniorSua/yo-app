import { Dialog as BDialog } from "@base-ui/react/dialog";
import {
  Activity,
  Brain,
  CalendarClock,
  CornerDownLeft,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Shapes,
  ShieldCheck,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api } from "../lib/api";
import { cn, modKey } from "../lib/utils";
import { sortAgents, useApp } from "../stores/app";
import { run } from "../stores/sync";
import { ui, useUI } from "../stores/ui";
import { AgentAvatar } from "./brand";
import { Kbd } from "./ui/controls";

interface Cmd {
  id: string;
  group: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  shortcut?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const agents = useApp((s) => s.agents);
  const theme = useApp((s) => s.settings.theme);
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useUI.setState({ paletteOpen: false });

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  const cmds = useMemo<Cmd[]>(() => {
    const ic = "size-4 text-muted";
    return [
      ...sortAgents(agents).map((a) => ({
        id: `agent-${a.id}`,
        group: "Agents",
        label: a.name,
        hint: a.role,
        icon: <AgentAvatar agent={a} size={20} quiet />,
        run: () => ui.openAgent(a.id),
      })),
      {
        id: "new",
        group: "Actions",
        label: "New agent",
        icon: <Plus className={ic} />,
        shortcut: `${modKey}N`,
        run: () => useUI.setState({ newAgentOpen: true }),
      },
      {
        id: "computer",
        group: "Actions",
        label: "Open computer",
        hint: "Full-screen live view",
        icon: <Monitor className={ic} />,
        run: () => ui.openComputer(useUI.getState().agentId),
      },
      {
        id: "theme",
        group: "Actions",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: <Moon className={ic} />,
        run: () => run(api().call("settings.update", { theme: theme === "dark" ? "light" : "dark" })),
      },
      {
        id: "settings",
        group: "Actions",
        label: "Settings",
        icon: <Settings className={ic} />,
        shortcut: `${modKey},`,
        run: () => ui.openSettings(),
      },
      {
        id: "p-activity",
        group: "Go to",
        label: "Activity",
        icon: <Activity className={ic} />,
        run: () => ui.goto("activity"),
      },
      {
        id: "p-approvals",
        group: "Go to",
        label: "Approvals",
        icon: <ShieldCheck className={ic} />,
        run: () => ui.goto("approvals"),
      },
      {
        id: "p-routines",
        group: "Go to",
        label: "Routines",
        icon: <CalendarClock className={ic} />,
        run: () => ui.goto("routines"),
      },
      {
        id: "p-memory",
        group: "Go to",
        label: "Memory",
        icon: <Brain className={ic} />,
        run: () => ui.goto("memory"),
      },
      {
        id: "p-artifacts",
        group: "Go to",
        label: "Artifacts",
        icon: <Shapes className={ic} />,
        run: () => ui.goto("artifacts"),
      },
    ];
  }, [agents, theme]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return cmds;
    return cmds.filter(
      (c) =>
        c.label.toLowerCase().includes(s) ||
        c.hint?.toLowerCase().includes(s) ||
        c.group.toLowerCase().includes(s),
    );
  }, [cmds, q]);

  useEffect(() => setIdx(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-idx="${idx}"]`)?.scrollIntoView({ block: "nearest" });
  }, [idx]);

  const exec = (c: Cmd | undefined) => {
    if (!c) return;
    close();
    c.run();
  };

  let lastGroup = "";
  return (
    <BDialog.Root open={open} onOpenChange={(o) => useUI.setState({ paletteOpen: o })}>
      <BDialog.Portal>
        <BDialog.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <BDialog.Popup
          data-testid="command-palette"
          className="-translate-x-1/2 fixed top-[14vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border-strong/60 bg-elevated shadow-pop outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
        >
          <BDialog.Title className="sr-only">Command palette</BDialog.Title>
          <div className="flex items-center gap-3 border-border border-b px-4">
            <Search className="size-4 text-muted" />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setIdx((i) => Math.min(filtered.length - 1, i + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  exec(filtered[idx]);
                }
              }}
              placeholder="Search agents, pages and actions…"
              className="h-13 flex-1 bg-transparent text-md outline-none"
            />
            <Kbd>esc</Kbd>
          </div>
          <div ref={list} className="scroll-fade max-h-[52vh] overflow-y-auto p-1.5 [--scroll-fade:16px]">
            {filtered.length === 0 && (
              <div className="px-3 py-8 text-center text-muted text-sm">No results for “{q}”</div>
            )}
            {filtered.map((c, i) => {
              const header = c.group !== lastGroup;
              lastGroup = c.group;
              return (
                <div key={c.id}>
                  {header && (
                    <div className="px-2.5 pt-2.5 pb-1 font-medium text-2xs text-faint uppercase tracking-[0.08em]">
                      {c.group}
                    </div>
                  )}
                  <button
                    data-idx={i}
                    onMouseMove={() => setIdx(i)}
                    onClick={() => exec(c)}
                    className={cn(
                      "flex h-10 w-full items-center gap-3 rounded-xl px-2.5 text-left",
                      i === idx && "bg-active",
                    )}
                  >
                    <span className="grid size-5 place-items-center">{c.icon}</span>
                    <span className="font-medium">{c.label}</span>
                    {c.hint && <span className="truncate text-muted text-sm">{c.hint}</span>}
                    <span className="ml-auto flex items-center gap-2">
                      {c.shortcut && <span className="text-muted text-xs">{c.shortcut}</span>}
                      {i === idx && <CornerDownLeft className="size-3.5 text-muted" />}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
        </BDialog.Popup>
      </BDialog.Portal>
    </BDialog.Root>
  );
}
