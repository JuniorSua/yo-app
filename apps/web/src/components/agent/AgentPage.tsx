import { type AgentView, isLead, type TimelineEntry } from "@yo/contracts";
import {
  CalendarClock,
  CloudOff,
  Gift,
  Phone,
  Plane,
  RotateCw,
  Search,
  ShoppingBag,
  Sun,
  UtensilsCrossed,
} from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { accentVars } from "../../lib/accent";
import { api } from "../../lib/api";
import { useMorningBriefClaim } from "../../lib/brief";
import { useApp } from "../../stores/app";
import { useTimeline } from "../../stores/timeline";
import { useUI } from "../../stores/ui";
import { SetupBanner, SetupChat, useSetupChat } from "../setup/SetupChat";
import { Button } from "../ui/button";
import { Spinner } from "../ui/controls";
import { Composer, composerBus } from "./Composer";
import { ChatBar, PresenceHeader } from "./Presence";
import { usePaintedTheme } from "./paintedTheme";
import { Timeline } from "./Timeline";

const SUGGESTIONS = [
  { icon: Plane, text: "Find me a flight to Lisbon in October" },
  { icon: Search, text: "Research the best standing desks under $600" },
  { icon: CalendarClock, text: "Every morning, summarize the top AI news for me" },
  { icon: ShoppingBag, text: "Buy me a USB-C charging cable under $15" },
];

/** Personal time: life outside work. */
const HOME_SUGGESTIONS = [
  { icon: Sun, text: "Plan my weekend" },
  { icon: Gift, text: "Gift ideas for a friend's birthday" },
  { icon: Phone, text: "Remind me to call Mom Sunday" },
  { icon: UtensilsCrossed, text: "Find a cozy dinner spot for Friday" },
];

/** "Morning" / "Afternoon" / "Evening" in the owner's time zone ("Hi" in the small hours). */
export function partOfDay(now: number, tz: string): string {
  let hour = new Date(now).getHours();
  try {
    hour = Number(
      new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now),
    );
  } catch {
    /* the device's clock */
  }
  if (hour >= 5 && hour < 12) return "Morning";
  if (hour >= 12 && hour < 17) return "Afternoon";
  if (hour >= 17 && hour < 23) return "Evening";
  return "Hi";
}

