import type { AgentView, QueuedRequest } from "@yo/contracts";
import { ChevronDown, ChevronUp, Paperclip, Pencil, X, Zap } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { steerQueued } from "../../lib/requests";
import { cn } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { Tip } from "../ui/overlay";

const NONE: QueuedRequest[] = [];

const setQueue = (agentId: string, items: QueuedRequest[]) =>
  useApp.setState((s) => ({ queues: { ...s.queues, [agentId]: items } }));

/**
 * "Up next": the user's messages waiting for the running task, just above the message box. Each can be edited,
 * moved, cancelled, or sent into the running task now (Steer now).
 */
export function UpNext({ agent }: { agent: AgentView }) {
  const items = useApp((s) => s.queues[agent.id]) ?? NONE;
  const [open, setOpen] = useState(true);
  useEffect(() => {
    // Pushes keep it live; this catches up when the chat opens (an older core has no queue: nothing shows).
    api()
      .call("queue.list", { agentId: agent.id })
      .then((list) => setQueue(agent.id, list))
      .catch(() => undefined);
  }, [agent.id]);
  if (!items.length) return null;

  const move = (i: number, by: -1 | 1) => {
    const ids = items.map((q) => q.id);
    const j = i + by;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j]!, ids[i]!];
    setQueue(
      agent.id,
      ids.map((id) => items.find((q) => q.id === id)!),
    );
    void run(api().call("queue.reorder", { agentId: agent.id, ids }), "Couldn't move it").then(
      (list) => list && setQueue(agent.id, list),
    );
  };

  return (
    <div data-testid="up-next" className="chat-upnext air-raised animate-pop">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="chat-upnext-head"
        data-testid="up-next-toggle"
      >
        <span className="font-medium text-fg-2">Up next ({items.length})</span>
        <span className="truncate text-muted">
          {agent.activity === "working" || agent.activity === "waiting"
            ? `${agent.name} starts these after the current task`
            : "Starting soon"}
        </span>
        <span className="flex-1" />
        <ChevronDown className={cn("size-3.5 text-muted transition-transform", !open && "-rotate-90")} />
      </button>
      {open && (
        <ol className="chat-upnext-list">
          {items.map((q, i) => (
            <UpNextItem
              key={q.id}
              agent={agent}
              item={q}
              index={i}
              count={items.length}
              onMove={(by) => move(i, by)}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function UpNextItem({
  agent,
  item,
  index,
  count,
  onMove,
}: {
  agent: AgentView;
  item: QueuedRequest;
  index: number;
  count: number;
  onMove: (by: -1 | 1) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.text);
  const ta = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!editing) setText(item.text);
  }, [item.text, editing]);
  useEffect(() => {
    if (editing) {
      ta.current?.focus();
      ta.current?.select();
    }
  }, [editing]);

  const save = async () => {
    const body = text.trim();
    if (!body && !item.attachments) return;
    if (body === item.text) return setEditing(false);
    const list = await run(
      api().call("queue.update", { agentId: agent.id, id: item.id, text: body }),
      "Couldn't save the change",
    );
    if (list) {
      setQueue(agent.id, list);
      setEditing(false);
    }
  };
  const remove = async () => {
    const list = await run(
      api().call("queue.remove", { agentId: agent.id, id: item.id }),
      "Couldn't cancel it",
    );
    if (list) setQueue(agent.id, list);
  };

  const icon =
    "grid size-7 shrink-0 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg disabled:pointer-events-none disabled:opacity-30";
  return (
    <li data-testid="up-next-item" className="chat-upnext-item group">
      <span className="chat-upnext-n">{index + 1}</span>
      {editing ? (
        <div className="min-w-0 flex-1">
          <textarea
            ref={ta}
            data-testid="up-next-edit-input"
            value={text}
            rows={2}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void save();
              } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                setEditing(false);
              }
            }}
            className="block w-full resize-none rounded-lg border border-border-strong bg-transparent px-2.5 py-1.5 text-sm leading-5 outline-none focus:border-focus"
          />
          <div className="mt-1.5 flex justify-end gap-1.5">
            <button
              onClick={() => setEditing(false)}
              className="rounded-lg px-2.5 py-1 text-muted text-xs hover:bg-hover hover:text-fg"
            >
              Cancel
            </button>
            <button
              data-testid="up-next-save"
              onClick={() => void save()}
              className="rounded-lg bg-fg px-2.5 py-1 font-medium text-bg text-xs hover:brightness-110"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="min-w-0 flex-1 pt-0.5">
          <p
            className="line-clamp-2 whitespace-pre-wrap break-words text-sm leading-5"
            data-testid="up-next-text"
          >
            {item.text}
          </p>
          {item.attachments > 0 && (
            <span className="mt-0.5 flex items-center gap-1 text-2xs text-faint">
              <Paperclip className="size-3" />
              {item.attachments === 1 ? "1 attachment" : `${item.attachments} attachments`}
            </span>
          )}
        </div>
      )}
      {!editing && (
        <div className="flex shrink-0 items-center gap-0.5">
          <Tip label={`Send into ${agent.name}'s current task now`}>
            <button
              data-testid="up-next-steer"
              aria-label="Steer now"
              onClick={() => void steerQueued(agent, item.id)}
              className="flex h-7 items-center gap-1 rounded-lg px-2 font-medium text-fg-2 text-xs transition-colors hover:bg-hover hover:text-fg"
            >
              <Zap className="size-3.5" />
              {/* On a phone the label would squeeze the message into a sliver: icon only (the tip still says it). */}
              <span className="max-sm:sr-only">Steer now</span>
            </button>
          </Tip>
          <Tip label="Move up">
            <button
              aria-label="Move up"
              data-testid="up-next-up"
              disabled={index === 0}
              onClick={() => onMove(-1)}
              className={icon}
            >
              <ChevronUp className="size-4" />
            </button>
          </Tip>
          <Tip label="Move down">
            <button
              aria-label="Move down"
              data-testid="up-next-down"
              disabled={index === count - 1}
              onClick={() => onMove(1)}
              className={icon}
            >
              <ChevronDown className="size-4" />
            </button>
          </Tip>
          <Tip label="Edit">
            <button
              aria-label="Edit"
              data-testid="up-next-edit"
              onClick={() => setEditing(true)}
              className={icon}
            >
              <Pencil className="size-3.5" />
            </button>
          </Tip>
          <Tip label="Cancel this message">
            <button
              aria-label="Cancel this message"
              data-testid="up-next-cancel"
              onClick={() => void remove()}
              className={icon}
            >
              <X className="size-4" />
            </button>
          </Tip>
        </div>
      )}
    </li>
  );
}
