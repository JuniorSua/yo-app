import type { AgentView, TimelineEntry } from "@yo/contracts";
import { ArrowDown, Paperclip } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { clockTime, cn } from "../../lib/utils";
import { AgentAvatar } from "../brand";
import { ActivityGroup } from "../cards/ActivityGroup";
import { ArtifactCard, NoticeRow, TodoCard } from "../cards/MiscCards";
import { ApprovalCard, AskUserCard } from "../cards/RequestCards";
import { BugReportBlock, BugTurnBadge } from "./BugReport";
import { type Block, bugTurnBlocks, toBlocks } from "./blocks";
import { ChatImage } from "./ChatImage";

const MD_PLUGINS = [remarkGfm];

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
    <div className={cn("prose-yo", streaming && "streaming")} data-testid="assistant-message">
      {text ? (
        <Markdown
          remarkPlugins={MD_PLUGINS}
          components={{
            a: ({ node: _n, ...p }) => <a {...p} target="_blank" rel="noreferrer" />,
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
    </div>
  );
});

function UserBubble({ entry }: { entry: TimelineEntry }) {
  const atts = (entry.item.input as { attachments?: { name: string }[] } | undefined)?.attachments ?? [];
  return (
    <div className="flex flex-col items-end gap-1.5 animate-rise" data-testid="user-message">
      {atts.length > 0 && (
        <div className="flex flex-wrap justify-end gap-1.5">
          {atts.map((a) => (
            <span
              key={a.name}
              className="flex items-center gap-1.5 rounded-lg border border-border bg-card px-2 py-1 text-xs text-fg-2"
            >
              <Paperclip className="size-3 text-muted" />
              {a.name}
            </span>
          ))}
        </div>
      )}
      <div className="max-w-[80%] whitespace-pre-wrap rounded-[18px] rounded-br-[5px] bg-bubble px-4.5 py-3 text-[15px] leading-[1.6]">
        {entry.item.text}
      </div>
    </div>
  );
}

function ResponseHeader({ agent, entry, bug }: { agent: AgentView; entry: TimelineEntry; bug?: boolean }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <AgentAvatar agent={agent} size={22} state={agent.activity === "working" ? "working" : "idle"} quiet />
      <span className="font-medium">{agent.name}</span>
      <span className="text-faint text-xs">{clockTime(entry.createdAt)}</span>
      {bug && <BugTurnBadge />}
    </div>
  );
}

function firstEntry(b: Block): TimelineEntry {
  return b.type === "group" ? b.entries[0]! : b.entry;
}

function BlockView({ block, agent, live }: { block: Block; agent: AgentView; live: boolean }) {
  switch (block.type) {
    case "user":
      return <UserBubble entry={block.entry} />;
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
    case "bug":
      return <BugReportBlock entry={block.entry} bug={block.bug} live={live} />;
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

export function Timeline({ agent, entries }: { agent: AgentView; entries: TimelineEntry[] }) {
  const blocks = useMemo(() => toBlocks(entries), [entries]);
  const bugTurn = useMemo(() => bugTurnBlocks(blocks), [blocks]);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const lastTop = useRef(0);
  const [showJump, setShowJump] = useState(false);
  const working = agent.activity === "working" || agent.activity === "waiting";

  const lastLen = entries.length
    ? `${entries.length}:${(entries[entries.length - 1]!.item.text ?? "").length}`
    : "0";

  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (stick.current) el.scrollTop = el.scrollHeight;
    else setShowJump(true);
  }, [lastLen, blocks.length]);

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
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [agent.id]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    // Only scrolling up lets go of the bottom. Content growing below (a picture loading right after we scrolled
    // down) also leaves us "not near", but that isn't the user leaving.
    if (near) stick.current = true;
    else if (el.scrollTop < lastTop.current) stick.current = false;
    lastTop.current = el.scrollTop;
    if (near) setShowJump(false);
  };

  const jump = () => {
    const el = scroller.current;
    if (!el) return;
    stick.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setShowJump(false);
  };

  // A "response" starts at the first non-user block after a user message.
  let prevWasUser = true;
  const lastTurnStart = (() => {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.type === "user") return i;
    return -1;
  })();

  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scroller}
        onScroll={onScroll}
        data-testid="timeline"
        className="scroll-fade h-full overflow-y-auto"
      >
        <div ref={content} className="mx-auto flex w-full max-w-[720px] flex-col gap-4 px-7 pt-8 pb-10">
          {blocks.map((b, i) => {
            const isUser = b.type === "user";
            const isNotice = b.type === "notice" && b.entry.item.status !== "failed";
            const header = !isUser && !isNotice && prevWasUser;
            if (isUser) prevWasUser = true;
            else if (!isNotice) prevWasUser = false;
            // A response that reports a bug gets a red rule down its left edge (in the gutter, so nothing shifts).
            const bug = bugTurn.has(i);
            return (
              <div
                key={b.key}
                data-bug-turn={bug || undefined}
                className={cn(
                  header && i > 0 && "mt-2",
                  isUser && i > 0 && "mt-3",
                  bug &&
                    "relative before:absolute before:left-[-14px] before:w-[2px] before:rounded-full before:bg-danger/55",
                  bug && (bugTurn.has(i - 1) ? "before:-top-2" : "before:top-0"),
                  bug && (bugTurn.has(i + 1) ? "before:-bottom-2" : "before:bottom-0"),
                )}
              >
                {header && (
                  <div className="mb-2.5">
                    <ResponseHeader agent={agent} entry={firstEntry(b)} bug={bug} />
                  </div>
                )}
                <BlockView block={b} agent={agent} live={working && i > lastTurnStart} />
              </div>
            );
          })}
          {working && blocks.length > 0 && blocks[blocks.length - 1]!.type === "user" && (
            <div className="flex items-center gap-2 text-sm">
              <AgentAvatar agent={agent} size={22} state="working" />
              <span className="shimmer-text">{agent.preview ?? "Thinking…"}</span>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          onClick={jump}
          className="-translate-x-1/2 absolute bottom-3 left-1/2 flex items-center gap-1.5 rounded-full border border-border-strong/70 bg-elevated px-3 py-1.5 font-medium text-sm shadow-pop transition-colors animate-rise hover:bg-hover"
        >
          <ArrowDown className="size-3.5" />
          Jump to latest
        </button>
      )}
    </div>
  );
}
