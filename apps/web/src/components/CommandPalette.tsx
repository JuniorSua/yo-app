import { Dialog as BDialog } from "@base-ui/react/dialog";
import { isLead, SPACE_LABELS, type Space, type WorkspaceSearchResult } from "@yo/contracts";
import {
  Activity,
  Brain,
  CalendarClock,
  Clock3,
  CornerDownLeft,
  History,
  Keyboard,
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
import { recentRequests } from "../lib/presence";
import { newRequestKey } from "../lib/useShortcuts";
import { cn, modKey } from "../lib/utils";
import { openMessage, openSearchResult } from "../lib/workspace";
import { sortAgents, useApp } from "../stores/app";
import { setAutoSwitch, toggleSpace, useActiveAgent, useSpace } from "../stores/space";
import { run } from "../stores/sync";
import { useTimeline } from "../stores/timeline";
import { ui, useUI } from "../stores/ui";
import { AgentAvatar } from "./brand";
import { SPACE_ICON } from "./SpaceSwitch";
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

/** Work & Personal: switch, back to the schedule, and the work hours (Settings → Work & Personal). */
function spaceCmds(space: Space, auto: boolean): Cmd[] {
  const ic = "size-4 text-muted";
  const other = space === "work" ? "personal" : "work";
  const Icon = SPACE_ICON[other];
  return [
    {
      id: "space-switch",
      group: "Actions",
      label: `Switch to ${SPACE_LABELS[other]}`,
      icon: <Icon className={ic} />,
      shortcut: `${modKey}⇧M`,
      run: toggleSpace,
    },
    ...(auto
      ? []
      : [
          {
            id: "space-auto",
            group: "Actions",
            label: "Follow my work hours",
            hint: "Switch between Work and Personal automatically",
            icon: <CalendarClock className={ic} />,
            run: () => void setAutoSwitch(true),
          },
        ]),
    {
      id: "space-hours",
      group: "Actions",
      label: "Edit work hours",
      icon: <Clock3 className={ic} />,
      run: () => ui.openSettings("spaces"),
    },
  ];
}

export function CommandPalette() {
  const open = useUI((s) => s.paletteOpen);
  const agents = useApp((s) => s.agents);
  const theme = useApp((s) => s.settings.theme);
  const active = useActiveAgent();
  const space = useSpace((s) => s.space);
  const spaces = useSpace((s) => s.available);
  const auto = useSpace((s) => s.source === "schedule");
  const yoId = active?.id;
  // Recent requests live here: ⌘K or the rail's Search opens straight onto them (the active space's agent's).
  const yoEntries = useTimeline((s) => (yoId ? s.byAgent[yoId] : undefined));
  const recent = useMemo(() => recentRequests(yoEntries), [yoEntries]);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<WorkspaceSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [idx, setIdx] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const close = () => useUI.setState({ paletteOpen: false });

  useEffect(() => {
    if (open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  useEffect(() => {
    setResults([]);
    setError("");
    if (!open || !q.trim()) {
      setSearching(false);
      return;
    }
    let active = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void api()
        .call("workspace.search", { query: q.trim(), limit: 40 })
        .then((rows) => {
          if (active) {
            setResults(rows);
            setSearching(false);
            setIdx(0);
          }
        })
        .catch(() => {
          if (active) {
            setError("Work search is unavailable. Pages and actions are still below.");
            setSearching(false);
          }
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, q]);

  const cmds = useMemo<Cmd[]>(() => {
    const ic = "size-4 text-muted";
    return [
      ...sortAgents(agents).map((a) => ({
        id: `agent-${a.id}`,
        // Yo (Work) and Pip (Personal) are the main assistants; everyone else is a teammate.
        group: isLead(a) ? (spaces ? "Your assistants" : "Your assistant") : "Teammates",
        label: a.name,
        // "Work · your work assistant", so typing "work" or "personal" finds them.
        hint: spaces && a.space ? `${SPACE_LABELS[a.space]} · ${a.role}` : a.role,
        icon: <AgentAvatar agent={a} size={20} quiet />,
        run: () => ui.openAgent(a.id),
      })),
      {
        id: "new",
        group: "Actions",
        label: "New request",
        icon: <Plus className={ic} />,
        shortcut: newRequestKey(),
        run: () => {
          if (active) ui.focusComposer(active.id);
        },
      },
      ...(spaces ? spaceCmds(space, auto) : []),
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
        label: "Needs you",
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
        label: "Make",
        icon: <Shapes className={ic} />,
        run: () => ui.goto("artifacts"),
      },
      {
        id: "a-shortcuts",
        group: "Actions",
        label: "Keyboard shortcuts",
        icon: <Keyboard className={ic} />,
        shortcut: `${modKey}/`,
        run: () => useUI.setState({ shortcutsOpen: true }),
      },
    ];
  }, [agents, theme, active, spaces, space, auto]);

  const filtered = useMemo<Cmd[]>(() => {
    const s = q.trim().toLowerCase();
    if (!s)
      return [
        ...recent.map((e) => ({
          id: `recent-${e.id}`,
          group: "Recent requests",
          label: e.item.text!.replace(/\s+/g, " "),
          icon: <History className="size-4 text-muted" />,
          run: () => {
            void openMessage(e.agentId, e.id);
          },
        })),
        ...cmds,
      ];
    const matches = cmds.filter(
      (c) =>
        c.label.toLowerCase().includes(s) ||
        c.hint?.toLowerCase().includes(s) ||
        c.group.toLowerCase().includes(s),
    );
    return [
      ...results.map((r) => ({
        id: `${r.kind}-${r.id}`,
        group: { message: "Messages", memory: "Memory", routine: "Routines", file: "Files" }[r.kind],
        label: r.title,
        hint: r.snippet,
        icon: <Search className="size-4 text-muted" />,
        run: () => {
          void openSearchResult(r);
        },
      })),
      ...matches,
    ];
  }, [cmds, q, results, recent]);

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
          className="-translate-x-1/2 fixed top-[14vh] left-1/2 z-50 w-[min(600px,calc(100vw-32px))] overflow-hidden rounded-2xl border border-border-strong/60 bg-[var(--elevated)] shadow-pop outline-none transition-[opacity,transform] duration-150 data-[ending-style]:scale-[0.98] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.98] data-[starting-style]:opacity-0"
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
                  setIdx((i) => Math.max(0, Math.min(filtered.length - 1, i + 1)));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setIdx((i) => Math.max(0, i - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  exec(filtered[idx]);
                }
              }}
              placeholder="Search your work or jump to a page…"
              aria-label="Search your work"
              maxLength={200}
              className="h-13 flex-1 bg-transparent text-md outline-none"
            />
            <Kbd>esc</Kbd>
          </div>
          <div ref={list} className="scroll-fade max-h-[52vh] overflow-y-auto p-1.5 [--scroll-fade:16px]">
            {searching && (
              <div role="status" className="px-3 py-3 text-muted text-sm">
                Searching your work…
              </div>
            )}
            {error && (
              <div role="status" className="px-3 py-3 text-warning text-sm">
                {error}
              </div>
            )}
            {!searching && !error && filtered.length === 0 && (
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
                    <span className="min-w-0 max-w-[65%] truncate font-medium">{c.label}</span>
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
