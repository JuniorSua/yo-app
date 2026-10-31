import { defaultColor, SOFTIE_ACCENTS, softieAvatar, softieInfo, softieOf } from "@yo/avatar";
import { type AgentDraft, type AgentView, nextTeammateSoftie, type SoftieKind } from "@yo/contracts";
import { Archive, ChevronDown } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { run } from "../stores/sync";
import { ui, useUI } from "../stores/ui";
import { AvatarStudio, SoftieColors, SoftieGrid } from "./AvatarStudio";
import { ModelPickerPanel, modelInfo, shortModel } from "./agent/ModelPicker";
import { ProviderIcon } from "./brand";
import { Button } from "./ui/button";
import { Field, Input, Segmented, Textarea } from "./ui/controls";
import { DialogTitle, Modal, Popover } from "./ui/overlay";

type Draft = Required<Pick<AgentDraft, "name" | "role" | "instructions" | "avatar">> & {
  accountId: string | null;
  model: string | null;
  effort: string | null;
  runtimeMode: NonNullable<AgentDraft["runtimeMode"]>;
};

type ModelSel = Pick<Draft, "accountId" | "model" | "effort">;

/** Which subscription and model an agent runs on: the account + model picker in a popover. */
function ModelField({ value, set }: { value: ModelSel; set: (p: Partial<ModelSel>) => void }) {
  const accounts = useApp((s) => s.accounts);
  const acc = accounts.find((a) => a.id === value.accountId) ?? accounts.find((a) => a.isDefault);
  const m = modelInfo(acc, value.model);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      trigger={
        <button
          type="button"
          data-testid="agent-model"
          className="flex h-9 w-full items-center gap-2 rounded-xl border border-border-strong/70 bg-bg/60 px-3 text-left hover:border-border-strong"
        >
          {acc && <ProviderIcon provider={acc.provider} className="size-4" />}
          <span className="min-w-0 flex-1 truncate">
            {acc ? `${acc.label} · ${shortModel(m?.label)}` : "Connect a subscription first"}
          </span>
          <ChevronDown className="size-3.5 text-muted" />
        </button>
      }
    >
      <ModelPickerPanel
        accountId={acc?.id ?? null}
        model={m?.id ?? null}
        effort={value.effort}
        onPick={(sel) => {
          set(sel);
          if (sel.model !== m?.id) setOpen(false);
        }}
      />
    </Popover>
  );
}

function AgentForm({
  draft,
  set,
  isPrimary,
}: {
  draft: Draft;
  set: (p: Partial<Draft>) => void;
  isPrimary?: boolean;
}) {
  return (
    <div className="space-y-5">
      <AvatarStudio value={draft.avatar} onChange={(avatar) => set({ avatar })} primary={isPrimary} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Dew"
            data-testid="agent-name"
          />
        </Field>
        <Field label="Role">
          <Input
            value={draft.role}
            onChange={(e) => set({ role: e.target.value })}
            placeholder="What it's for, in a word or two"
          />
        </Field>
      </div>
      <Field
        label="Their job"
        hint={
          isPrimary
            ? "Yo also keeps its own memory about you."
            : "How it should work, and what it should never do."
        }
      >
        <Textarea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={4}
          data-testid="agent-job"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Runs on">
          <ModelField value={draft} set={set} />
        </Field>
        <Field label="Permissions">
          <Segmented
            value={draft.runtimeMode}
            onChange={(runtimeMode) => set({ runtimeMode })}
            className="w-full [&>button]:flex-1"
            options={[
              { value: "approval-required", label: "Ask first" },
              { value: "auto", label: "Auto" },
              { value: "full-access", label: "Full" },
            ]}
          />
        </Field>
      </div>
    </div>
  );
}

/**
 * The colour a new teammate wears: its Softie's own, unless an active agent already wears that Softie in it, then
 * the first colour nobody wears with that Softie (two Dews can work side by side and still be told apart).
 */
function freshColor(kind: SoftieKind, agents: AgentView[]): string | undefined {
  const worn = new Set(
    agents
      .filter((a) => !a.archivedAt && a.kind !== "helper")
      .map((a) => softieOf(a.avatar, { primary: a.isPrimary }))
      .filter((l) => l.kind === kind)
      .map((l) => l.color.toLowerCase()),
  );
  if (!worn.has(defaultColor(kind).toLowerCase())) return undefined;
  // The four extras first: the team's six colours already mean Yo, Dew, Pico, Mochi, Clove and Kiki.
  const order = [...SOFTIE_ACCENTS.slice(6), ...SOFTIE_ACCENTS.slice(1, 6)];
  return order.find((c) => !worn.has(c.hex.toLowerCase()))?.hex;
}

/**
 * New teammate: pick a Softie, name it, say its job in one line, choose the subscription it runs on. It joins the
 * team, its chat opens, and it introduces itself with one question about the job.
 */
