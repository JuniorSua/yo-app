import { type AgentView, STEERED_TITLE, type TimelineEntry } from "@yo/contracts";
import { ArrowDown, Paperclip, Zap } from "lucide-react";
import { Fragment, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import { shortDuration } from "../../lib/connection";
import { linkify } from "../../lib/linkify";
import { quoteBlocks } from "../../lib/quotes";
import { useNow } from "../../lib/useNow";
import { clockTime, cn, dayLabel, modKey } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { useTimeline } from "../../stores/timeline";
import { useUI } from "../../stores/ui";
import { ActivityGroup } from "../cards/ActivityGroup";
import { ArtifactCard, NoticeRow, TodoCard } from "../cards/MiscCards";
import { ApprovalCard, AskUserCard } from "../cards/RequestCards";
import { CopyButton } from "../ui/CopyButton";
import { BriefCard } from "./BriefCard";
import { BugReportBlock, BugTurnBadge } from "./BugReport";
import {
  type Block,
  bugTurnBlocks,
  LONG_TURN_MS,
  replyChipsAt,
  timeBreaks,
  toBlocks,
  workingRow,
} from "./blocks";
import { ChatImage } from "./ChatImage";
import { composerBus } from "./Composer";
import { HelperCard } from "./HelperCard";
import { CHAT_MD, MD_PLUGINS } from "./markdown";
import { PageCard } from "./Pages";
import { ReplyChips } from "./ReplyChips";
import { TeamExchange, TeammateMessage } from "./TeamChat";
import { countNewMessages, firstUnreadKey } from "./unread";

const AssistantText = memo(function AssistantText({
  text,
  streaming,
  agentId,
  entryId,
  images,
}: {
  text: string;
  streaming: boolean;
  agentId: string;
  entryId: string;
  images?: Record<string, string>;
}) {
  return (
    <div className={cn("chat-reply prose-yo", streaming && "streaming")} data-testid="assistant-message">
      {text ? (
        <Markdown
          remarkPlugins={MD_PLUGINS}
          components={{
            ...CHAT_MD,
            img: ({ src, alt }) => (
              <ChatImage
                agentId={agentId}
                src={typeof src === "string" ? src : undefined}
                alt={alt}
                snapshot={typeof src === "string" ? images?.[src] : undefined}
                version={entryId}
              />
            ),
          }}
        >
          {text}
        </Markdown>
      ) : (
        <p className="stream-caret" />
      )}
      {/* Once the reply is finished, one click copies all of it (as written, Markdown and all). */}
      {text && !streaming && (
        <div className="chat-reply-actions">
          <CopyButton text={text} label="Copy reply" showLabel={false} testId="copy-reply" />
        </div>
      )}
    </div>
  );
});

/** Where a bubble sits in a run of your messages: the corners that join the next one tighten. */
type BubbleGroup = "single" | "first" | "middle" | "last";

function UserBubble({ entry, group }: { entry: TimelineEntry; group: BubbleGroup }) {
  const atts = (entry.item.input as { attachments?: { name: string }[] } | undefined)?.attachments ?? [];
  return (
    <div className="chat-mine animate-rise" data-testid="user-message">
      {entry.item.title === STEERED_TITLE && (
        <span className="chat-mine-label" data-testid="steered-label">
          <Zap className="size-3" />
          Sent mid-task
        </span>
      )}
      {atts.length > 0 && (
        <div className="chat-mine-files">
          {atts.map((a) => (
            <span key={a.name} className="chat-file-chip">
              <Paperclip className="size-3 shrink-0" />
              <span className="truncate" title={a.name}>
                {a.name}
              </span>
            </span>
          ))}
        </div>
      )}
      {/* Long links and words wrap inside the bubble instead of running past it. */}
      <div className="chat-bubble" data-group={group}>
        {/* Lines that start with ">" show as a quote, like in Markdown. */}
        {quoteBlocks(entry.item.text ?? "").map((b, i) =>
          b.quote ? (
            <blockquote key={i} data-testid="user-quote">
              <Linked text={b.text} />
            </blockquote>
          ) : (
            <Fragment key={i}>
              <Linked text={b.text} />
            </Fragment>
          ),
        )}
      </div>
    </div>
  );
}

/** Typed text with its web links as links. */
function Linked({ text }: { text: string }) {
  return linkify(text).map((part, i) =>
    part.href ? (
      <a key={i} href={part.href} target="_blank" rel="noreferrer noopener">
        {part.text}
      </a>
    ) : (
      part.text
    ),
  );
}

function firstEntry(b: Block): TimelineEntry {
  return b.type === "group" ? b.entries[0]! : b.entry;
}

function BlockView({
  block,
  agent,
  live,
  group,
}: {
  block: Block;
  agent: AgentView;
  live: boolean;
  group: BubbleGroup;
}) {
  switch (block.type) {
    case "user":
      return block.entry.item.from ? (
        <TeammateMessage entry={block.entry} agent={agent} />
      ) : (
        <UserBubble entry={block.entry} group={group} />
      );
    case "team":
      return <TeamExchange entry={block.entry} reply={block.reply} agent={agent} />;
    case "helper":
      return <HelperCard entry={block.entry} />;
    case "assistant":
      return (
        <AssistantText
          text={block.entry.item.text ?? ""}
          streaming={block.entry.item.status === "running"}
          agentId={agent.id}
          entryId={block.entry.id}
          images={block.entry.item.images}
        />
      );
    case "group":
      return <ActivityGroup entries={block.entries} live={live} />;
    case "todo":
      return <TodoCard entry={block.entry} />;
    case "artifact":
      return <ArtifactCard entry={block.entry} />;
    case "page":
      return (
        <PageCard
          artifactId={block.artifactId}
          title={(block.entry.item.input as { title?: string } | undefined)?.title}
        />
      );
    case "bug":
      return <BugReportBlock entry={block.entry} bug={block.bug} live={live} />;
    case "brief":
      return <BriefCard entry={block.entry} brief={block.brief} />;
    case "notice":
      return <NoticeRow entry={block.entry} />;
    case "request":
      return block.entry.request?.kind === "user_input" ? (
        <AskUserCard entry={block.entry} agentName={agent.name} />
      ) : (
        <ApprovalCard entry={block.entry} agentName={agent.name} />
      );
  }
}

/** The props a row reads from the agent. Pushes replace the agent object often (its preview line changes). */
function sameAgent(a: AgentView, b: AgentView) {
  return (
    a === b ||
    (a.id === b.id &&
      a.name === b.name &&
      a.activity === b.activity &&
      a.isPrimary === b.isPrimary &&
      a.computer.state === b.computer.state &&
      (a.avatar === b.avatar || JSON.stringify(a.avatar) === JSON.stringify(b.avatar)))
  );
}

/** Blocks are rebuilt on every change, but their entries keep their identity until they change. */
function sameBlock(a: Block, b: Block) {
  if (a === b) return true;
  if (a.type !== b.type || a.key !== b.key) return false;
  if (a.type === "group" && b.type === "group")
    return a.entries.length === b.entries.length && a.entries.every((e, i) => e === b.entries[i]);
  if (a.type === "group" || b.type === "group" || a.entry !== b.entry) return false;
  if (a.type === "team" && b.type === "team") return a.reply === b.reply;
  if (a.type === "bug" && b.type === "bug")
    return (
      a.bug.stage === b.bug.stage &&
      a.bug.draftId === b.bug.draftId &&
      a.bug.related === b.bug.related &&
      a.bug.answered === b.bug.answered &&
      a.bug.latest === b.bug.latest
    );
  return true;
}

interface RowProps {
  block: Block;
  agent: AgentView;
  live: boolean;
  /** Starts a response that reports a bug: it carries the "Bug report" badge. */
  header: boolean;
  /** Part of a response that reports a bug (and whether the blocks around it are too). */
  bug: boolean;
  bugAbove: boolean;
  bugBelow: boolean;
  /** For your messages: where this one sits in a run of them. */
  group: BubbleGroup;
}

/**
 * One block of the chat. Memoized so a streaming reply re-renders only its own row, not the whole history.
 * A 1:1 chat doesn't repeat the agent's name and face over every reply: the head above says who it is.
 */
const TimelineRow = memo(
  function TimelineRow({ block: b, agent, live, header, bug, bugAbove, bugBelow, group }: RowProps) {
    return (
      <div
        data-entry-id={firstEntry(b).id}
        data-bug-turn={bug || undefined}
        data-kind={b.type === "user" && b.entry.item.from ? "teammate" : b.type}
        data-group={b.type === "user" && !b.entry.item.from ? group : undefined}
        className={cn(
          "chat-row",
          bug &&
            "relative before:absolute before:left-[-14px] before:w-[2px] before:rounded-full before:bg-danger/55",
          bug && (bugAbove ? "before:-top-2" : "before:top-0"),
          bug && (bugBelow ? "before:-bottom-2" : "before:bottom-0"),
        )}
      >
        {header && bug && (
          <div className="chat-turn-badge">
            <BugTurnBadge />
          </div>
        )}
        <BlockView block={b} agent={agent} live={live} group={group} />
      </div>
    );
  },
  (a, b) =>
    a.live === b.live &&
    a.header === b.header &&
    a.group === b.group &&
    a.bug === b.bug &&
    a.bugAbove === b.bugAbove &&
    a.bugBelow === b.bugBelow &&
    sameBlock(a.block, b.block) &&
    sameAgent(a.agent, b.agent),
);

/**
 * The agent is busy but nothing below shows progress (it's thinking before its first step, or between steps):
 * say what it's on and for how long, and after a long while how to steer or stop it.
 */
function WorkingRow({ agent, since, delayed }: { agent: AgentView; since: number | null; delayed: boolean }) {
  const now = useNow(1000);
  const elapsed = since ? now - since : 0;
  // Between two steps the row would flash for a moment; it only matters once the pause is noticeable.
  const [shown, setShown] = useState(!delayed);
  useEffect(() => {
    if (shown) return;
    const t = setTimeout(() => setShown(true), 2500);
    return () => clearTimeout(t);
  }, [shown]);
  if (!shown) return null;
  return (
    <div className="chat-working" data-testid="working-row" role="status">
      <div className="chat-working-line">
        <span className="chat-live-dot" aria-hidden />
        <span className="min-w-0 truncate">{agent.preview || `${agent.name} is thinking it through…`}</span>
        {since && elapsed >= 5000 && (
          <span className="shrink-0 tabular-nums" data-testid="working-elapsed">
            · {shortDuration(elapsed)}
          </span>
        )}
      </div>
      {elapsed >= LONG_TURN_MS && (
        <div className="chat-working-hint" data-testid="working-hint">
          Taking a while. Type a message and press {modKey} Enter to steer {agent.name}, or press Stop to end
          this task.
        </div>
      )}
    </div>
  );
}

/** "Today 9:41 AM" over a stretch of the chat. */
function TimeBreak({ at }: { at: number }) {
  const day = dayLabel(at);
  return (
    <div className="chat-time" role="separator" aria-label={`${day} ${clockTime(at)}`}>
      {day}
      {day.includes(",") ? "," : ""} {clockTime(at)}
    </div>
  );
}

/** Where the user left off: the replies below came while they were away. */
function UnreadDivider() {
  return (
    <div
      className="chat-unread"
      data-testid="unread-divider"
      role="separator"
      aria-label="New messages since you last looked"
    >
      <span aria-hidden />
      New
    </div>
  );
}

export function Timeline({
  agent,
  entries,
  unreadAtOpen = 0,
}: {
  agent: AgentView;
  entries: TimelineEntry[];
  /** How many finished tasks were unread when the user opened this chat (see AgentPage). */
  unreadAtOpen?: number;
}) {
  const focused = useUI((s) => s.focusEntryId);
  const blocks = useMemo(() => toBlocks(entries), [entries]);
  // Quick replies of the latest turn, and the one the user tapped (kept chosen until the agent answers it).
  const [tapped, setTapped] = useState<{ entryId: string; text: string } | null>(null);
  const chips = useMemo(() => replyChipsAt(entries, tapped), [entries, tapped]);
  const pick = (text: string) => {
    if (!chips || !composerBus.sendPlain) return;
    setTapped({ entryId: chips.entryId, text });
    composerBus.sendPlain(text);
  };
  const chipRow = chips && (
    <div className="chat-chips-row" key={`chips_${chips.entryId}`}>
      <ReplyChips replies={chips.replies} chosen={chips.chosen} onPick={pick} />
    </div>
  );
  const bugTurn = useMemo(() => bugTurnBlocks(blocks), [blocks]);
  const breaks = useMemo(() => timeBreaks(blocks), [blocks]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  // Replies and cards that came in while scrolled up (the pill counts them), by the blocks already seen.
  const seen = useRef(new Set<string>());
  const [fresh, setFresh] = useState(0);
  const loaded = useTimeline((s) => !!s.loaded[agent.id]);
  const working = agent.activity === "working" || agent.activity === "waiting";
  const [divider, setDivider] = useState<{ agentId: string; key: string | null } | null>(null);
  // "Needs you" shows its own card; the row is for plain busy (and, as before, a question not yet picked up).
  // When this app saw the agent get busy; the chat's own reading is the fallback.
  const busySince = useApp((s) => s.workingSince[agent.id]);
  const busyRow =
    agent.activity === "working" || (working && blocks[blocks.length - 1]?.type === "user")
      ? workingRow(blocks)
      : null;

  const lastLen = entries.length
    ? `${entries.length}:${(entries[entries.length - 1]!.item.text ?? "").length}`
    : "0";

  const seeAll = () => {
    for (const b of blocks) seen.current.add(b.key);
    setFresh(0);
  };

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) {
      el.scrollTop = el.scrollHeight;
      seeAll();
    } else {
      setShowJump(true);
      setFresh(countNewMessages(blocks, seen.current));
    }
  }, [lastLen, blocks.length]);

  // Once the chat has loaded, mark where the replies that came while the user was away start (once per visit).
  useLayoutEffect(() => {
    if (!loaded || divider?.agentId === agent.id) return;
    setDivider({ agentId: agent.id, key: firstUnreadKey(blocks, unreadAtOpen) });
  }, [loaded, agent.id, blocks, divider]);
  const newFrom = divider?.agentId === agent.id ? divider.key : null;

  // Stay at the bottom while content grows on its own (a picture finishing loading, a card expanding).
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(inner);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Jump to the bottom when switching agents.
  useEffect(() => {
    stick.current = true;
    setShowJump(false);
    seen.current = new Set(blocks.map((b) => b.key));
    setFresh(0);
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.id]);

  useEffect(() => {
    if (!focused) return;
    const target = content.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(focused)}"]`);
    if (!target) return;
    stick.current = false;
    target.scrollIntoView({ block: "center" });
    target.classList.add("workspace-highlight");
    setShowJump(true);
    return () => target.classList.remove("workspace-highlight");
  }, [focused, agent.id, blocks]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only scrolling up lets go of the bottom. Content growing below (a picture loading right after we scrolled
    // down) also leaves us "not near", but that isn't the user leaving.
    if (near) stick.current = true;
    else if (el.scrollTop < lastTop.current) stick.current = false;
    lastTop.current = el.scrollTop;
    if (near) {
      setShowJump(false);
      seeAll();
    }
  };

  const jump = () => {
    useUI.setState({ focusEntryId: null });
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
    seeAll();
  };

  const newLabel = `${fresh} new message${fresh === 1 ? "" : "s"}`;

  // A "response" starts at the first non-user block after a user message.
  let prevWasUser = true;
  const lastTurnStart = (() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.type === "user") return i;
    return -1;
  })();
  // Your messages in a row join up (no time, divider or chips between them).
  const mine = (i: number) => {
    const b = blocks[i];
    return !!b && b.type === "user" && !b.entry.item.from;
  };
  const joins = (i: number) =>
    mine(i) &&
    mine(i - 1) &&
    !breaks.has(i) &&
    blocks[i]!.key !== newFrom &&
    chips?.before !== firstEntry(blocks[i]!).id;

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="timeline"
        className="scroll-fade h-full overflow-y-auto [--scroll-fade:56px]"
      >
        <div ref={content} className="chat-feed">
          {blocks.map((b, i) => {
            const isUser = b.type === "user";
            const isNotice = b.type === "notice" && b.entry.item.status !== "failed";
            const header = !isUser && !isNotice && prevWasUser;
            if (isUser) prevWasUser = true;
            else if (!isNotice) prevWasUser = false;
            const up = joins(i);
            const down = joins(i + 1);
            const group: BubbleGroup = up ? (down ? "middle" : "last") : down ? "first" : "single";
            // A response that reports a bug gets a red rule down its left edge (in the gutter, so nothing shifts).
            return (
              <Fragment key={b.key}>
                {chips?.before && chips.before === firstEntry(b).id && chipRow}
                {breaks.has(i) && <TimeBreak at={firstEntry(b).createdAt} />}
                {b.key === newFrom && <UnreadDivider />}
                <TimelineRow
                  block={b}
                  agent={agent}
                  live={working && i > lastTurnStart}
                  header={header}
                  bug={bugTurn.has(i)}
                  bugAbove={bugTurn.has(i - 1)}
                  bugBelow={bugTurn.has(i + 1)}
                  group={group}
                />
              </Fragment>
            );
          })}
          {chips && !chips.before && chipRow}
          {busyRow && (
            <WorkingRow
              agent={agent}
              since={busySince ?? busyRow.since}
              delayed={blocks[blocks.length - 1]?.type !== "user"}
            />
          )}
        </div>
      </div>
      {showJump && (
        <button
          onClick={jump}
          data-testid="jump-latest"
          aria-label={fresh ? `${newLabel}. Jump to latest` : "Jump to latest"}
          className="chat-jump animate-rise"
        >
          <ArrowDown className="size-3.5" />
          {fresh ? newLabel : "Jump to latest"}
        </button>
      )}
    </div>
  );
}
