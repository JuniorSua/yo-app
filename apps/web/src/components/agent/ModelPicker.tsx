import {
  type Account,
  type AgentView,
  type ModelInfo,
  ENABLED_PROVIDERS as PROVIDERS,
  type ProviderKind,
} from "@yo/contracts";
import { Check, ChevronDown, Info, LogIn } from "lucide-react";
import { useState } from "react";
import { accountDetail } from "../../lib/accounts";
import { api } from "../../lib/api";
import { cn } from "../../lib/utils";
import { accountFor, useApp } from "../../stores/app";
import { run } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { accountTone, PROVIDER_NAME, ProviderIcon, StatusDot } from "../brand";
import { Button } from "../ui/button";
import { Segmented } from "../ui/controls";
import { Popover } from "../ui/overlay";

export function shortModel(label: string | undefined | null) {
  return (label ?? "").replace(/^Claude /, "");
}

export function modelInfo(
  acc: Account | undefined,
  modelId: string | null | undefined,
): ModelInfo | undefined {
  if (!acc) return undefined;
  return acc.models.find((m) => m.id === modelId) ?? acc.models.find((m) => m.isDefault) ?? acc.models[0];
}

const EFFORT_LABEL: Record<string, string> = { minimal: "Min", low: "Low", medium: "Medium", high: "High" };

