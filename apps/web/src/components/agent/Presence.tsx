import type { AgentView } from "@yo/contracts";
import { type CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import { activeHelpers, lastFailure, type PresenceTone, presenceTone, runningStep } from "../../lib/presence";
import { cn } from "../../lib/utils";
import { chatFor, useApp } from "../../stores/app";
import { useTimeline } from "../../stores/timeline";
import { ui, WORKSPACE_QUERY } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { ProfileCard } from "../shell/Inspector";
import { TeamButton } from "../shell/Rail";
import { TopBarButtons } from "../shell/TopBar";
import { Popover, Tip } from "../ui/overlay";

export function useMedia(query: string) {
  const [match, setMatch] = useState(() => typeof matchMedia === "function" && matchMedia(query).matches);
  useEffect(() => {
    const q = matchMedia(query);
    const on = () => setMatch(q.matches);
    on();
    q.addEventListener("change", on);
    return () => q.removeEventListener("change", on);
  }, [query]);
  return match;
}

/** Wide enough for the workspace beside the chat; narrower windows open it as a sheet. */
export const PANE_QUERY = WORKSPACE_QUERY;

/**
 * The chat's top: one drag area for the window, the round buttons top-right (computer, workspace), and the agent's
 * head floating at top centre over the conversation, which fades out under it. With no head (an empty chat shows
 * it big in the middle) only the buttons stay.
 */
export function ChatTop({ agent, head }: { agent: AgentView; head: boolean }) {
  const phone = useMedia("(max-width: 600px)");
  return (
    <div
      className={cn("chat-top app-drag", head && "has-head")}
      // The head band covers the top of the conversation: a wheel or trackpad scroll over it still scrolls the chat.
      onWheel={(e) => {
        const scroller =
          e.currentTarget.parentElement?.querySelector<HTMLElement>('[data-testid="timeline"]');
        scroller?.scrollBy({ top: e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY });
      }}
    >
      <div className="chat-bar">
        {/* Phones have no rail Team: the team opens from here. */}
        {phone && <TeamButton compact />}
        <TopBarButtons agent={agent} />
      </div>
      {head && <PresenceHeader agent={agent} />}
    </div>
  );
}

const plural = (n: number, one: string) => (n === 1 ? `1 ${one}` : `${n} ${one}s`);

/**
 * "Idle" · "Thinking…" · "Working on <task>" · "Waiting for you": the one line under the name. While it has helpers
 * the line says so ("Working with 2 helpers"); a request waiting on you is named, and a failure says what went wrong.
 */
export function statusLine(
  agent: AgentView,
  tone: PresenceTone,
  step: string,
  helpers = 0,
  waiting?: { title: string; asking: boolean },
  /** Why the last turn failed (its error notice), when it did. */
  failure = "",
): string {
  const crew = helpers ? plural(helpers, "helper") : "";
  switch (tone) {
    case "waiting":
      return waiting
        ? `${waiting.asking ? "Waiting for your answer" : "Waiting for your OK"} · ${waiting.title}`
        : "Waiting for you";
    case "control":
      return "You have control";
    case "sleeping":
      return "Asleep";
    case "error":
      return failure || "Something went wrong. Ask again, or check Settings";
    case "working": {
      // What it says it's doing, else the running step, else the plan's current item.
      const plan = agent.todos.find((t) => t.status === "in_progress")?.text;
      const task = (agent.statusLine ?? (step || plan || "")).replace(/`/g, "");
      if (!task) return crew ? `Working with ${crew}` : "Thinking…";
      return `Working on ${task.charAt(0).toLowerCase()}${task.slice(1)}${crew ? ` · ${crew}` : ""}`;
    }
    default:
      return crew ? `Working with ${crew}` : "Idle";
  }
}

/**
 * The agent's head (Dots): its Softie big at top centre (it blinks and breathes), its name in a pill under it,
 * then one status line. Clicking it opens the profile popover. While it has helpers, their small heads pop in at
 * the big head's lower right, each with a working ring. `hero`: the bigger head of an empty chat.
 */
export function PresenceHeader({ agent, hero }: { agent: AgentView; hero?: boolean }) {
  const tone = presenceTone(agent);
  const step = useTimeline((s) => runningStep(s.byAgent[agent.id]));
  const failure = useTimeline((s) => (tone === "error" ? lastFailure(s.byAgent[agent.id]) : ""));
  const phone = useMedia("(max-width: 600px)");
  const short = useMedia("(max-height: 800px)");
  const tiny = useMedia("(max-height: 640px)");
  const agents = useApp((s) => s.agents);
  const helpers = useMemo(() => activeHelpers(agents, agent.id), [agents, agent.id]);
  // The request it's waiting on: its own, else one of its helpers'.
  const request = useApp(
    (s) => s.approvals.find((e) => e.request && chatFor(s.agents, e.agentId) === agent.id)?.request,
  );
  const waiting = request?.title
    ? { title: request.title, asking: request.kind === "user_input" }
    : undefined;
  const [open, setOpen] = useState(false);
  // The Softie fills about three quarters of its box: 104 draws a head about 80px tall, Dots' size at 1440×900
  // (measured from the reference, ×1.633). The head zone's solid ground (styles/dots.css --head-solid) fits each.
  const size = hero ? (phone ? 96 : 136) : phone ? 64 : tiny ? 84 : short ? 96 : 104;
  const Tag = hero ? "div" : "header";
  const line = statusLine(agent, tone, step, helpers.length, waiting, failure);
  return (
    <Tag
      className={cn("chat-head", hero && "is-hero")}
      data-testid={hero ? "presence-hero" : "presence-header"}
      data-tone={tone}
    >
      <div className="chat-head-stack" style={{ "--head-size": `${size}px` } as CSSProperties}>
        <Popover
          open={open}
          onOpenChange={setOpen}
          align="center"
          sideOffset={8}
          className="profile-popover"
          label={`${agent.name}’s profile`}
          keepSide
          trigger={
            <button
              type="button"
              className="chat-head-avatar"
              data-testid="presence-avatar"
              aria-label={`${agent.name}’s profile`}
            >
              <AgentAvatar agent={agent} size={size} ground={hero} live />
            </button>
          }
        >
          <ProfileCard agent={agent} onDone={() => setOpen(false)} />
        </Popover>
        {!hero && <HelperHeads helpers={helpers} />}
      </div>
      {/* A small name pill tucked over the head's chin, then one tiny grey status line (Dots). */}
      <div className="chat-head-card">
        <h1 className="chat-head-name" data-testid="agent-title">
          {agent.name}
        </h1>
        {!hero && (
          <div className="chat-head-status" role="status">
            <span
              className={cn("chat-head-line", tone === "working" && "is-live")}
              data-testid="presence-line"
              title={line}
            >
              {line}
            </span>
          </div>
        )}
      </div>
    </Tag>
  );
}

/** How long a helper's head takes to leave (styles/dots.css .chat-helper-head[data-leaving]). */
const LEAVE_MS = 220;

/**
 * The list as shown: items that just left stay a moment, marked leaving, so they go out the way they came in
 * instead of vanishing.
 */
function useLeaving<T extends { id: string }>(items: T[]): { item: T; leaving: boolean }[] {
  const [gone, setGone] = useState<T[]>([]);
  const last = useRef(items);
  useEffect(() => {
    const ids = new Set(items.map((i) => i.id));
    const left = last.current.filter((i) => !ids.has(i.id));
    last.current = items;
    if (!left.length) return;
    setGone((g) => [...g.filter((i) => !ids.has(i.id)), ...left]);
    const t = setTimeout(() => setGone((g) => g.filter((i) => !left.includes(i))), LEAVE_MS);
    return () => clearTimeout(t);
  }, [items]);
  const ids = new Set(items.map((i) => i.id));
  return [
    ...items.map((item) => ({ item, leaving: false })),
    ...gone.filter((i) => !ids.has(i.id)).map((item) => ({ item, leaving: true })),
  ];
}

/** Small helper heads tucked at the big head's lower right, popping in; each opens its workspace tab. */
function HelperHeads({ helpers }: { helpers: AgentView[] }) {
  const shown = useLeaving(helpers);
  if (!shown.length) return null;
  return (
    <div className="chat-head-helper-heads" data-testid="helper-heads">
      {shown.map(({ item: h, leaving }, i) => (
        <Tip key={h.id} label={h.preview ? `${h.name} · ${h.preview}` : h.name} side="bottom">
          <button
            type="button"
            className="chat-helper-head"
            data-testid={leaving ? undefined : "helper-head"}
            data-leaving={leaving || undefined}
            data-waiting={h.activity === "waiting" || undefined}
            style={{ animationDelay: `${i * 60}ms` }}
            aria-label={`Helper: ${h.name}`}
            aria-hidden={leaving || undefined}
            tabIndex={leaving ? -1 : undefined}
            onClick={() => ui.showTab(`helper:${h.id}`)}
          >
            <AgentAvatar agent={h} size={26} quiet />
          </button>
        </Tip>
      ))}
    </div>
  );
}
