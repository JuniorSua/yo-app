import { ShieldCheck, ShieldX, Trash2 } from "lucide-react";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { ago, relTime } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load, run } from "../../stores/sync";
import { ui } from "../../stores/ui";
import { AgentAvatar } from "../brand";
import { ApprovalCard, AskUserCard } from "../cards/RequestCards";
import { EmptyNote, PageShell } from "../PageHeader";
import { Button } from "../ui/button";
import { Badge, SectionLabel } from "../ui/controls";

export function ApprovalsPage() {
  const approvals = useApp((s) => s.approvals);
  const rules = useApp((s) => s.rules);
  const agents = useApp((s) => s.agents);
  useEffect(() => {
    void load.approvals();
    void load.rules();
  }, []);

  return (
    <PageShell
      title="Approvals"
      subtitle="Anything with real-world consequences waits for your OK."
      icon={<ShieldCheck className="size-4 text-muted" />}
    >
      <SectionLabel className="mb-2.5">Waiting on you · {approvals.length}</SectionLabel>
      {approvals.length === 0 ? (
        <EmptyNote
          icon={<ShieldCheck />}
          title="You're all caught up"
          body="When an agent wants to buy, send or post something, it'll ask here first."
        />
      ) : (
        <div className="space-y-4">
          {approvals.map((e) => {
            const a = agents[e.agentId];
            return (
              <div key={e.id}>
                <button
                  onClick={() => ui.openAgent(e.agentId)}
                  className="mb-2 flex items-center gap-2 text-sm hover:underline"
                >
                  {a && <AgentAvatar agent={a} size={20} />}
                  <span className="font-medium">{a?.name ?? "Agent"}</span>
                  <span className="text-faint text-xs">{relTime(e.createdAt)}</span>
                </button>
                {e.request?.kind === "user_input" ? (
                  <AskUserCard entry={e} agentName={a?.name ?? "Agent"} />
                ) : (
                  <ApprovalCard entry={e} agentName={a?.name ?? "Agent"} compact />
                )}
              </div>
            );
          })}
        </div>
      )}

      <SectionLabel className="mt-10 mb-2.5">Saved rules</SectionLabel>
      <div
        className="overflow-hidden rounded-2xl border border-border bg-card shadow-card"
        data-testid="rules"
      >
        {(rules ?? []).length === 0 && (
          <div className="px-4 py-6 text-center text-muted text-sm">
            No saved rules. Choose “Always allow” on a request to add one.
          </div>
        )}
        {(rules ?? []).map((r, i) => {
          const a = r.agentId ? agents[r.agentId] : undefined;
          return (
            <div
              key={r.id}
              className={`flex items-center gap-3 px-4 py-3 ${i ? "border-border border-t" : ""}`}
            >
              <div
                className={`grid size-8 place-items-center rounded-xl ${r.decision === "allow" ? "bg-success/12 text-success" : "bg-danger/12 text-danger"}`}
              >
                {r.decision === "allow" ? <ShieldCheck className="size-4" /> : <ShieldX className="size-4" />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[12.5px]">{r.match}</div>
                <div className="text-muted text-xs">
                  {r.decision === "allow" ? "Always allow" : "Always deny"} · {a ? a.name : "All agents"} ·
                  added {ago(r.createdAt)}
                </div>
              </div>
              <Badge tone={r.decision === "allow" ? "success" : "danger"}>{r.decision}</Badge>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Delete rule"
                onClick={async () => {
                  await run(api().call("rules.delete", { id: r.id }));
                  void load.rules();
                }}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}
