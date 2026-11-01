import { YoLogo } from "@yo/avatar";
import { type Memory, type MemoryLabel, parseArea } from "@yo/contracts";
import {
  Brain,
  Briefcase,
  Check,
  ChevronDown,
  Globe,
  House,
  Pencil,
  Plus,
  Tag,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  filterMemories,
  LABEL_CHOICES,
  type LabelFilter,
  labelCounts,
  memoryLabel,
  whoSees,
} from "../../lib/memoryFilter";
import { ago, cn } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { ui, useUI } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { LoadState, useLoad } from "../LoadState";
import { EmptyNote, PageShell } from "../PageHeader";
import { Button } from "../ui/button";
import { Select } from "../ui/controls";
import { Menu, MenuItem } from "../ui/overlay";

type LabelKey = MemoryLabel | "everywhere";
const keyOf = (l: MemoryLabel | null): LabelKey => l ?? "everywhere";
const LABEL: Record<LabelKey, string> = { work: "Work", personal: "Personal", everywhere: "Everywhere" };
const LABEL_ICON = { work: Briefcase, personal: House, everywhere: Globe } as const;
/** Each label's tint: cool for Work, warm for Personal. */
const LABEL_TINT: Record<MemoryLabel, string> = {
  work: "bg-link/12 text-link-ink",
  personal: "bg-brand/18 text-brand-ink",
};

function LabelIcon({ label, className }: { label: LabelKey; className?: string }) {
  const Icon = LABEL_ICON[label];
  return <Icon className={className} strokeWidth={2} />;
}

/** Whose prompt shows a memory with each label, by agent name ("Yo and Pepe see it"). */
function useWhoSees(): Record<LabelKey, string> {
  const agents = useApp((s) => s.agents);
  return useMemo(() => {
    const team = sortAgents(agents);
    return {
      work: whoSees("work", team),
      personal: whoSees("personal", team),
      everywhere: whoSees(null, team),
    };
  }, [agents]);
}

/** The small label badge on a memory; it opens "Move to…". */
function LabelBadge({ m }: { m: Memory }) {
  const current = keyOf(memoryLabel(m));
  const who = useWhoSees();
  const move = (label: MemoryLabel | null) => {
    if (keyOf(label) === current) return;
    void run(api().call("memory.update", { id: m.id, content: m.content, space: label }), "Couldn't move it");
  };
  return (
    <Menu
      align="start"
      testId="memory-move-menu"
      className="min-w-60"
      trigger={
        <button
          type="button"
          data-testid="memory-label-badge"
          data-label={current}
          aria-label={`Label: ${LABEL[current]}. Change the label`}
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 pr-1 font-medium text-2xs transition-[filter,box-shadow] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50 data-[popup-open]:ring-2 data-[popup-open]:ring-border-strong dark:hover:brightness-125",
            current === "everywhere" ? "bg-active text-fg-2" : LABEL_TINT[current],
          )}
        >
          <LabelIcon label={current} className="size-3" />
          {LABEL[current]}
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      }
    >
      <div className="px-2.5 pt-1.5 pb-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
        Label as…
      </div>
      {LABEL_CHOICES.map((c) => (
        <MenuItem
          key={c.key}
          testId={`memory-move-${c.key}`}
          className="h-auto py-1.5"
          icon={<LabelIcon label={c.key} />}
          trailing={c.key === current ? <Check className="!text-fg" /> : undefined}
          onClick={() => move(c.value)}
        >
          <div className="min-w-0">
            <div>{c.label}</div>
            <div className="text-muted text-xs">{who[c.key]}</div>
          </div>
        </MenuItem>
      ))}
    </Menu>
  );
}

/**
 * The page's quiet label filter: "All labels", or just the memories with one label. Each choice says who sees
 * those memories, so a label reads as "who sees this", not as a mode the app is in.
 */
