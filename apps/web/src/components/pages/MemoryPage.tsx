import { YoLogo } from "@yo/avatar";
import type { Memory } from "@yo/contracts";
import { Brain, Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import { ago, cn } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { AgentAvatar } from "../brand";
import { EmptyNote, PageShell } from "../PageHeader";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";

function MemoryRow({ m }: { m: Memory }) {
  const agents = useApp((s) => s.agents);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const a = m.agentId ? agents[m.agentId] : undefined;
  const save = async () => {
    if (!text.trim()) return;
    await run(api().call("memory.update", { id: m.id, content: text.trim() }));
    setEditing(false);
  };
  return (
    <div data-testid="memory-row" className="group flex items-start gap-3.5 px-4 py-3.5">
      <div className="mt-0.5">
        {a ? <AgentAvatar agent={a} size={22} state="idle" quiet /> : <YoLogo size={22} />}
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void save();
              if (e.key === "Escape") {
                setText(m.content);
                setEditing(false);
              }
            }}
            className="-my-1 -ml-2 h-8 w-full rounded-lg border border-link/50 bg-bg/60 px-2 text-md outline-none ring-3 ring-link/15"
          />
        ) : (
          <div className="text-md">{m.content}</div>
        )}
        <div className="mt-0.5 text-faint text-xs">
          {a ? `${a.name} only` : "Shared with all agents"} · {ago(m.updatedAt)}
        </div>
      </div>
      <div
        className={cn(
          "flex gap-0.5 transition-opacity",
          editing ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-within:opacity-100",
        )}
      >
        {editing ? (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Save" onClick={save}>
              <Check className="size-3.5" />
            </Button>
            <Button variant="ghost" size="icon-sm" aria-label="Cancel" onClick={() => setEditing(false)}>
              <X className="size-3.5" />
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" size="icon-sm" aria-label="Edit memory" onClick={() => setEditing(true)}>
              <Pencil className="size-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Delete memory"
              data-testid="memory-delete"
              onClick={async () => {
                await run(api().call("memory.delete", { id: m.id }));
                useApp.setState((s) => ({ memories: s.memories?.filter((x) => x.id !== m.id) ?? null }));
              }}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

export function MemoryPage() {
  const memories = useApp((s) => s.memories);
  const agents = useApp((s) => s.agents);
  const userName = useApp((s) => s.settings.userName);
  const [filter, setFilter] = useState("all");
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState("shared");
  useEffect(() => {
    void load.memories(true);
  }, []);

  const list = useMemo(
    () =>
      (memories ?? []).filter((m) =>
        filter === "all" ? true : filter === "shared" ? m.agentId === null : m.agentId === filter,
      ),
    [memories, filter],
  );

  const add = async () => {
    if (!draft.trim()) return;
    await run(
      api().call("memory.add", { content: draft.trim(), agentId: scope === "shared" ? null : scope }),
    );
    setDraft("");
  };

  const agentOpts = sortAgents(agents).map((a) => ({
    value: a.id,
    label: a.name,
    icon: <AgentAvatar agent={a} size={18} state="idle" quiet />,
  }));

  return (
    <PageShell
      title={userName ? `About ${userName}` : "About you"}
      subtitle="What your agents know about you. Edit or delete anything — they'll use it next time."
      icon={<Brain className="size-4 text-muted" />}
      actions={
        <div className="w-48">
          <Select
            value={filter}
            onChange={setFilter}
            options={[
              { value: "all", label: "All memories" },
              { value: "shared", label: "Shared" },
              ...agentOpts,
            ]}
          />
        </div>
      }
    >
      <form
        className="mb-5 flex items-center gap-2 rounded-2xl border border-border-strong/70 bg-card p-1.5 pl-4 shadow-soft focus-within:border-border-strong"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Plus className="size-4 text-muted" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="memory-input"
          placeholder="Add something they should know, e.g. “I'm vegetarian”"
          className="h-9 min-w-0 flex-1 bg-transparent text-md outline-none"
        />
        <div className="w-40">
          <Select
            value={scope}
            onChange={setScope}
            options={[{ value: "shared", label: "All agents" }, ...agentOpts]}
            className="h-8 border-transparent bg-active/60"
          />
        </div>
        <Button type="submit" variant="primary" disabled={!draft.trim()} data-testid="memory-add">
          Remember
        </Button>
      </form>

      {memories && list.length === 0 ? (
        <EmptyNote
          icon={<Brain />}
          title="Nothing here yet"
          body="As you chat, your agents will remember useful things about you."
        />
      ) : (
        <div
          className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-card"
          data-testid="memory-list"
        >
          {list.map((m) => (
            <MemoryRow key={m.id} m={m} />
          ))}
        </div>
      )}
    </PageShell>
  );
}