/** Pure picker body, reusable in dialogs. `onPick` receives the selection. */
export function ModelPickerPanel({
  accountId,
  model,
  effort,
  onPick,
  currentProvider,
  agentName,
}: {
  accountId: string | null;
  model: string | null;
  effort: string | null;
  onPick: (sel: { accountId: string; model: string; effort: string | null }) => void;
  currentProvider?: ProviderKind;
  agentName?: string;
}) {
  const accounts = useApp((s) => s.accounts);
  const [focus, setFocus] = useState<string | null>(
    accountId ?? accounts.find((a) => a.isDefault)?.id ?? null,
  );
  const acc = accounts.find((a) => a.id === focus);
  const usable = acc?.status === "authenticated";
  const selectedModel = acc && acc.id === accountId ? model : null;
  const current = acc?.models.find((m) => m.id === selectedModel);
  const efforts = current?.efforts ?? [];

  return (
    <div className="flex w-[560px] max-w-[calc(100vw-32px)]" data-testid="model-picker">
      <div className="w-[208px] shrink-0 border-border border-r p-1.5">
        {PROVIDERS.map((p) => {
          const list = accounts.filter((a) => a.provider === p);
          if (!list.length) return null;
          return (
            <div key={p} className="mb-1">
              <div className="px-2.5 pt-2 pb-1 font-medium text-2xs text-faint uppercase tracking-[0.08em]">
                {PROVIDER_NAME[p]}
              </div>
              {list.map((a) => (
                <button
                  key={a.id}
                  data-testid={`picker-account-${a.label}`}
                  onClick={() => setFocus(a.id)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                    focus === a.id ? "bg-active" : "hover:bg-hover",
                  )}
                >
                  <ProviderIcon provider={a.provider} className="size-4" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium text-sm">{a.label}</div>
                    <div className="flex items-center gap-1.5 truncate text-2xs text-muted">
                      <StatusDot tone={accountTone(a)} />
                      {accountDetail(a)}
                    </div>
                  </div>
                  {a.id === accountId && <Check className="size-3.5 text-fg" />}
                </button>
              ))}
            </div>
          );
        })}
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {acc && usable ? (
          <>
            <div className="flex-1 p-1.5">
              <div className="px-2.5 pt-2 pb-1 font-medium text-2xs text-faint uppercase tracking-[0.08em]">
                Model
              </div>
              {acc.models.map((m) => {
                const active = acc.id === accountId && m.id === model;
                return (
                  <button
                    key={m.id}
                    data-testid={`picker-model-${m.id}`}
                    onClick={() =>
                      onPick({
                        accountId: acc.id,
                        model: m.id,
                        effort: m.efforts?.includes(effort ?? "")
                          ? effort
                          : m.efforts?.includes("medium")
                            ? "medium"
                            : (m.efforts?.[0] ?? null),
                      })
                    }
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors",
                      active ? "bg-active" : "hover:bg-hover",
                    )}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{m.label}</div>
                      {m.description && <div className="text-muted text-xs">{m.description}</div>}
                    </div>
                    {active && <Check className="mt-0.5 size-3.5 text-fg" />}
                  </button>
                );
              })}
            </div>
            {efforts.length > 0 && acc.id === accountId && (
              <div className="flex items-center justify-between gap-3 border-border border-t px-4 py-2.5">
                <span className="text-muted text-sm">Effort</span>
                <Segmented
                  size="sm"
                  value={effort ?? "medium"}
                  onChange={(v) => onPick({ accountId: acc.id, model: model ?? current!.id, effort: v })}
                  options={efforts.map((e) => ({ value: e, label: EFFORT_LABEL[e] ?? e }))}
                />
              </div>
            )}
            {currentProvider && acc.provider !== currentProvider && (
              <div
                className="flex items-start gap-2 border-border border-t bg-link/[0.05] px-4 py-2.5 text-fg-2 text-xs"
                data-testid="switch-note"
              >
                <Info className="mt-px size-3.5 shrink-0 text-link" />
                <span>
                  {agentName ?? "Yo"} keeps its memory; a fresh session starts on{" "}
                  {PROVIDER_NAME[acc.provider]}.
                </span>
              </div>
            )}
          </>
        ) : acc ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
            <div className="grid size-11 place-items-center rounded-2xl border border-border-strong/60 bg-card">
              <ProviderIcon provider={acc.provider} className="size-5" />
            </div>
            <div>
              <div className="font-medium">
                {acc.status === "not_installed"
                  ? `${PROVIDER_NAME[acc.provider]} isn't set up yet`
                  : `Sign in to ${acc.label}`}
              </div>
              <div className="mt-1 text-muted text-sm">
                {acc.message ?? "Use your own subscription with Yo."}
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => ui.openSettings("accounts")}>
              <LogIn className="size-3.5" />
              {acc.status === "not_installed" ? "Set up" : "Sign in"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export function ModelPicker({ agent }: { agent: AgentView }) {
  const accounts = useApp((s) => s.accounts);
  const acc = accountFor(agent, accounts);
  // On a fallback account (the agent's own is gone or hidden, e.g. Grok): its model and effort don't apply.
  const own = !agent.accountId || acc?.id === agent.accountId;
  const m = modelInfo(acc, own ? agent.model : null);
  const effort = own ? agent.effort : null;
  const [open, setOpen] = useState(false);
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      side="top"
      align="start"
      trigger={
        <button
          data-testid="model-picker-trigger"
          className="flex h-8 items-center gap-1.5 rounded-full px-2.5 text-fg-2 text-sm transition-colors hover:bg-hover hover:text-fg data-[popup-open]:bg-active"
        >
          {acc && <ProviderIcon provider={acc.provider} className="size-3.5" />}
          <span className="font-medium">{shortModel(m?.label) || "Choose model"}</span>
          {effort && m?.efforts?.length ? (
            <span className="text-muted">· {EFFORT_LABEL[effort] ?? effort}</span>
          ) : null}
          <ChevronDown className="size-3 text-muted" />
        </button>
      }
    >
      <ModelPickerPanel
        accountId={acc?.id ?? null}
        model={m?.id ?? null}
        effort={effort}
        currentProvider={acc?.provider}
        agentName={agent.name}
        onPick={(sel) => {
          void run(api().call("agent.update", { id: agent.id, patch: sel }));
          if (sel.model !== m?.id || sel.accountId !== acc?.id) setOpen(false);
        }}
      />
    </Popover>
  );
}
