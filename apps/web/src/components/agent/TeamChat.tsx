import type { AgentView, TimelineEntry } from "@yo/contracts";
import { ChevronRight, Users } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import { clockTime, cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { ui } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { askSummary, replySummary, type TeamReply, teamCall, teamReply } from "./team";

/** Who an agent-to-agent message names: the teammate in Yo when it can be found, else just the name. */
function useTeammate(id: string | null, name: string | null): { agent: AgentView | null; name: string } {
  const agent = useApp((s) => {
    if (id) return s.agents[id] ?? null;
    if (!name) return null;
    const q = name.trim().toLowerCase();
    const all = Object.values(s.agents);
    return (
      all.find((a) => a.name.toLowerCase() === q) ??
      all.find((a) => a.name.toLowerCase().startsWith(q)) ??
      null
    );
  });
  return { agent, name: agent?.name ?? name ?? "a teammate" };
}

/** A teammate's small face, or a people glyph when it isn't in Yo. */
function MiniFace({ who, size = 22 }: { who: AgentView | null; size?: number }) {
  return who ? (
    <AgentAvatar agent={who} size={size} quiet />
  ) : (
    <span className="chat-mini-face" style={{ width: size, height: size }}>
      <Users className="size-3" />
    </span>
  );
}

/** Exchanges whose report came in while the chat was open, not opened since: their row keeps an unread dot. */
const unopened = new Set<string>();

/**
 * Yo handing work to a specialist, as calm rows with its small face (not chat bubbles): "Asked ⟨Pepe⟩: follow up
 * pending leads", then once it reports, "⟨Pepe⟩: 3 leads followed up". A click opens the specialist's view, where the
 * whole exchange and its work are. `later`: the report that came back as its own message (async handoff).
 */
export const TeamExchange = memo(function TeamExchange({
  entry,
  reply: later,
}: {
  entry: TimelineEntry;
  reply?: TimelineEntry;
  agent: AgentView;
}) {
  const call = teamCall(entry);
  // Core's exchange (docs/one-yo.md) names the specialist and the words; older cores: read from the tool's input.
  const ex = entry.item.exchange?.direction === "to" ? entry.item.exchange : undefined;
  const reply: TeamReply = later
    ? { state: "replied", text: later.item.text ?? later.item.exchange?.text ?? "" }
    : teamReply(entry);
  const { agent: teammate, name } = useTeammate(ex?.agentId ?? call.toId, ex?.name ?? call.toName);
  const [, setSeen] = useState(0);
  // A report that lands while this row is on screen is new: dot it until it's opened.
  const was = useRef(reply.state);
  useEffect(() => {
    if ((was.current === "waiting" || was.current === "later") && reply.state === "replied") {
      unopened.add(entry.id);
      setSeen((n) => n + 1);
    }
    was.current = reply.state;
  }, [reply.state, entry.id]);
  const unread = unopened.has(entry.id);
  const open = teammate
    ? () => {
        unopened.delete(entry.id);
        setSeen((n) => n + 1);
        ui.openAgent(teammate.id);
      }
    : undefined;
  const ask = askSummary(ex?.text ?? call.message, name);
  const working = teammate?.activity === "working";
  const report =
    reply.state === "replied"
      ? replySummary(reply.text)
      : reply.state === "stopped"
        ? reply.text
          ? replySummary(reply.text)
          : "stopped before reporting back"
        : "";
  return (
    <div data-testid="team-exchange" data-state={reply.state} className="chat-exchange">
      <ExchangeRow
        who={teammate}
        onOpen={open}
        testId="team-ask-row"
        label={`${reply.state === "failed" ? "Couldn't reach" : "Asked"} ${name}${ask ? `: ${ask}` : ""}`}
      >
        <span className={cn("chat-exchange-verb", reply.state === "failed" && "text-danger")}>
          {reply.state === "failed" ? "Couldn't reach" : "Asked"}
        </span>{" "}
        <b>{name}</b>
        {ask && <span className="chat-exchange-text">: {ask}</span>}
        {(reply.state === "waiting" || reply.state === "later") && (
          <span className="chat-exchange-note shimmer-text" data-testid="team-waiting">
            · {working ? "working on it" : reply.state === "waiting" ? "waiting" : "on it"}
          </span>
        )}
      </ExchangeRow>
      {report && (
        <ExchangeRow
          who={teammate}
          onOpen={open}
          testId="team-reply-row"
          label={`${name}: ${report}`}
          tone="reply"
        >
          <b>{name}</b>
          <span className="chat-exchange-text">: {report}</span>
          {unread && (
            <i className="chat-unread-dot" data-testid="team-unread">
              <span className="sr-only">New report</span>
            </i>
          )}
        </ExchangeRow>
      )}
      {reply.state === "failed" && <div className="chat-exchange-error">{reply.text}</div>}
    </div>
  );
});

/** One calm line: the specialist's small face, then the words; a button to its view when it's on the team. */
function ExchangeRow({
  who,
  onOpen,
  testId,
  label,
  tone = "ask",
  children,
}: {
  who: AgentView | null;
  onOpen?: () => void;
  testId: string;
  label: string;
  tone?: "ask" | "reply";
  children: React.ReactNode;
}) {
  const body = (
    <>
      <MiniFace who={who} size={20} />
      <span className="chat-exchange-line">{children}</span>
      {onOpen && <ChevronRight className="chat-exchange-chevron" aria-hidden />}
    </>
  );
  return onOpen ? (
    <button
      type="button"
      className="chat-exchange-row"
      data-tone={tone}
      data-testid={testId}
      onClick={onOpen}
      title={label}
      aria-label={`${label}. View ${who?.name ?? ""}`.trim()}
    >
      {body}
    </button>
  ) : (
    <div className="chat-exchange-row" data-tone={tone} data-testid={testId} title={label}>
      {body}
    </div>
  );
}

/**
 * A teammate's message in this chat (in place of a message from the user). In Yo's chat: a specialist reporting in,
 * as the same calm row (a click opens its view). In a specialist's view: what Yo (or another teammate) asked of it,
 * in full, so you can see the work it was given.
 */
export function TeammateMessage({ entry, agent }: { entry: TimelineEntry; agent: AgentView }) {
  const ex = entry.item.exchange?.direction === "from" ? entry.item.exchange : undefined;
  const from = ex ?? entry.item.from!;
  const { agent: sender, name } = useTeammate(from.agentId, from.name);
  const full = entry.item.text ?? ex?.text ?? "";
  if (agent.isPrimary) {
    const text = replySummary(full);
    return (
      <div className="chat-exchange" data-testid="teammate-message">
        <ExchangeRow
          who={sender}
          onOpen={sender ? () => ui.openAgent(sender.id) : undefined}
          testId="team-reply-row"
          label={`${name}: ${text}`}
          tone="reply"
        >
          <b>{name}</b>
          <span className="chat-exchange-text">: {text}</span>
          <span className="sr-only">to {agent.name}</span>
        </ExchangeRow>
      </div>
    );
  }
  return (
    <div className="chat-theirs animate-rise" data-testid="teammate-message">
      <div className="chat-theirs-label">
        <MiniFace who={sender} />
        <span className="chat-theirs-name">{sender?.isPrimary ? `${name} asked` : name}</span>
        <span className="sr-only">to {agent.name}</span>
        <span>· {clockTime(entry.createdAt)}</span>
      </div>
      <div className="chat-theirs-bubble">{full}</div>
    </div>
  );
}
