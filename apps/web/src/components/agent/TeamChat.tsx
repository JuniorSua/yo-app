import type { AgentView, TimelineEntry } from "@yo/contracts";
import { ArrowRight, ChevronDown, Hourglass, OctagonX, Send, Users } from "lucide-react";
import { memo, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { clockTime, cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { ui } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { CHAT_MD, MD_PLUGINS } from "./markdown";
import { type TeamReply, teamCall, teamReply } from "./team";

/** Replies longer than this start folded (the full text is one click away). */
const FOLD_CHARS = 700;

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

function SmallMarkdown({ text }: { text: string }) {
  return (
    <div className="prose-yo prose-team">
      <Markdown remarkPlugins={MD_PLUGINS} components={CHAT_MD}>
        {text}
      </Markdown>
    </div>
  );
}

/** A teammate's small face, or a people glyph when it isn't in Yo. */
function MiniFace({ who, size = 18 }: { who: AgentView | null; size?: number }) {
  return who ? (
    <AgentAvatar agent={who} size={size} quiet />
  ) : (
    <span className="chat-mini-face" style={{ width: size, height: size }}>
      <Users className="size-3" />
    </span>
  );
}

/** One side of the opened exchange: a small face and name over the message. */
function Turn({
  who,
  name,
  to,
  time,
  tone,
  children,
}: {
  who: AgentView | null;
  name: string;
  to?: string;
  time?: number;
  tone: "ask" | "reply";
  children: React.ReactNode;
}) {
  return (
    <div className="chat-team-turn" data-testid={`team-${tone}`}>
      <div className="chat-team-who">
        <MiniFace who={who} size={16} />
        <span className="chat-team-name">{name}</span>
        {to && (
          <>
            <ArrowRight className="size-3" aria-label="to" />
            <span>{to}</span>
          </>
        )}
        {time !== undefined && <span className="chat-team-time">{clockTime(time)}</span>}
      </div>
      <div className="chat-team-text">{children}</div>
    </div>
  );
}

function ReplyBody({
  reply,
  name,
  teammate,
}: {
  reply: TeamReply;
  name: string;
  teammate: AgentView | null;
}) {
  const [open, setOpen] = useState(false);
  switch (reply.state) {
    case "waiting":
      return (
        <div className="shimmer-text" data-testid="team-waiting">
          {teammate?.activity === "working" && teammate.preview
            ? teammate.preview
            : `Waiting for ${name} to reply…`}
        </div>
      );
    case "replied": {
      const long = reply.text.length > FOLD_CHARS;
      return (
        <div>
          <div className={cn("relative", long && !open && "chat-team-folded")}>
            <SmallMarkdown text={reply.text} />
          </div>
          {long && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="chat-text-button">
              <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              {open ? "Show less" : "Show the whole reply"}
            </button>
          )}
        </div>
      );
    }
    case "stopped":
      return (
        <div className="text-muted">
          <div className="flex items-center gap-1.5">
            <OctagonX className="size-3.5" /> Stopped before {name} replied.
          </div>
          {reply.text && (
            <div className="mt-1.5">
              <SmallMarkdown text={reply.text} />
            </div>
          )}
        </div>
      );
    case "failed":
      return <div className="whitespace-pre-wrap text-danger">{reply.text}</div>;
    default:
      return null;
  }
}

/** Exchanges whose reply came in while the chat was open, not opened since: their row keeps an unread dot. */
const unopened = new Set<string>();

/**
 * The asking agent's side of a team handoff, as one quiet row: "Messaged ⟨Dew⟩" while it waits, then
 * "2 messages with ⟨Dew⟩" (with a dot until you look) once the reply is in. A click opens the exchange.
 * `later`: the teammate's reply that came back as its own message (async handoff), folded in here.
 */
export const TeamExchange = memo(function TeamExchange({
  entry,
  reply: later,
  agent,
}: {
  entry: TimelineEntry;
  reply?: TimelineEntry;
  agent: AgentView;
}) {
  const call = teamCall(entry);
  const reply: TeamReply = later ? { state: "replied", text: later.item.text ?? "" } : teamReply(entry);
  const { agent: teammate, name } = useTeammate(call.toId, call.toName);
  const [open, setOpen] = useState(false);
  const [, setSeen] = useState(0);
  // A reply that lands while this row is on screen is new: dot it until the row is opened.
  const was = useRef(reply.state);
  useEffect(() => {
    if ((was.current === "waiting" || was.current === "later") && reply.state === "replied") {
      unopened.add(entry.id);
      setSeen((n) => n + 1);
    }
    was.current = reply.state;
  }, [reply.state, entry.id]);
  const unread = unopened.has(entry.id) && !open;
  const toggle = () => {
    unopened.delete(entry.id);
    setOpen((o) => !o);
  };
  const footnote =
    reply.state === "delivered"
      ? call.legacy
        ? `Sent with Claude's built-in messaging, so ${name}'s answer isn't shown here.`
        : `Delivered. ${name} isn't expected to reply.`
      : reply.state === "later"
        ? `${name} is on it. The reply comes here when they finish.`
        : null;
  const showReply = reply.state !== "delivered" && reply.state !== "later";
  const count = reply.state === "replied" || (reply.state === "stopped" && reply.text) ? 2 : 1;
  const face = (
    <span className="chat-handoff-who">
      <MiniFace who={teammate} />
      {name}
    </span>
  );
  return (
    <div data-testid="team-exchange" data-state={reply.state} className="chat-handoff">
      <button
        type="button"
        className="chat-handoff-row"
        onClick={toggle}
        aria-expanded={open}
        data-testid="team-toggle"
      >
        {reply.state === "failed" ? (
          <span className="text-danger">Couldn't message</span>
        ) : count === 2 ? (
          <span>2 messages with</span>
        ) : (
          <span>Messaged</span>
        )}
        {face}
        {reply.state === "waiting" && (
          <span className="chat-handoff-note shimmer-text">· waiting for a reply</span>
        )}
        {reply.state === "later" && teammate?.activity === "working" && (
          <span className="chat-handoff-note shimmer-text">· working on it</span>
        )}
        {reply.state === "stopped" && <span className="chat-handoff-note">· stopped</span>}
        {unread && (
          <i className="chat-unread-dot" data-testid="team-unread">
            <span className="sr-only">New reply</span>
          </i>
        )}
        <ChevronDown className={cn("chat-handoff-chevron", open && "rotate-180")} aria-hidden />
      </button>
      {open && (
        <div className="chat-handoff-body animate-rise">
          <Turn who={agent} name={agent.name} to={name} time={entry.createdAt} tone="ask">
            <div className="whitespace-pre-wrap">{call.message || "…"}</div>
          </Turn>
          {showReply && (
            <Turn who={teammate} name={name} time={later?.createdAt} tone="reply">
              <ReplyBody reply={reply} name={name} teammate={teammate} />
            </Turn>
          )}
          <div className="chat-handoff-foot">
            {footnote && (
              <span className="flex items-center gap-1.5">
                {reply.state === "later" ? <Hourglass className="size-3" /> : <Send className="size-3" />}
                {footnote}
              </span>
            )}
            <span className="flex-1" />
            {teammate && (
              <button
                type="button"
                onClick={() => ui.openAgent(teammate.id)}
                className="chat-text-button"
                data-testid="team-open"
              >
                Open {teammate.name}'s chat
                <ArrowRight className="size-3" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

/** The other side: a teammate's message in this agent's chat (in place of a message from the user). */
export function TeammateMessage({ entry, agent }: { entry: TimelineEntry; agent: AgentView }) {
  const from = entry.item.from!;
  const { agent: sender, name } = useTeammate(from.agentId, from.name);
  return (
    <div className="chat-theirs animate-rise" data-testid="teammate-message">
      <div className="chat-theirs-label">
        <MiniFace who={sender} />
        {sender ? (
          <button type="button" onClick={() => ui.openAgent(sender.id)} className="chat-theirs-name">
            {name}
          </button>
        ) : (
          <span className="chat-theirs-name">{name}</span>
        )}
        <span className="sr-only">to {agent.name}</span>
        <span>· {clockTime(entry.createdAt)}</span>
      </div>
      <div className="chat-theirs-bubble">{entry.item.text}</div>
    </div>
  );
}
