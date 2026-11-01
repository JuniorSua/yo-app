import type { AgentView, Artifact, TimelineEntry } from "@yo/contracts";
import { Download, Globe, LayoutTemplate, Maximize2, Plus, Sparkles, X } from "lucide-react";
import {
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { accentVars } from "../../lib/accent";
import { api } from "../../lib/api";
import { activeHelpers, presenceTone, runningStep } from "../../lib/presence";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { useTimeline } from "../../stores/timeline";
import { ui, useUI } from "../../stores/ui";
import { PageFrame, PinButton } from "../agent/Pages";
import { usePaintedTheme } from "../agent/paintedTheme";
import { AgentAvatar } from "../brand";
import { ScreenView } from "../computer/ScreenView";
import { Menu, MenuItem, MenuSeparator, Sheet, Tip } from "../ui/overlay";

interface Tab {
  id: string;
  label: string;
  /** The agent whose computer the tab shows (the main agent or a helper); pages have none. */
  agent?: AgentView;
  page?: Artifact;
}

/** The newest web address the agent's browser opened (its last `browser` step), or null. */
export function useLatestUrl(agentId: string): string | null {
  return useTimeline((s) => latestUrl(s.byAgent[agentId]));
}

function latestUrl(entries: readonly TimelineEntry[] | undefined): string | null {
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const url = (e.item.input as { url?: string } | undefined)?.url;
    if (e.item.kind === "browser" && url) return url;
  }
  return null;
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * The workspace beside the chat (Dots' tabbed workspace): a browser-like panel whose first tab is always the
 * agent's computer, live and big, then one tab per working helper and any pages you opened. The tab strip sits
 * in the title bar; its empty space drags the Mac window. On a narrow window it's a modal sheet over the chat.
 */
export function Workspace({ agent, sheet }: { agent: AgentView; sheet?: boolean }) {
  const agents = useApp((s) => s.agents);
  const artifacts = useApp((s) => s.artifacts);
  const pageTabs = useUI((s) => s.pageTabs);
  const want = useUI((s) => s.workspaceTab);
  const sheetOpen = useUI((s) => s.workspaceSheet);
  const helpers = useMemo(() => activeHelpers(agents, agent.id), [agents, agent.id]);
  const ids = useId();
  useEffect(() => {
    load.artifacts().catch(() => undefined);
  }, []);
  const tabs: Tab[] = [
    { id: "computer", label: `${agent.name}’s computer`, agent },
    ...helpers.map((h) => ({ id: `helper:${h.id}`, label: `Helper · ${h.name}`, agent: h })),
    ...pageTabs.flatMap((id) => {
      const page = artifacts?.find((a) => a.id === id);
      return page ? [{ id: `page:${id}`, label: page.title, page }] : [];
    }),
  ];
  const active = tabs.find((t) => t.id === want) ?? tabs[0]!;
  const tabId = (t: Tab) => `${ids}-tab-${t.id}`;
  const panelId = `${ids}-panel`;
  // Tabs (ARIA): one tab stop, arrows and Home/End move between tabs and show them.
  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === active.id);
    const next =
      e.key === "ArrowRight"
        ? (i + 1) % tabs.length
        : e.key === "ArrowLeft"
          ? (i - 1 + tabs.length) % tabs.length
          : e.key === "Home"
            ? 0
            : e.key === "End"
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    e.preventDefault();
    const t = tabs[next]!;
    useUI.setState({ workspaceTab: t.id });
    document.getElementById(tabId(t))?.focus();
  };
  const body: ReactNode = (
    <>
      <div className="ws-strip app-drag">
        <div className="ws-tabs app-drag" role="tablist" aria-label="Workspace tabs" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <WorkspaceTab key={t.id} tab={t} active={t.id === active.id} id={tabId(t)} panel={panelId} />
          ))}
        </div>
        <NewTabMenu />
        {sheet && (
          <button
            type="button"
            className="ws-strip-close"
            aria-label="Close the workspace"
            data-testid="workspace-close"
            onClick={() => useUI.setState({ workspaceSheet: false })}
          >
            <X aria-hidden />
          </button>
        )}
      </div>
      {active.agent ? (
        <ComputerTab
          key={active.id}
          agent={active.agent}
          helper={active.id !== "computer"}
          panel={{ id: panelId, by: tabId(active) }}
        />
      ) : active.page ? (
        <PageTab key={active.id} page={active.page} panel={{ id: panelId, by: tabId(active) }} />
      ) : null}
    </>
  );
  if (sheet)
    return (
      <Sheet
        open={sheetOpen}
        onOpenChange={(open) => !open && useUI.setState({ workspaceSheet: false })}
        label={`${agent.name}’s workspace`}
        className="ws is-sheet"
        backdropClassName="ws-scrim"
        testId="workspace"
      >
        {body}
      </Sheet>
    );
  return (
    <section className="ws" data-testid="workspace" aria-label={`${agent.name}’s workspace`}>
      {body}
    </section>
  );
}

