import { helperAvatar } from "@yo/avatar";
import type { AgentActivity, Item, TimelineEntry } from "@yo/contracts";
import { ChevronDown, Eye, EyeOff, Hand, MousePointer2, Square } from "lucide-react";
import { memo, useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import { accentVars } from "../../lib/accent";
import { api } from "../../lib/api";
import { cn, duration } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { AgentAvatar } from "../brand";
import { ApprovalCard, AskUserCard } from "../cards/RequestCards";
import { ScreenView } from "../computer/ScreenView";
import { CHAT_MD, MD_PLUGINS } from "./markdown";
import { usePaintedTheme } from "./paintedTheme";

type HelperInfo = NonNullable<Item["helper"]>;
type HelperState = HelperInfo["state"];

/** Results up to this long (one line) show in the row; longer ones fold. */
const SHORT_CHARS = 140;

const STATUS: Record<HelperState, { label: string; pose: AgentActivity }> = {
  waiting: { label: "Waiting for a screen", pose: "idle" },
  working: { label: "Working", pose: "working" },
  done: { label: "Done", pose: "done" },
  failed: { label: "Couldn't finish", pose: "error" },
  stopped: { label: "Stopped", pose: "idle" },
};

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** A result that fits on a line shows as it is; a longer one folds behind "Show result". */
function isShort(text: string) {
  return text.length <= SHORT_CHARS && !text.includes("\n");
}

function Result({ text, failed }: { text: string; failed: boolean }) {
  const [open, setOpen] = useState(false);
  if (isShort(text))
    return (
      <div className={cn("chat-task-result is-short", failed && "text-danger")} data-testid="helper-summary">
        {text}
      </div>
    );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="chat-text-button chat-task-toggle"
        data-testid="helper-result-toggle"
      >
        <ChevronDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
        {open ? "Hide result" : failed ? "What went wrong" : "Show result"}
      </button>
      {open && (
        <div className="chat-task-result animate-rise" data-testid="helper-summary">
          <div className={cn("prose-yo prose-team", failed && "text-danger")}>
            <Markdown remarkPlugins={MD_PLUGINS} components={CHAT_MD}>
              {text}
            </Markdown>
          </div>
        </div>
      )}
    </>
  );
}

/**
 * One of Yo's one-off helpers, in Yo's chat, as a compact task row: its tinted face, what it's on, how it's
 * going and, while it runs, Watch, Take over and Stop. Its questions and approvals show here too, since its
 * own chat isn't in the sidebar.
 */
export const HelperCard = memo(function HelperCard({ entry }: { entry: TimelineEntry }) {
  const h = entry.item.helper!;
  const agent = useApp((s) => s.agents[h.id]);
  const approvals = useApp((s) => s.approvals);
  const requests = useMemo(
    () => approvals.filter((e) => e.agentId === h.id && e.request?.status === "pending"),
    [approvals, h.id],
  );
  const live = h.state === "waiting" || h.state === "working";
  const now = useNow(live);
  const [watching, setWatching] = useState(false);
  const avatar = useMemo(() => h.avatar ?? helperAvatar(h.id), [h.avatar, h.id]);
  const theme = usePaintedTheme();
  const tint = useMemo(() => accentVars(avatar, theme), [avatar, theme]);
  const status = STATUS[h.state] ?? STATUS.working;
  const elapsed = duration((h.endedAt ?? (live ? now : h.startedAt)) - h.startedAt);
  const controlling = agent?.computer.lease === "user";
  const canWatch = live && !!agent;
  const showScreen = canWatch && (watching || controlling);
  const step = live && agent?.activity === "working" ? agent.preview : null;

  const takeOver = () =>
    run(
      api().call(controlling ? "computer.release" : "computer.takeover", { agentId: h.id }),
      controlling ? "Couldn't hand control back" : "Couldn't take over",
    );
  const stop = () => run(api().call("chat.interrupt", { agentId: h.id }), "Couldn't stop the helper");

  return (
    <div
      data-testid="helper-card"
      data-helper={h.id}
      data-state={h.state}
      className="chat-task animate-rise"
      style={tint}
    >
      <div className="chat-task-row">
        <div className="chat-task-face">
          <AgentAvatar agent={{ avatar, name: h.title }} size={22} state={status.pose} quiet />
        </div>
        <div className="min-w-0 flex-1">
          <div className="chat-task-title" data-testid="helper-title" title={h.title}>
            {h.title}
          </div>
          <div className="chat-task-status" data-testid="helper-status">
            <span className={cn("chat-task-dot", `is-${controlling ? "control" : h.state}`)} />
            <span className="shrink-0">{controlling ? "You have control" : status.label}</span>
            <span className="shrink-0 tabular-nums">· {elapsed}</span>
            {step && <span className="truncate">· {step}</span>}
          </div>
        </div>
        {live && agent && (
          <div className="chat-task-actions">
            <button
              type="button"
              className={cn("chat-mini-pill", showScreen && "is-on")}
              onClick={() => setWatching((w) => !w)}
              disabled={!canWatch || controlling}
              aria-expanded={showScreen}
              data-testid="helper-watch"
            >
              {showScreen ? <EyeOff /> : <Eye />}
              {showScreen ? "Hide screen" : "Watch"}
            </button>
            <button
              type="button"
              className={cn("chat-mini-pill", controlling && "is-on")}
              onClick={takeOver}
              disabled={agent.computer.state !== "ready"}
              data-testid="helper-takeover"
            >
              {controlling ? <Hand /> : <MousePointer2 />}
              {controlling ? "Hand back" : "Take over"}
            </button>
            <button type="button" className="chat-mini-pill is-stop" onClick={stop} data-testid="helper-stop">
              <Square className="fill-current" />
              Stop
            </button>
          </div>
        )}
      </div>

      {showScreen && agent && (
        <div data-testid="helper-screen" className="chat-task-screen animate-rise">
          <ScreenView agent={agent} interactive={controlling} compact />
        </div>
      )}

      {requests.length > 0 && (
        <div className="chat-task-requests" data-testid="helper-requests">
          {requests.map((e) =>
            e.request?.kind === "user_input" ? (
              <AskUserCard key={e.id} entry={e} agentName={h.title} />
            ) : (
              <ApprovalCard key={e.id} entry={e} agentName={h.title} compact />
            ),
          )}
        </div>
      )}

      {!live && h.summary && <Result text={h.summary} failed={h.state === "failed"} />}
    </div>
  );
});
