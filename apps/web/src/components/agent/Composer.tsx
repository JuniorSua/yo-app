import type { AgentView, Attachment, QueuedRequest } from "@yo/contracts";
import { ArrowUp, FileArchive, FileText, Minimize2, Plus, Square, SquarePen, X, Zap } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { isUsable } from "../../lib/accounts";
import { api } from "../../lib/api";
import { steerQueued } from "../../lib/requests";
import { cn, fileSize, modKey, readFileBase64 } from "../../lib/utils";
import { accountFor, useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { ui, useUI } from "../../stores/ui";
import { Tip } from "../ui/overlay";
import { RouteSelector, routeChoiceAvailable, useRoute } from "./RouteSelector";
import { TaskSuggestion } from "./TaskSuggestion";
import { UpNext } from "./UpNext";

const drafts = new Map<string, string>();
const NO_QUEUE: QueuedRequest[] = [];

type Pending = Attachment & { preview?: string; size: number };

/** Same cap as core and the agent's computer (apps/core/src/zipUploads.ts MAX_ZIP_BYTES). */
const MAX_ZIP_BYTES = 20 * 1024 * 1024;
const ZIP_TYPES = new Set([
  "application/zip",
  "application/x-zip-compressed",
  "application/x-zip",
  "multipart/x-zip",
]);
/** Browsers label zips differently (or not at all), so the extension counts too. */
const isZip = (f: { name: string; type: string }) =>
  ZIP_TYPES.has(f.type.toLowerCase()) || /\.zip$/i.test(f.name);

/** Slash commands typed in the composer (handled by Yo, never sent to the model as text). */
export const SLASH_COMMANDS = [
  {
    name: "compact",
    hint: "[focus]",
    description: "Summarize our conversation and continue on a lighter session",
    icon: Minimize2,
  },
  {
    name: "new",
    hint: "",
    description: "Start a fresh session (memory and notes carry over)",
    icon: SquarePen,
  },
] as const;

/** "/compact keep the numbers" → { name: "compact", arg: "keep the numbers" }; unknown or plain text → null. */
export function parseSlash(
  text: string,
): { name: (typeof SLASH_COMMANDS)[number]["name"]; arg: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const cmd = SLASH_COMMANDS.find((c) => c.name === m[1]!.toLowerCase());
  return cmd ? { name: cmd.name, arg: (m[2] ?? "").trim() } : null;
}

/**
 * Imperative handle so buttons can send directly. `sendPlain` is for text Yo wrote (quick-reply chips, a brief
 * row's Start): sent as it is, never read as a "/" command, and without the attachments waiting in the box.
 */
export const composerBus = {
  send: null as null | ((text: string) => void),
  sendPlain: null as null | ((text: string) => void),
};

export function Composer({ agent }: { agent: AgentView }) {
  const focus = useUI((s) => s.composerFocus);
  useEffect(() => {
    ta.current?.focus();
  }, [focus]);
  // A line to start with (the Make page's + menu): taken once, focused, the cursor at the end.
  const prefill = useUI((s) => (s.composerDraft?.agentId === agent.id ? s.composerDraft.text : null));
  useEffect(() => {
    if (prefill === null) return;
    useUI.setState({ composerDraft: null });
    drafts.set(agent.id, prefill);
    setText(prefill);
    requestAnimationFrame(() => {
      ta.current?.focus();
      ta.current?.setSelectionRange(prefill.length, prefill.length);
    });
  }, [prefill, agent.id]);
  const [text, setText] = useState(() => drafts.get(agent.id) ?? "");
  const [files, setFiles] = useState<Pending[]>([]);
  // The "/" menu: the highlighted row, and the text it was closed for with Escape (typing opens it again).
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashClosedFor, setSlashClosedFor] = useState<string | null>(null);
  const sending = useRef(new Set<string>());
  const currentAgent = useRef(agent.id);
  currentAgent.current = agent.id;
  const ta = useRef<HTMLTextAreaElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const accounts = useApp((s) => s.accounts);
  const acc = accountFor(agent, accounts);
  // What core will run on (AccountService.resolveFor): the agent's own account, or any connected one.
  const using = acc && isUsable(acc) ? acc : agent.accountId ? undefined : accounts.find(isUsable);
  const showRoute = useApp((s) => routeChoiceAvailable(s.execution));
  const [route, setRoute] = useRoute(agent.id);
  const working = agent.activity === "working" || agent.activity === "waiting";
  const canSend = text.trim().length > 0 || files.length > 0;
  // "Send again to steer": while Yo works, an empty box with something in Up next steers the newest one in.
  const queue = useApp((s) => s.queues[agent.id]) ?? NO_QUEUE;
  const newest = working && !canSend ? queue.at(-1) : undefined;
  const steering = useRef<string | null>(null);
  const steerNewest = () => {
    // A double tap must not steer the same message twice.
    if (!newest || steering.current === newest.id) return;
    steering.current = newest.id;
    void steerQueued(agent, newest.id).finally(() => {
      steering.current = null;
    });
  };

  useEffect(() => {
    setText(drafts.get(agent.id) ?? "");
    setFiles([]);
    ta.current?.focus();
  }, [agent.id]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    // At most 220px, and less on a short window so the chat above stays visible.
    const max = Math.min(220, Math.round(window.innerHeight * 0.3));
    el.style.height = `${Math.min(max, Math.max(36, el.scrollHeight))}px`;
  }, [text]);

  const slashMatches =
    text.startsWith("/") && !text.includes("\n")
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(text.slice(1).split(/\s/)[0]!.toLowerCase()))
      : [];
  const showSlash =
    slashMatches.length > 0 && !parseSlash(text)?.arg && files.length === 0 && slashClosedFor !== text;
  const slashSel = Math.min(slashIdx, slashMatches.length - 1);
  const pickSlash = (c: (typeof SLASH_COMMANDS)[number]) => {
    if (c.hint) {
      setText(`/${c.name} `);
      ta.current?.focus();
    } else void send(`/${c.name}`);
  };

  /**
   * `steer`: while it's working, send this into the running task instead of queueing it (⌘Enter). `plain`: send
   * `override` as it is (no "/" commands, no attachments), queued like any message while Yo works.
   */
  const send = async (override?: string, steer = false, plain = false) => {
    const body = (override ?? text).trim();
    const submittedFiles = plain ? [] : files;
    if (!body && !submittedFiles.length) return;
    if (sending.current.has(agent.id)) return;
    sending.current.add(agent.id);
    const cmd = !plain && !submittedFiles.length ? parseSlash(body) : null;
    try {
      const result = cmd
        ? cmd.name === "compact"
          ? await run(
              api().call("agent.compact", { id: agent.id, ...(cmd.arg ? { focus: cmd.arg } : {}) }),
              "Couldn't compact the conversation",
            )
          : await run(api().call("agent.newSession", { id: agent.id }), "Couldn't start a new session")
        : await run(
            api().call("chat.send", {
              agentId: agent.id,
              text: body,
              attachments: submittedFiles.length
                ? submittedFiles.map(({ preview: _p, size: _s, ...a }) => a)
                : undefined,
              ...(showRoute ? { route } : {}),
            }),
            "Couldn't send message",
          );
      if (result && "queuedId" in result && result.queuedId) {
        if (steer) void steerQueued(agent, result.queuedId);
        else
          toast(`Queued for ${agent.name}`, {
            description: `It's in Up next. ${agent.name} starts it after the current task.`,
          });
      }
      // Keep text and attachments until acknowledged. A later edit or another agent's draft must survive.
      if (result !== undefined) {
        if (override === undefined && drafts.get(agent.id) === text) drafts.delete(agent.id);
        if (currentAgent.current === agent.id) {
          if (override === undefined) setText((current) => (current === text ? "" : current));
          setFiles((current) => current.filter((file) => !submittedFiles.includes(file)));
        }
      }
    } finally {
      sending.current.delete(agent.id);
    }
  };
  composerBus.send = (t) => void send(t);
  composerBus.sendPlain = (t) => void send(t, false, true);

  const addFiles = async (list: FileList | File[]) => {
    const next: Pending[] = [];
    for (const f of Array.from(list).slice(0, 8)) {
      const zip = isZip(f);
      if (zip && f.size > MAX_ZIP_BYTES) {
        toast.error(`${f.name} is ${fileSize(f.size)}. Zip files can be up to ${fileSize(MAX_ZIP_BYTES)}.`);
        continue;
      }
      const data = await readFileBase64(f);
      next.push({
        name: f.name,
        mediaType: zip ? "application/zip" : f.type || "application/octet-stream",
        data,
        size: f.size,
        preview: f.type.startsWith("image/") ? `data:${f.type};base64,${data}` : undefined,
      });
    }
    setFiles((s) => [...s, ...next]);
  };

  return (
    <div className="composer-dock chat-dock">
      <div className="chat-dock-inner">
        {showSlash && (
          <div data-testid="slash-menu" role="listbox" className="chat-slash animate-pop">
            {slashMatches.map((c, i) => (
              <button
                key={c.name}
                type="button"
                role="option"
                aria-selected={i === slashSel}
                data-testid={`slash-${c.name}`}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setSlashIdx(i)}
                onClick={() => pickSlash(c)}
                className={cn(
                  "flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-hover",
                  i === slashSel && "bg-hover",
                )}
              >
                <c.icon className="size-4 shrink-0 text-muted" />
                <span className="font-medium text-sm">
                  /{c.name}
                  {c.hint && <span className="ml-1.5 font-normal text-faint">{c.hint}</span>}
                </span>
                <span className="min-w-0 flex-1 truncate text-right text-muted text-xs">{c.description}</span>
              </button>
            ))}
          </div>
        )}
        <TaskSuggestion agent={agent} />
        <UpNext agent={agent} />
        {/* One pill, as in a messaging app: + for files, the message, then where it runs and Send. */}
        <div
          data-testid="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
          className="chat-composer air-raised"
        >
          {files.length > 0 && (
            <div className="chat-composer-files">
              {files.map((f, i) => (
                <div key={i} data-testid="composer-attachment" className="chat-attachment group animate-pop">
                  {f.preview ? (
                    <img src={f.preview} alt="" className="size-10 rounded-lg object-cover" />
                  ) : (
                    <div className="grid size-10 place-items-center rounded-lg bg-active">
                      {f.mediaType === "application/zip" ? (
                        <FileArchive className="size-4 text-muted" />
                      ) : (
                        <FileText className="size-4 text-muted" />
                      )}
                    </div>
                  )}
                  {f.preview ? (
                    <span className="max-w-40 truncate">{f.name}</span>
                  ) : (
                    <span className="flex min-w-0 flex-col leading-tight">
                      <span className="max-w-40 truncate">{f.name}</span>
                      <span className="text-faint text-xs">{fileSize(f.size)}</span>
                    </span>
                  )}
                  <button
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((s) => s.filter((_, j) => j !== i))}
                    className="-top-1.5 -right-1.5 absolute grid size-5 place-items-center rounded-full border border-border-strong bg-elevated text-muted opacity-0 transition-opacity hover:text-fg focus-visible:opacity-100 group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="chat-composer-row">
            <Tip label="Attach images or files">
              <button
                aria-label="Attach"
                onClick={() => fileInput.current?.click()}
                className="chat-round is-plus"
              >
                <Plus />
              </button>
            </Tip>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                if (e.target.files) void addFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <textarea
              ref={ta}
              data-testid="composer-input"
              value={text}
              rows={1}
              onChange={(e) => {
                setText(e.target.value);
                setSlashIdx(0);
                drafts.set(agent.id, e.target.value);
              }}
              onPaste={(e) => {
                if (e.clipboardData.files.length) {
                  e.preventDefault();
                  void addFiles(e.clipboardData.files);
                }
              }}
              onKeyDown={(e) => {
                if (showSlash && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const n = slashMatches.length;
                  setSlashIdx((slashSel + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                  return;
                }
                if (showSlash && e.key === "Escape") {
                  e.preventDefault();
                  setSlashClosedFor(text);
                  return;
                }
                if (e.key === "Tab" && showSlash) {
                  e.preventDefault();
                  setText(`/${slashMatches[slashSel]!.name} `);
                  return;
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  // "/" or "/c" + Enter picks the highlighted command; a whole command ("/compact") just sends.
                  if (showSlash && !parseSlash(text)) {
                    pickSlash(slashMatches[slashSel]!);
                    return;
                  }
                  if (newest) steerNewest();
                  else void send(undefined, working && (e.metaKey || e.ctrlKey));
                }
              }}
              placeholder={working ? `Queue a message for ${agent.name}…` : `Message ${agent.name}…`}
              className="chat-composer-input"
            />
            {working && canSend && (
              <span className="chat-composer-hint" data-testid="composer-busy-hint">
                Enter to queue · {modKey} Enter to steer
              </span>
            )}
            {showRoute && <RouteSelector value={route} onChange={setRoute} />}
            {newest && (
              <Tip label={`Send “${newest.text.slice(0, 60)}” into ${agent.name}’s current task now`}>
                <button
                  data-testid="steer-button"
                  aria-label="Steer"
                  onClick={steerNewest}
                  className="chat-steer"
                >
                  <Zap />
                  {/* Phones: just the bolt, so the message keeps its room. */}
                  <span className="max-sm:hidden">Steer</span>
                </button>
              </Tip>
            )}
            {working && !canSend ? (
              <Tip label="Stop">
                <button
                  data-testid="stop-button"
                  aria-label="Stop"
                  onClick={() => run(api().call("chat.interrupt", { agentId: agent.id }))}
                  className="chat-round is-stop"
                >
                  <Square className="fill-current" />
                </button>
              </Tip>
            ) : (
              <button
                data-testid="send-button"
                aria-label="Send"
                disabled={!canSend}
                onClick={() => send()}
                className="chat-round is-send"
              >
                <ArrowUp strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
        {/* The model chip above says what it runs on; down here only when nothing is connected. */}
        {!using && (
          <div className="chat-dock-note" data-testid="composer-footer">
            {agent.name} works in a private workspace · no model connected ·{" "}
            <button
              type="button"
              onClick={() => ui.openSettings("accounts")}
              className="text-fg-2 underline underline-offset-2 hover:text-fg"
              data-testid="composer-connect"
            >
              Connect one
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