/** "deep research & sourcing" → "Deep research & sourcing." */
function sentence(text: string): string {
  const t = text.trim().replace(/\.$/, "");
  return t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}.` : "";
}

function EmptyState({ agent }: { agent: AgentView }) {
  const userName = useApp((s) => s.settings.userName).trim();
  const tz = useApp((s) => s.settings.timezone);
  const home = agent.space === "personal";
  const suggestions = (home ? HOME_SUGGESTIONS : SUGGESTIONS).slice(0, 3);
  const part = partOfDay(Date.now(), tz);
  // "Afternoon, Sam." With no name: "Good afternoon." ("Hi there." in the small hours).
  const greeting = userName
    ? `${part}, ${userName}.`
    : part === "Hi"
      ? "Hi there."
      : `Good ${part.toLowerCase()}.`;
  return (
    <div className="chat-empty scroll-fade" data-testid="empty-state">
      <div className="chat-empty-inner animate-rise">
        <PresenceHeader agent={agent} hero />
        <h2 className="chat-empty-title">Hi, I'm {agent.name}.</h2>
        <p className="chat-empty-text">
          {greeting}{" "}
          {home
            ? "Off the clock, I'm here for the rest of life: plans, errands, family and fun."
            : isLead(agent)
              ? "I work on my own computer, with my own browser. Tell me what you need done and I'll check in when it matters."
              : `${sentence(agent.role)} I work on my own computer and ask before anything important.`}
        </p>
        <div className="chat-empty-chips">
          {suggestions.map((s, i) => (
            <button
              key={s.text}
              type="button"
              data-testid="suggestion"
              onClick={() => composerBus.send?.(s.text)}
              style={{ animationDelay: `${80 + i * 40}ms` }}
              className="chat-suggestion animate-rise"
            >
              <s.icon aria-hidden />
              {s.text}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The conversation couldn't be loaded: say so and offer a retry, instead of a spinner that never ends. */
function LoadFailed({
  agentName,
  error,
  onRetry,
}: {
  agentName: string;
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center px-6" data-testid="timeline-load-failed" role="alert">
      <div className="flex max-w-sm flex-col items-center text-center">
        <div className="mb-3 grid size-11 place-items-center rounded-2xl bg-active text-muted">
          <CloudOff className="size-5" />
        </div>
        <div className="font-medium">Couldn't load your chat with {agentName}</div>
        <div className="mt-1 text-muted text-sm">{error}</div>
        <Button className="mt-4" onClick={onRetry} data-testid="timeline-retry">
          <RotateCw className="size-3.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}

/**
 * Some of the chat is on screen (from before a reconnect, or messages that arrived since) but the full
 * conversation didn't load: keep it readable, say it may be out of date, and offer a retry.
 */
function StaleWarning({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="shrink-0 px-7 pt-3">
      <div
        className="mx-auto flex w-full max-w-[720px] items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 px-3.5 py-2 text-sm"
        data-testid="timeline-stale"
        role="alert"
      >
        <CloudOff className="size-4 shrink-0 text-warning" />
        <span className="min-w-0 flex-1">
          This chat may be missing recent messages. <span className="text-muted">{error}</span>
        </span>
        <Button size="sm" onClick={onRetry} data-testid="timeline-stale-retry">
          <RotateCw className="size-3.5" />
          Try again
        </Button>
      </div>
    </div>
  );
}

const NO_ENTRIES: TimelineEntry[] = [];

/** Subscribes to the timeline itself, so streamed text re-renders the chat but not the header and composer. */
function AgentTimeline({ agent, unreadAtOpen }: { agent: AgentView; unreadAtOpen: number }) {
  const entries = useTimeline((s) => s.byAgent[agent.id]);
  return <Timeline agent={agent} entries={entries ?? NO_ENTRIES} unreadAtOpen={unreadAtOpen} />;
}

export function AgentPage() {
  const agentId = useUI((s) => s.agentId);
  const agent = useApp((s) => (agentId ? s.agents[agentId] : undefined));
  const hasEntries = useTimeline((s) => !!agentId && (s.byAgent[agentId]?.length ?? 0) > 0);
  const loaded = useTimeline((s) => (agentId ? s.loaded[agentId] : false));
  const loadError = useTimeline((s) => (agentId ? s.errors[agentId] : undefined));
  const setupChat = useSetupChat(agent);
  // The agent's colour tints its own chat: your bubbles, the send button, its unread dots.
  const theme = usePaintedTheme();
  const avatar = agent?.avatar;
  const primary = !!agent?.isPrimary;
  const accent = useMemo(
    () => (avatar ? accentVars(avatar, theme, { primary }) : undefined),
    [avatar, theme, primary],
  );
  // The first time today the active space's main agent's chat opens, it may post the morning brief.
  useMorningBriefClaim(agent, !!loaded && !setupChat);
  // How many finished tasks were unread on opening the chat, read before it's marked read below: the chat draws a
  // "New" line above them. Not while the agent is still on a task: that one isn't counted yet, so the count
  // can't be matched to the chat.
  const opened = useRef({ agentId: "", unread: 0 });
  if (agent && opened.current.agentId !== agent.id)
    opened.current = {
      agentId: agent.id,
      unread: agent.activity === "working" || agent.activity === "waiting" ? 0 : agent.unread,
    };

  useEffect(() => {
    if (!agentId) return;
    void useTimeline.getState().load(agentId);
    const a = useApp.getState().agents[agentId];
    if (a?.unread)
      api()
        .call("agent.markRead", { id: agentId })
        .catch(() => undefined);
  }, [agentId]);

  if (!agent) return null;
  const empty = loaded && !hasEntries;
  // An empty chat shows the agent's head big, in the middle, with its greeting.
  const hero = empty && !setupChat;

  return (
    <div className="flex h-full min-h-0">
      <div className="chat chat-column air-page flex min-w-0 flex-1 flex-col" style={accent}>
        <div className="chat-top">
          <ChatBar agent={agent} />
          {!hero && <PresenceHeader agent={agent} />}
        </div>
        {/* First run: the agent sets up its own computer (components/setup). */}
        {setupChat ? (
          <SetupChat agent={agent} />
        ) : !loaded && !hasEntries && loadError ? (
          <LoadFailed
            agentName={agent.name}
            error={loadError}
            onRetry={() => useTimeline.getState().load(agent.id)}
          />
        ) : !loaded && !hasEntries ? (
          // After a reconnect the conversation reloads with what was on screen kept in view, not a spinner.
          <div className="grid flex-1 place-items-center text-muted" role="status" aria-label="Loading">
            <Spinner className="size-5" />
          </div>
        ) : empty ? (
          <EmptyState agent={agent} />
        ) : (
          <>
            {loadError && (
              <StaleWarning error={loadError} onRetry={() => useTimeline.getState().load(agent.id, true)} />
            )}
            <AgentTimeline agent={agent} unreadAtOpen={opened.current.unread} />
          </>
        )}
        {!setupChat && <SetupBanner />}
        {!setupChat && <Composer agent={agent} />}
      </div>
    </div>
  );
}