function LabelFilterMenu({
  value,
  onChange,
  counts,
}: {
  value: LabelFilter;
  onChange: (f: LabelFilter) => void;
  counts: Record<LabelFilter, number>;
}) {
  const who = useWhoSees();
  const on = value !== "all";
  const tick = (key: LabelFilter, n: number) => (
    <span className="flex items-center gap-2">
      <span className="text-faint text-xs tabular-nums">{n}</span>
      <Check className={cn("!text-fg", key !== value && "invisible")} />
    </span>
  );
  return (
    <Menu
      align="end"
      testId="memory-label-filter-menu"
      className="min-w-64"
      trigger={
        <button
          type="button"
          data-testid="memory-label-filter"
          data-value={value}
          aria-label={on ? `Showing memories labelled ${LABEL[value]}. Change` : "Filter by label"}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-xl px-3 text-base outline-none transition-colors hover:bg-hover focus-visible:ring-3 focus-visible:ring-link/15 data-[popup-open]:bg-active",
            on ? "bg-active text-fg" : "text-fg-2",
          )}
        >
          {on ? <LabelIcon label={value} className="size-3.5" /> : <Tag className="size-3.5 text-muted" />}
          {on ? LABEL[value] : "All labels"}
          <ChevronDown className="size-3.5 text-muted" />
        </button>
      }
    >
      <div className="px-2.5 pt-1.5 pb-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
        Show memories labelled
      </div>
      <MenuItem
        testId="memory-filter-all"
        icon={<Tag />}
        trailing={tick("all", counts.all)}
        onClick={() => onChange("all")}
      >
        All labels
      </MenuItem>
      {LABEL_CHOICES.map((c) => (
        <MenuItem
          key={c.key}
          testId={`memory-filter-${c.key}`}
          className="h-auto py-1.5"
          icon={<LabelIcon label={c.key} />}
          trailing={tick(c.key, counts[c.key])}
          onClick={() => onChange(c.key)}
        >
          <div className="min-w-0">
            <div>{c.label}</div>
            <div className="text-muted text-xs">{who[c.key]}</div>
          </div>
        </MenuItem>
      ))}
    </Menu>
  );
}