function WorkspaceTab({ tab, active, id, panel }: { tab: Tab; active: boolean; id: string; panel: string }) {
  const helper = tab.id.startsWith("helper:");
  return (
    <div
      className={cn("ws-tab", active && "is-active", helper && "is-helper")}
      data-testid={`ws-tab-${tab.id}`}
    >
      <button
        type="button"
        role="tab"
        id={id}
        aria-selected={active}
        aria-controls={active ? panel : undefined}
        tabIndex={active ? 0 : -1}
        className="ws-tab-main"
        title={tab.label}
        onClick={() => useUI.setState({ workspaceTab: tab.id })}
      >
        {tab.agent ? (
          <span className="ws-tab-face" aria-hidden>
            <AgentAvatar agent={tab.agent} size={16} quiet />
          </span>
        ) : (
          <LayoutTemplate className="ws-tab-icon" aria-hidden />
        )}
        <span className="truncate">{tab.label}</span>
        {helper && <i className="ws-tab-live" aria-hidden />}
      </button>
      {tab.page && (
        <button
          type="button"
          className="ws-tab-close"
          aria-label={`Close ${tab.label}`}
          data-testid="ws-tab-close"
          onClick={() => ui.closePageTab(tab.page!.id)}
        >
          <X aria-hidden />
        </button>
      )}
    </div>
  );
}

/** "+": open one of the team's pages in a tab, or everything they made. */
function NewTabMenu() {
  const artifacts = useApp((s) => s.artifacts);
  const pages = (artifacts ?? [])
    .filter((a) => a.kind === "page")
    .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0) || b.createdAt - a.createdAt)
    .slice(0, 8);
  return (
    <Menu
      trigger={
        <button type="button" className="ws-strip-plus" aria-label="Open a page" data-testid="ws-new-tab">
          <Plus aria-hidden />
        </button>
      }
    >
      {pages.map((p) => (
        <MenuItem
          key={p.id}
          icon={<LayoutTemplate />}
          testId="ws-open-page"
          onClick={() => ui.showTab(`page:${p.id}`)}
        >
          {p.title}
        </MenuItem>
      ))}
      {pages.length > 0 && <MenuSeparator />}
      <MenuItem icon={<Sparkles />} onClick={() => ui.goto("artifacts")}>
        Everything the team made
      </MenuItem>
    </Menu>
  );
}

/** Fits a 16:10 screen inside the stage (less its inset), as big as it goes: usually the full width. */
function useFit(pad: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const W = el.clientWidth - pad * 2;
      const H = el.clientHeight - pad * 2;
      const w = Math.max(0, Math.min(W, H * 1.6));
      setSize({ w, h: w / 1.6 });
    };
    // Measured before the first paint too, so the screen never shows a frame at the wrong size.
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [pad]);
  return { ref, size };
}

/**
 * A computer tab: the address the agent's browser is on and Watch (full screen), then the live screen big on the
 * agent's wallpaper, with who has control (and Take over / Give back) in a pill over the foot of the screen.
 */
