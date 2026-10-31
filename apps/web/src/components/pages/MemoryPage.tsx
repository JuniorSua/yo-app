import { YoLogo } from "@yo/avatar";
import { agentForSpace, type Memory, parseArea, type Space } from "@yo/contracts";
import { Brain, Check, ChevronDown, Globe, Pencil, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { api } from "../../lib/api";
import {
  defaultMemorySpace,
  filterMemories,
  memorySpace,
  SPACE_CHOICES,
  type SpaceFilter,
  spaceCounts,
} from "../../lib/memoryFilter";
import { ago, cn } from "../../lib/utils";
import { sortAgents, useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { useUI } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { LoadState, useLoad } from "../LoadState";
import { EmptyNote, PageShell } from "../PageHeader";
import { SPACE_ICON, SPACE_TINT } from "../settings/SpacesSettings";
import { Button } from "../ui/button";
import { Segmented, Select } from "../ui/controls";
import { Menu, MenuItem } from "../ui/overlay";

type SpaceKey = Space | "everywhere";
const keyOf = (s: Space | null): SpaceKey => s ?? "everywhere";
const LABEL: Record<SpaceKey, string> = { work: "Work", personal: "Personal", everywhere: "Everywhere" };

function SpaceIcon({ space, className }: { space: SpaceKey; className?: string }) {
  const Icon = space === "everywhere" ? Globe : SPACE_ICON[space];
  return <Icon className={className} strokeWidth={2} />;
}

/** Who sees a memory in each space, by agent name ("Only Yo", "Yo and Pip"). */
function useSpaceAgents() {
  const agents = useApp((s) => s.agents);
  return useMemo(() => {
    const list = Object.values(agents);
    const work = agentForSpace(list, "work", true)?.name ?? "Yo";
    const personal = list.find((a) => a.space === "personal" && !a.archivedAt)?.name ?? "your Personal agent";
    return {
      work: `Only ${work} sees it`,
      personal: `Only ${personal} sees it`,
      everywhere: `${work} and ${personal} both see it`,
    } satisfies Record<SpaceKey, string>;
  }, [agents]);
}

/** The small space badge on a memory; it opens "Move to…". */
function SpaceBadge({ m }: { m: Memory }) {
  const current = keyOf(memorySpace(m));
  const who = useSpaceAgents();
  const move = (space: Space | null) => {
    if (keyOf(space) === current) return;
    void run(api().call("memory.update", { id: m.id, content: m.content, space }), "Couldn't move it");
  };
  return (
    <Menu
      align="start"
      testId="memory-move-menu"
      className="min-w-60"
      trigger={
        <button
          type="button"
          data-testid="memory-space-badge"
          data-space={current}
          aria-label={`${LABEL[current]}. Move to another space`}
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-1.5 pr-1 font-medium text-2xs transition-[filter,box-shadow] hover:brightness-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-link/50 data-[popup-open]:ring-2 data-[popup-open]:ring-border-strong dark:hover:brightness-125",
            current === "everywhere" ? "bg-active text-fg-2" : SPACE_TINT[current],
          )}
        >
          <SpaceIcon space={current} className="size-3" />
          {LABEL[current]}
          <ChevronDown className="size-2.5 opacity-60" />
        </button>
      }
    >
      <div className="px-2.5 pt-1.5 pb-1 font-medium text-2xs text-muted uppercase tracking-[0.08em]">
        Move to…
      </div>
      {SPACE_CHOICES.map((c) => (
        <MenuItem
          key={c.key}
          testId={`memory-move-${c.key}`}
          className="h-auto py-1.5"
          icon={<SpaceIcon space={c.key} />}
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

function MemoryRow({ m, spaces }: { m: Memory; spaces: boolean }) {
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
          {spaces && <SpaceBadge m={m} />}
          <span>
            {a ? `${a.name} only · ` : spaces ? "" : "Shared workspace memory · "}
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
              onClick={async () => {
                const deleted = await run(api().call("memory.delete", { id: m.id }));
                if (!deleted) return;
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
  const focusedRecord = useUI((s) => s.focusRecordId);
  const memories = useApp((s) => s.memories);
  const agents = useApp((s) => s.agents);
  const settings = useApp((s) => s.settings);
  const userName = settings.userName;
  const spaces = settings.spacesOn === true;
  const [spaceFilter, setSpaceFilter] = useState<SpaceFilter>("all");
  const [agentFilter, setAgentFilter] = useState("all");
  useEffect(() => {
    if (!focusedRecord) return;
    setSpaceFilter("all");
    setAgentFilter("all");
  }, [focusedRecord]);
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState("shared");
  // Untouched, a new memory goes to the space you're in.
  const [pickedSpace, setPickedSpace] = useState<SpaceKey | null>(null);
  const addSpace: SpaceKey = pickedSpace ?? keyOf(defaultMemorySpace(settings));
  const status = useLoad(() => load.memories(true));

  const agentId = agentFilter === "all" ? null : agentFilter;
  const all = memories ?? [];
  const list = useMemo(
    () => filterMemories(memories ?? [], spaces ? spaceFilter : "all", agentId),
    [memories, spaces, spaceFilter, agentId],
  );
  const counts = useMemo(() => spaceCounts(memories ?? [], agentId), [memories, agentId]);

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
      api().call(
        "memory.add",
        spaces
          ? { content: draft.trim(), agentId: null, space: addSpace === "everywhere" ? null : addSpace }
          : { content: draft.trim(), agentId: scope === "shared" ? null : scope },
      ),
      "Couldn't remember that",
    );
    if (added) setDraft("");
  };

  const agentOpts = sortAgents(agents).map((a) => ({
    value: a.id,
    label: a.name,
    icon: <AgentAvatar agent={a} size={18} state="idle" quiet />,
  }));
  // With spaces on, the agent filter is only for memories an older teammate keeps to itself.
  const showAgentFilter = !spaces || all.some((m) => m.agentId !== null);

  const spaceOption = (key: SpaceFilter, label: string, icon?: ReactNode) => ({
    value: key,
    icon,
    label: (
      <>
        {label}
        <span className="text-faint tabular-nums">{counts[key]}</span>
      </>
    ),
  });

  return (
    <PageShell
      title={userName ? `About ${userName}` : "About you"}
      subtitle="What Yo remembers. Review, edit or remove the details you keep here."
      actions={
        showAgentFilter ? (
          <div className={spaces ? "w-40" : "w-48"}>
            <Select
              value={agentFilter}
              onChange={setAgentFilter}
              label="Whose memories"
              testId="memory-agent-filter"
              options={[
                { value: "all", label: spaces ? "All agents" : "All memories" },
                { value: "shared", label: "Shared" },
                ...agentOpts,
              ]}
            />
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
          placeholder="Add something Yo should remember, e.g. “I'm vegetarian”"
          className="h-9 min-w-0 flex-1 bg-transparent text-md outline-none max-sm:basis-full max-sm:px-2.5"
        />
        {spaces ? (
          <div className="w-36 max-sm:flex-1">
            <Select<SpaceKey>
              value={addSpace}
              onChange={setPickedSpace}
              label="Which space"
              testId="memory-add-space"
              options={SPACE_CHOICES.map((c) => ({
                value: c.key,
                label: c.label,
                icon: <SpaceIcon space={c.key} className="size-3.5 text-muted" />,
              }))}
              className="h-8 border-transparent bg-active/60"
            />
          </div>
        ) : (
          <div className="w-40 max-sm:flex-1">
            <Select
              value={scope}
              onChange={setScope}
              options={[{ value: "shared", label: "Workspace" }, ...agentOpts]}
              className="h-8 border-transparent bg-active/60"
            />
          </div>
        )}
        <Button type="submit" variant="primary" disabled={!draft.trim()} data-testid="memory-add">
          Remember
        </Button>
      </form>

      {spaces && memories && (
        <div className="mb-4 space-y-2.5">
          <div className="-mx-1 overflow-x-auto px-1 pb-0.5">
            <Segmented<SpaceFilter>
              value={spaceFilter}
              onChange={setSpaceFilter}
              className="[&>button]:gap-1.5 max-sm:flex max-sm:[&>button]:flex-1 max-sm:[&>button]:px-2 max-sm:[&_svg]:hidden"
              options={[
                spaceOption("all", "All"),
                spaceOption("work", "Work", <SpaceIcon space="work" />),
                spaceOption("personal", "Personal", <SpaceIcon space="personal" />),
                spaceOption("everywhere", "Everywhere", <SpaceIcon space="everywhere" />),
              ]}
            />
          </div>
          {counts.everywhere > 0 && (spaceFilter === "all" || spaceFilter === "everywhere") && (
            <div
              data-testid="memory-everywhere-hint"
              className="flex items-start gap-2 px-1 text-muted text-sm"
            >
              <Globe className="mt-[3px] size-3.5 shrink-0" />
              <span>
                <span className="font-medium text-fg-2">Everywhere ({counts.everywhere})</span> — facts both
                agents see. Sort any that belong to one space.
                {spaceFilter === "all" && (
                  <>
                    {" "}
                    <button
                      type="button"
                      className="text-link-ink hover:underline"
                      onClick={() => setSpaceFilter("everywhere")}
                    >
                      Show them
                    </button>
                  </>
                )}
              </span>
            </div>
          )}
        </div>
      )}

      <LoadState ready={!!memories} {...status} what="what Yo remembers" />
      {!memories ? null : list.length === 0 ? (
        <EmptyNote
          icon={<Brain />}
          title="Nothing here yet"
          body={
            spaces && spaceFilter !== "all"
              ? `Nothing in ${LABEL[spaceFilter]} yet. Use a memory's badge to move it here.`
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
                  <MemoryRow key={m.id} m={m} spaces={spaces} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </PageShell>
  );
}