function MemoryRow({ m }: { m: Memory }) {
  const agents = useApp((s) => s.agents);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.content);
  const a = m.agentId ? agents[m.agentId] : undefined;
  const save = async () => {
    if (!text.trim()) return;
    // A failed save keeps the editor open with the text, so nothing typed is lost.
    const saved = await run(
      api().call("memory.update", { id: m.id, content: text.trim() }),
      "Couldn't save the change",
    );
    if (saved) setEditing(false);
  };
  return (
    <div
      data-testid="memory-row"
      data-record-id={m.id}
      className="group flex items-start gap-3.5 px-4 py-3.5"
    >
      <div className="mt-0.5">
        {a ? <AgentAvatar agent={a} size={22} state="idle" quiet /> : <YoLogo size={22} />}
      </div>
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            autoFocus
            aria-label="Edit memory"
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
          <div className="text-md [overflow-wrap:anywhere]">{parseArea(m.content).text}</div>
        )}
        <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-faint text-xs">
          <LabelBadge m={m} />
          <span>
            {a ? `${a.name} only · ` : ""}
            {ago(m.updatedAt)}
          </span>
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
              onClick={() =>
                ui.confirm({
                  title: "Delete this memory?",
                  body: "Your agents stop remembering it, and this can't be undone.",
                  action: "Delete memory",
                  run: async () => {
                    const deleted = await run(api().call("memory.delete", { id: m.id }));
                    if (!deleted) return;
                    useApp.setState((s) => ({ memories: s.memories?.filter((x) => x.id !== m.id) ?? null }));
                  },
                })
              }
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
  const focusedRecord = useUI((s) => s.focusRecordId);
  const memories = useApp((s) => s.memories);
  const agents = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const userName = settings.userName;
  const [labelFilter, setLabelFilter] = useState<LabelFilter>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  useEffect(() => {
    if (!focusedRecord) return;
    setLabelFilter("all");
    setAgentFilter("all");
  }, [focusedRecord]);
  const [draft, setDraft] = useState("");
  const [addLabel, setAddLabel] = useState<LabelKey>("everywhere");
  const status = useLoad(() => load.memories(true));

  const agentId = agentFilter === "all" ? null : agentFilter;
  const all = memories ?? [];
  const list = useMemo(
    () => filterMemories(memories ?? [], labelFilter, agentId),
    [memories, labelFilter, agentId],
  );
  const counts = useMemo(() => labelCounts(memories ?? [], agentId), [memories, agentId]);

  // Life map: memories tagged "[area:work]" are grouped by area; untagged ones come last.
  const groups = useMemo(() => {
    const by = new Map<string | null, Memory[]>();
    for (const m of list) {
      const area = parseArea(m.content).area;
      by.set(area, [...(by.get(area) ?? []), m]);
    }
    return [...by]
      .sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : a[0].localeCompare(b[0])))
      .map(([area, items]) => ({ area, items }));
  }, [list]);

  const add = async () => {
    if (!draft.trim()) return;
    const added = await run(
      api().call("memory.add", {
        content: draft.trim(),
        agentId: null,
        space: addLabel === "everywhere" ? null : addLabel,
      }),
      "Couldn't remember that",
    );
    if (added) setDraft("");
  };

  const agentOpts = sortAgents(agents).map((a) => ({
    value: a.id,
    label: a.name,
    icon: <AgentAvatar agent={a} size={18} state="idle" quiet />,
  }));
  // The agent filter is only for memories a teammate keeps to itself.
  const showAgentFilter = all.some((m) => m.agentId !== null);

  return (
    <PageShell
      title={userName ? `About ${userName}` : "About you"}
      subtitle="What Yo remembers. Edit or remove anything here."
      actions={
        memories ? (
          <div className="flex items-center gap-1.5">
            <LabelFilterMenu value={labelFilter} onChange={setLabelFilter} counts={counts} />
            {showAgentFilter && (
              <div className="w-40">
                <Select
                  value={agentFilter}
                  onChange={setAgentFilter}
                  label="Whose memories"
                  testId="memory-agent-filter"
                  options={[
                    { value: "all", label: "All agents" },
                    { value: "shared", label: "Shared" },
                    ...agentOpts,
                  ]}
                />
              </div>
            )}
          </div>
        ) : undefined
      }
    >
      <form
        className="mb-5 flex items-center gap-2 rounded-2xl border border-border-strong/70 bg-card p-1.5 pl-4 shadow-soft focus-within:border-border-strong max-sm:flex-wrap max-sm:pl-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <Plus className="size-4 text-muted max-sm:hidden" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          data-testid="memory-input"
          aria-label="Add a memory"
          placeholder="Add something Yo should remember, e.g. “I'm vegetarian”"
          className="h-9 min-w-0 flex-1 bg-transparent text-md outline-none max-sm:basis-full max-sm:px-2.5"
        />
        <div className="w-36 max-sm:flex-1">
          <Select<LabelKey>
            value={addLabel}
            onChange={setAddLabel}
            label="Label"
            testId="memory-add-label"
            options={LABEL_CHOICES.map((c) => ({
              value: c.key,
              label: c.label,
              icon: <LabelIcon label={c.key} className="size-3.5 text-muted" />,
            }))}
            className="h-8 border-transparent bg-active/60"
          />
        </div>
        <Button type="submit" variant="primary" disabled={!draft.trim()} data-testid="memory-add">
          Remember
        </Button>
      </form>

      {memories && counts.everywhere > 0 && (labelFilter === "all" || labelFilter === "everywhere") && (
        <div
          data-testid="memory-everywhere-hint"
          className="mb-4 flex items-start gap-2 px-1 text-muted text-sm"
        >
          <Globe className="mt-[3px] size-3.5 shrink-0" />
          <span>
            A memory's label decides who sees it.{" "}
            <span className="font-medium text-fg-2">{counts.everywhere} labelled Everywhere</span>: facts
            every agent sees. Label any that are just for work or just personal.
            {labelFilter === "all" && (
              <>
                {" "}
                <button
                  type="button"
                  className="text-link-ink hover:underline"
                  onClick={() => setLabelFilter("everywhere")}
                >
                  Show them
                </button>
              </>
            )}
          </span>
        </div>
      )}

      <LoadState ready={!!memories} {...status} what="what Yo remembers" />
      {!memories ? null : list.length === 0 ? (
        <EmptyNote
          icon={<Brain />}
          title="Nothing here yet"
          body={
            labelFilter !== "all"
              ? `Nothing labelled ${LABEL[labelFilter]} yet. Use a memory's badge to label it.`
              : "Save the details you want Yo to remember."
          }
        />
      ) : (
        <div className="space-y-5" data-testid="memory-list">
          {groups.map((g) => (
            <section key={g.area ?? "none"} data-testid={g.area ? `memory-area-${g.area}` : undefined}>
              {/* Only when something is tagged: otherwise the page looks exactly as before. */}
              {groups.some((x) => x.area) && (
                <h2 className="mb-1.5 px-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
                  {g.area ? g.area.replace(/-/g, " ") : "General"}
                </h2>
              )}
              <div className="divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card shadow-card">
                {g.items.map((m) => (
                  <MemoryRow key={m.id} m={m} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