function ComputerTab({
  agent,
  helper,
  panel,
}: {
  agent: AgentView;
  helper: boolean;
  panel: { id: string; by: string };
}) {
  const theme = usePaintedTheme();
  const accent = useMemo(() => accentVars(agent.avatar, theme), [agent.avatar, theme]);
  const url = useLatestUrl(agent.id);
  const running = useApp((s) => s.computer?.runtime === "running");
  const control = agent.computer.lease === "user";
  const ready = running && agent.computer.state === "ready";
  const [busy, setBusy] = useState(false);
  const { ref, size } = useFit(14);
  // A helper's chat isn't open anywhere: load it for the address its browser is on.
  useEffect(() => {
    if (helper) void useTimeline.getState().load(agent.id);
  }, [helper, agent.id]);
  const toggleControl = async () => {
    setBusy(true);
    await run(
      api().call(control ? "computer.release" : "computer.takeover", { agentId: agent.id }),
      control ? "Couldn't hand control back" : "Couldn't take over",
    );
    setBusy(false);
  };
  const host = url ? hostOf(url) : null;
  const step = useTimeline((s) => runningStep(s.byAgent[agent.id]));
  const doing = presenceTone(agent) === "working" ? doingLine(agent, step, host) : "";
  return (
    <div
      className="ws-body"
      style={accent as CSSProperties}
      role="tabpanel"
      id={panel.id}
      aria-labelledby={panel.by}
    >
      <div className="ws-nav">
        <div className="ws-url" data-testid="ws-url" title={url ?? undefined}>
          <Globe aria-hidden />
          {host ? (
            <>
              <span className="ws-url-host">{host}</span>
              <span className="ws-url-rest truncate">{urlRest(url!)}</span>
            </>
          ) : (
            <span className="ws-url-empty truncate">
              {helper ? "Helper’s browser" : ready ? `${agent.name}’s browser` : `${agent.name}’s computer`}
            </span>
          )}
        </div>
        <div className="ws-nav-end">
          <Tip label="Watch full screen" side="bottom">
            <button
              type="button"
              className="ws-nav-button"
              aria-label={`Watch ${agent.name}’s computer full screen`}
              data-testid="ws-watch"
              onClick={() => ui.openComputer(agent.id)}
            >
              <Maximize2 aria-hidden />
            </button>
          </Tip>
        </div>
      </div>
      <div className="ws-stage" ref={ref} data-testid="ws-stage">
        <div
          className={cn("ws-frame", control && "is-control")}
          data-testid="ws-screen"
          style={{ width: size.w || undefined, height: size.h || undefined }}
        >
          <ScreenView agent={agent} interactive={control} />
          {ready && !helper && (
            <div className={cn("ws-control", control && "is-control")} data-testid="ws-control">
              {control ? (
                <>
                  <span className="ws-control-label">You have control</span>
                  <button type="button" disabled={busy} onClick={toggleControl} data-testid="ws-give-back">
                    Give back
                  </button>
                </>
              ) : (
                <>
                  {/* While it works, the pill says what it's doing; idle, just who has the screen. */}
                  <span title={doing || undefined}>
                    <AgentAvatar agent={agent} size={18} quiet />
                    {doing ? (
                      <span className="ws-control-label is-doing" key={doing} data-testid="ws-doing">
                        <span className="ws-control-who">{agent.name}</span>
                        <span aria-hidden> · </span>
                        {doing}
                      </span>
                    ) : (
                      <span className="ws-control-label">{agent.name} has control</span>
                    )}
                  </span>
                  <button type="button" disabled={busy} onClick={toggleControl} data-testid="ws-take-over">
                    Take over
                  </button>
                </>
              )}
            </div>
          )}
          {helper && (
            <div className="ws-control" data-testid="ws-helper-status">
              <span title={agent.preview ?? undefined}>
                <AgentAvatar agent={agent} size={18} quiet />
                <span className="ws-control-label">{agent.preview ?? "Working…"}</span>
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * What the agent is doing, for the pill over its screen: what it says it's doing, else its running step, else its
 * plan's current item, else the site its browser is on.
 */
export function doingLine(agent: AgentView, step: string, host: string | null): string {
  const plan = agent.todos.find((t) => t.status === "in_progress")?.text;
  const task = (agent.statusLine ?? (step || plan || "")).replace(/`/g, "").trim();
  if (task) return task.charAt(0).toUpperCase() + task.slice(1);
  return host ? `On ${host}` : "Thinking…";
}

/** What follows the host in the address bar: the path and query (`/x?y`), nothing for the bare site. */
function urlRest(url: string): string {
  try {
    const u = new URL(url);
    return (u.pathname === "/" ? "" : u.pathname) + u.search;
  } catch {
    return "";
  }
}

/** A page or artifact, the way the page viewer shows it. */
function PageTab({ page, panel }: { page: Artifact; panel: { id: string; by: string } }) {
  return (
    <div className="ws-body" role="tabpanel" id={panel.id} aria-labelledby={panel.by}>
      <div className="ws-nav">
        <div className="ws-url" data-testid="ws-url">
          <LayoutTemplate aria-hidden />
          <span className="ws-url-host truncate">{page.title}</span>
        </div>
        <div className="ws-nav-end">
          <PinButton a={page} />
          <Tip label="Download">
            <a
              href={api().artifactUrl(page.id)}
              download={`${page.title.replace(/[^\w\- ]/g, "_")}.html`}
              aria-label="Download the page"
              className="ws-nav-button"
            >
              <Download aria-hidden />
            </a>
          </Tip>
        </div>
      </div>
      <div className="ws-page">
        <PageFrame artifactId={page.id} title={page.title} className="h-full w-full" />
      </div>
    </div>
  );
}
