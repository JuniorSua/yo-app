import { AGENT_TEMPLATES, type AgentTemplate, Avatar, randomAvatar } from "@yo/avatar";
import type { AgentDraft } from "@yo/contracts";
import { Archive, ArrowLeft, ChevronDown, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import { useApp } from "../stores/app";
import { run } from "../stores/sync";
import { ui, useUI } from "../stores/ui";
import { AvatarStudio } from "./AvatarStudio";
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

function ModelField({ draft, set }: { draft: Draft; set: (p: Partial<Draft>) => void }) {
  const accounts = useApp((s) => s.accounts);
  const acc = accounts.find((a) => a.id === draft.accountId) ?? accounts.find((a) => a.isDefault);
  const m = modelInfo(acc, draft.model);
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      trigger={
        <button className="flex h-9 w-full items-center gap-2 rounded-[10px] border border-border-strong/70 bg-bg/60 px-3 text-left hover:border-border-strong">
          {acc && <ProviderIcon provider={acc.provider} className="size-4" />}
          <span className="min-w-0 flex-1 truncate">
            {acc?.label} · {shortModel(m?.label)}
          </span>
          <ChevronDown className="size-3.5 text-muted" />
        </button>
      }
    >
      <ModelPickerPanel
        accountId={acc?.id ?? null}
        model={m?.id ?? null}
        effort={draft.effort}
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
      <AvatarStudio value={draft.avatar} onChange={(avatar) => set({ avatar })} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input
            value={draft.name}
            onChange={(e) => set({ name: e.target.value })}
            placeholder="e.g. Scout"
            data-testid="agent-name"
          />
        </Field>
        <Field label="Role">
          <Input
            value={draft.role}
            onChange={(e) => set({ role: e.target.value })}
            placeholder="What it's for, in a few words"
          />
        </Field>
      </div>
      <Field
        label="Instructions"
        hint={
          isPrimary
            ? "Yo also keeps its own memory about you."
            : "How it should work, what it should never do."
        }
      >
        <Textarea
          value={draft.instructions}
          onChange={(e) => set({ instructions: e.target.value })}
          rows={4}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Subscription & model">
          <ModelField draft={draft} set={set} />
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

function fromTemplate(
  t: AgentTemplate | null,
  defaults: { accountId: string | null; runtimeMode: Draft["runtimeMode"] },
): Draft {
  return {
    name: t?.name ?? "",
    role: t?.role ?? "",
    instructions: t?.instructions ?? "",
    avatar: t ? { ...t.avatar } : randomAvatar(),
    accountId: defaults.accountId,
    model: null,
    effort: "medium",
    runtimeMode: defaults.runtimeMode,
  };
}

export function NewAgentDialog() {
  const open = useUI((s) => s.newAgentOpen);
  const accounts = useApp((s) => s.accounts);
  const runtimeMode = useApp((s) => s.settings.defaultRuntimeMode);
  const [step, setStep] = useState<"pick" | "edit">("pick");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const defaults = { accountId: accounts.find((a) => a.isDefault)?.id ?? null, runtimeMode };

  useEffect(() => {
    if (open) {
      setStep("pick");
      setDraft(null);
    }
  }, [open]);

  const close = () => useUI.setState({ newAgentOpen: false });
  const pick = (t: AgentTemplate | null) => {
    setDraft(fromTemplate(t, defaults));
    setStep("edit");
  };

  const create = async () => {
    if (!draft?.name.trim()) return;
    setBusy(true);
    const a = await run(
      api().call("agent.create", { ...draft, name: draft.name.trim() }),
      "Couldn't create agent",
    );
    setBusy(false);
    if (a) {
      close();
      ui.openAgent(a.id);
      toast.success(`${a.name} is ready`, { description: "Say hi — it has its own computer." });
    }
  };

  return (
    <Modal
      open={open}
      onOpenChange={(o) => useUI.setState({ newAgentOpen: o })}
      bare
      className="w-[min(860px,calc(100vw-32px))]"
      testId="new-agent-dialog"
    >
      <div className="flex max-h-[calc(100vh-48px)] flex-col">
        <div className="flex items-center gap-3 px-6 pt-5 pb-4">
          {step === "edit" && (
            <Button variant="ghost" size="icon-sm" aria-label="Back" onClick={() => setStep("pick")}>
              <ArrowLeft className="size-4" />
            </Button>
          )}
          <div>
            <DialogTitle className="font-semibold text-lg tracking-[-0.01em]">
              {step === "pick" ? "New agent" : "Customize your agent"}
            </DialogTitle>
            <p className="text-muted text-sm">
              {step === "pick"
                ? "Start from a template or build your own. Each agent gets its own computer."
                : "Give it a look, a name and a job."}
            </p>
          </div>
        </div>
        <div className="scroll-fade min-h-0 flex-1 overflow-y-auto px-6 pb-6 [--scroll-fade:24px]">
          {step === "pick" ? (
            <div className="grid grid-cols-3 gap-3">
              {AGENT_TEMPLATES.filter((t) => !t.primary).map((t) => (
                <button
                  key={t.id}
                  data-testid={`template-${t.id}`}
                  onClick={() => pick(t)}
                  className="group flex flex-col items-start rounded-2xl border border-border bg-bg/40 p-4 text-left transition-all duration-200 hover:-translate-y-0.5 hover:border-border-strong hover:bg-elevated hover:shadow-soft"
                >
                  <Avatar avatar={t.avatar} size={52} />
                  <div className="mt-3 font-semibold">{t.name}</div>
                  <div className="text-muted text-xs">{t.role}</div>
                  <div className="mt-2 text-fg-2 text-sm leading-snug">{t.blurb}</div>
                </button>
              ))}
              <button
                data-testid="template-custom"
                onClick={() => pick(null)}
                className="flex flex-col items-start rounded-2xl border border-border-strong border-dashed p-4 text-left transition-all duration-200 hover:border-fg/40 hover:bg-hover"
              >
                <div className="grid size-[52px] place-items-center rounded-2xl bg-active">
                  <Sparkles className="size-5 text-muted" />
                </div>
                <div className="mt-3 font-semibold">Start from scratch</div>
                <div className="text-muted text-xs">Custom agent</div>
                <div className="mt-2 text-fg-2 text-sm leading-snug">
                  Design the look, write the instructions, pick the model.
                </div>
              </button>
            </div>
          ) : (
            draft && <AgentForm draft={draft} set={(p) => setDraft((d) => (d ? { ...d, ...p } : d))} />
          )}
        </div>
        {step === "edit" && (
          <div className="flex items-center justify-end gap-2 border-border border-t bg-bg/30 px-6 py-3.5">
            <Button variant="ghost" onClick={close}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={create}
              disabled={busy || !draft?.name.trim()}
              data-testid="create-agent"
            >
              Create agent
            </Button>
          </div>
        )}
      </div>
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
    // Pinned to an account Yo doesn't show (e.g. Grok, from an older Yo): start from the default account, so
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
      className="w-[min(820px,calc(100vw-32px))]"
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
            {!agent.isPrimary && (
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