export function NewAgentDialog() {
  const open = useUI((s) => s.newAgentOpen);
  const agentMap = useApp((s) => s.agents);
  const accounts = useApp((s) => s.accounts);
  const runtimeMode = useApp((s) => s.settings.defaultRuntimeMode);
  const agents = useMemo(() => Object.values(agentMap), [agentMap]);
  const [kind, setKind] = useState<SoftieKind>("dew");
  const [color, setColor] = useState<string | undefined>();
  const [name, setName] = useState("");
  const [job, setJob] = useState("");
  const [touched, setTouched] = useState({ name: false, job: false });
  const [model, setModel] = useState<ModelSel>({ accountId: null, model: null, effort: "medium" });
  const [busy, setBusy] = useState(false);
  const info = softieInfo(kind);
  const shown = color ?? defaultColor(kind);

  const choose = (k: SoftieKind, keep = touched) => {
    setKind(k);
    setColor(freshColor(k, agents));
    if (!keep.name) setName(softieInfo(k).name);
    if (!keep.job) setJob(softieInfo(k).job);
  };

  useEffect(() => {
    if (!open) return;
    const fresh = { name: false, job: false };
    setTouched(fresh);
    setModel({ accountId: accounts.find((a) => a.isDefault)?.id ?? null, model: null, effort: "medium" });
    choose(nextTeammateSoftie(agents).kind, fresh);
  }, [open]);

  const close = () => useUI.setState({ newAgentOpen: false });
  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const a = await run(
      api().call("agent.create", {
        name: name.trim(),
        role: info.role,
        instructions: job.trim(),
        avatar: softieAvatar(kind, color),
        ...model,
        runtimeMode,
        introduce: true,
      }),
      "Couldn't add the teammate",
    );
    setBusy(false);
    if (a) {
      close();
      ui.openAgent(a.id);
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => useUI.setState({ newAgentOpen: o })}
      bare
      className="w-[min(720px,calc(100vw-32px))]"
      testId="new-agent-dialog"
    >
      <form
        className="flex max-h-[calc(100vh-48px)] flex-col"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <div className="px-6 pt-5 pb-4">
          <DialogTitle className="font-semibold text-lg tracking-[-0.01em]">New teammate</DialogTitle>
          <p className="mt-0.5 text-muted text-sm">
            Pick a character and give it a job. It gets its own computer and its own memory.
          </p>
        </div>
        <div className="scroll-fade min-h-0 flex-1 space-y-5 overflow-y-auto px-6 pb-6 [--scroll-fade:24px]">
          <SoftieGrid
            value={kind}
            color={shown}
            onPick={(k) => choose(k)}
            size="card"
            testPrefix="new-softie"
          />
          <div className="flex items-center justify-between gap-4">
            <span className="font-medium text-fg-2 text-sm">Colour</span>
            <SoftieColors kind={kind} value={shown} onPick={setColor} />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name">
              <Input
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  setTouched((t) => ({ ...t, name: true }));
                }}
                placeholder={info.name}
                data-testid="agent-name"
              />
            </Field>
            <Field label="Runs on">
              <ModelField value={model} set={(p) => setModel((m) => ({ ...m, ...p }))} />
            </Field>
          </div>
          <Field label="What's their job?" hint="One line is plenty. They'll ask you about the rest.">
            <Input
              value={job}
              onChange={(e) => {
                setJob(e.target.value);
                setTouched((t) => ({ ...t, job: true }));
              }}
              placeholder={info.job}
              data-testid="agent-job"
            />
          </Field>
        </div>
        <div className="flex items-center justify-end gap-2 border-border border-t px-6 py-3.5">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" variant="primary" disabled={busy || !name.trim()} data-testid="create-agent">
            Add {name.trim() || "teammate"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

export function AgentSettingsDialog() {
  const id = useUI((s) => s.agentSettingsId);
  const agent = useApp((s) => (id ? s.agents[id] : undefined));
  const accounts = useApp((s) => s.accounts);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!agent) return;
    // Pinned to an account Yo doesn't show (its provider was taken out of ENABLED_PROVIDERS): start from the default account, so
    // saving doesn't send core an account it refuses.
    const shown = !agent.accountId || accounts.some((a) => a.id === agent.accountId);
    setDraft({
      name: agent.name,
      role: agent.role,
      instructions: agent.instructions,
      avatar: { ...agent.avatar },
      accountId: shown ? agent.accountId : null,
      model: shown ? agent.model : null,
      effort: shown ? agent.effort : null,
      runtimeMode: agent.runtimeMode,
    });
  }, [id]);

  const close = () => useUI.setState({ agentSettingsId: null });
  const save = async () => {
    if (!agent || !draft) return;
    setBusy(true);
    const r = await run(api().call("agent.update", { id: agent.id, patch: draft }));
    setBusy(false);
    if (r) close();
  };

  return (
    <Modal
      open={!!agent}
      onOpenChange={(o) => !o && close()}
      bare
      className="w-[min(760px,calc(100vw-32px))]"
      testId="agent-settings-dialog"
    >
      {agent && draft && (
        <div className="flex max-h-[calc(100vh-48px)] flex-col">
          <div className="px-6 pt-5 pb-4">
            <DialogTitle className="font-semibold text-lg tracking-[-0.01em]">
              {agent.name} settings
            </DialogTitle>
            <p className="text-muted text-sm">Changes apply from the next message.</p>
          </div>
          <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pb-6 [--scroll-fade:24px]">
            <AgentForm
              draft={draft}
              set={(p) => setDraft((d) => (d ? { ...d, ...p } : d))}
              isPrimary={agent.isPrimary}
            />
          </div>
          <div className={cn("flex items-center gap-2 border-border border-t bg-bg/30 px-6 py-3.5")}>
            {/* The main agents stay: Yo always, Pip until Work & Personal is turned off in Settings. */}
            {!agent.isPrimary && !agent.space && (
              <Button
                variant="ghost"
                className="text-danger hover:text-danger"
                onClick={async () => {
                  await run(api().call("agent.archive", { id: agent.id }));
                  close();
                }}
              >
                <Archive className="size-3.5" /> Archive
              </Button>
            )}
            <div className="flex-1" />
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={save}
              disabled={busy || !draft.name.trim()}
              data-testid="save-agent"
            >
              Save
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
