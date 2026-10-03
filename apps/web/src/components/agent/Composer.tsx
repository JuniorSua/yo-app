import type { AgentView, Attachment } from "@yo/contracts";
import { ArrowUp, FileText, Minimize2, Plus, Square, SquarePen, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isUsable } from "../../lib/accounts";
import { api } from "../../lib/api";
import { cn, readFileBase64 } from "../../lib/utils";
import { accountFor, useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { PROVIDER_NAME } from "../brand";
import { Tip } from "../ui/overlay";
import { ModelPicker } from "./ModelPicker";
import { RouteSelector, routeChoiceAvailable, useRoute } from "./RouteSelector";

const drafts = new Map<string, string>();

type Pending = Attachment & { preview?: string };

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

/** Imperative handle so suggestion chips can send directly. */
export const composerBus = { send: null as null | ((text: string) => void) };

export function Composer({ agent }: { agent: AgentView }) {
  const [text, setText] = useState(() => drafts.get(agent.id) ?? "");
  const [files, setFiles] = useState<Pending[]>([]);
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

  useEffect(() => {
    setText(drafts.get(agent.id) ?? "");
    setFiles([]);
    ta.current?.focus();
  }, [agent.id]);

  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${Math.min(220, Math.max(24, el.scrollHeight))}px`;
  }, [text]);

  const slashMatches =
    text.startsWith("/") && !text.includes("\n")
      ? SLASH_COMMANDS.filter((c) => c.name.startsWith(text.slice(1).split(/\s/)[0]!.toLowerCase()))
      : [];
  const showSlash = slashMatches.length > 0 && !parseSlash(text)?.arg && files.length === 0;

  const send = async (override?: string) => {
    const body = (override ?? text).trim();
    if (!body && !files.length) return;
    const cmd = !files.length ? parseSlash(body) : null;
    if (cmd) {
      setText("");
      drafts.delete(agent.id);
      if (cmd.name === "compact")
        await run(
          api().call("agent.compact", { id: agent.id, ...(cmd.arg ? { focus: cmd.arg } : {}) }),
          "Couldn't compact the conversation",
        );
      else await run(api().call("agent.newSession", { id: agent.id }), "Couldn't start a new session");
      return;
    }
    const attachments = files.map(({ preview: _p, ...a }) => a);
    setText("");
    setFiles([]);
    drafts.delete(agent.id);
    await run(
      api().call("chat.send", {
        agentId: agent.id,
        text: body,
        attachments: attachments.length ? attachments : undefined,
        ...(showRoute ? { route } : {}),
      }),
      "Couldn't send message",
    );
  };
  composerBus.send = (t) => void send(t);

  const addFiles = async (list: FileList | File[]) => {
    const next: Pending[] = [];
    for (const f of Array.from(list).slice(0, 8)) {
      const data = await readFileBase64(f);
      next.push({
        name: f.name,
        mediaType: f.type || "application/octet-stream",
        data,
        preview: f.type.startsWith("image/") ? `data:${f.type};base64,${data}` : undefined,
      });
    }
    setFiles((s) => [...s, ...next]);
  };

  return (
    <div className="relative shrink-0 px-6 pb-4">
      <div className="pointer-events-none absolute inset-x-0 -top-8 h-8 bg-gradient-to-t from-bg to-transparent" />
      <div className="relative mx-auto w-full max-w-[720px]">
        {showSlash && (
          <div
            data-testid="slash-menu"
            className="absolute inset-x-3 bottom-full z-10 mb-2 overflow-hidden rounded-2xl border border-border-strong/60 bg-elevated p-1 shadow-pop animate-pop"
          >
            {slashMatches.map((c) => (
              <button
                key={c.name}
                type="button"
                data-testid={`slash-${c.name}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  if (c.hint) {
                    setText(`/${c.name} `);
                    ta.current?.focus();
                  } else void send(`/${c.name}`);
                }}
                className="flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors hover:bg-hover"
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
        <div
          data-testid="composer"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
          }}
          className={cn(
            "rounded-[20px] border bg-card shadow-soft transition-[border-color,box-shadow] duration-200",
            "border-border-strong/70 focus-within:border-border-strong focus-within:shadow-pop",
          )}
        >
          {files.length > 0 && (
            <div className="flex flex-wrap gap-2 px-3.5 pt-3">
              {files.map((f, i) => (
                <div
                  key={i}
                  className="group relative flex h-12 items-center gap-2 rounded-xl border border-border bg-elevated pr-3 pl-1 text-sm animate-pop"
                >
                  {f.preview ? (
                    <img src={f.preview} alt="" className="size-10 rounded-lg object-cover" />
                  ) : (
                    <div className="grid size-10 place-items-center rounded-lg bg-active">
                      <FileText className="size-4 text-muted" />
                    </div>
                  )}
                  <span className="max-w-40 truncate">{f.name}</span>
                  <button
                    aria-label={`Remove ${f.name}`}
                    onClick={() => setFiles((s) => s.filter((_, j) => j !== i))}
                    className="-top-1.5 -right-1.5 absolute grid size-5 place-items-center rounded-full border border-border-strong bg-elevated text-muted opacity-0 transition-opacity hover:text-fg group-hover:opacity-100"
                  >
                    <X className="size-3" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={ta}
            data-testid="composer-input"
            value={text}
            rows={1}
            onChange={(e) => {
              setText(e.target.value);
              drafts.set(agent.id, e.target.value);
            }}
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void addFiles(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === "Tab" && showSlash && slashMatches.length === 1) {
                e.preventDefault();
                setText(`/${slashMatches[0]!.name} `);
                return;
              }
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                // "/c" + Enter picks the single matching command.
                if (showSlash && slashMatches.length === 1 && !parseSlash(text)) {
                  void send(`/${slashMatches[0]!.name}`);
                  return;
                }
                void send();
              }
            }}
            placeholder={working ? `Steer ${agent.name}… it'll adjust as it works` : `Message ${agent.name}…`}
            className="block w-full resize-none bg-transparent px-5 pt-3.5 pb-1 text-[15px] leading-6 outline-none placeholder:text-faint"
          />
          <div className="flex items-center gap-1 px-2.5 pb-2.5">
            <Tip label="Attach images or files">
              <button
                aria-label="Attach"
                onClick={() => fileInput.current?.click()}
                className="grid size-8 place-items-center rounded-full text-muted transition-colors hover:bg-hover hover:text-fg"
              >
                <Plus className="size-[18px]" />
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
            <ModelPicker agent={agent} />
            {showRoute && <RouteSelector value={route} onChange={setRoute} />}
            <div className="flex-1" />
            {working && canSend && <span className="mr-1.5 text-faint text-xs">Enter to steer</span>}
            {working && !canSend ? (
              <Tip label="Stop">
                <button
                  data-testid="stop-button"
                  aria-label="Stop"
                  onClick={() => run(api().call("chat.interrupt", { agentId: agent.id }))}
                  className="grid size-8 place-items-center rounded-full bg-fg text-bg transition-transform hover:scale-105 active:scale-95"
                >
                  <Square className="size-3 fill-current" />
                </button>
              </Tip>
            ) : (
              <button
                data-testid="send-button"
                aria-label="Send"
                disabled={!canSend}
                onClick={() => send()}
                className={cn(
                  "grid size-8 place-items-center rounded-full transition-all duration-150",
                  canSend ? "bg-brand text-brand-fg hover:scale-105 active:scale-95" : "bg-active text-faint",
                )}
              >
                <ArrowUp className="size-4" strokeWidth={2.4} />
              </button>
            )}
          </div>
        </div>
        <div className="mt-2 text-center text-2xs text-faint" data-testid="composer-footer">
          {agent.name} works on its own computer
          {using ? (
            ` · using your ${PROVIDER_NAME[using.provider]} subscription`
          ) : (
            <>
              {" · no model connected · "}
              <button
                type="button"
                onClick={() => ui.openSettings("accounts")}
                className="text-fg-2 underline underline-offset-2 hover:text-fg"
                data-testid="composer-connect"
              >
                Connect one
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
