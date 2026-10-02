import type { Artifact } from "@yo/contracts";
import { Download, FileImage, FileSpreadsheet, FileText, Shapes } from "lucide-react";
import { useEffect } from "react";
import { api } from "../../lib/api";
import { ago, cn, fileSize } from "../../lib/utils";
import { useApp } from "../../stores/app";
import { load } from "../../stores/sync";
import { AgentAvatar } from "../brand";
import { EmptyNote, PageShell } from "../PageHeader";

function Preview({ a }: { a: Artifact }) {
  const ext = a.path.split(".").pop()?.toLowerCase() ?? "";
  const Icon = a.mime.startsWith("image/")
    ? FileImage
    : /csv|xls|sheet/.test(a.mime + ext)
      ? FileSpreadsheet
      : FileText;
  const tint = a.mime.startsWith("image/")
    ? "from-[#f472b6]/20"
    : /csv|sheet/.test(a.mime)
      ? "from-success/20"
      : a.mime === "application/pdf"
        ? "from-danger/20"
        : "from-link/20";
  return (
    <div
      className={`relative grid h-32 place-items-center overflow-hidden rounded-t-2xl bg-gradient-to-br ${tint} to-transparent`}
    >
      <div className="absolute inset-x-8 top-6 bottom-0 rounded-t-lg border border-border-strong/50 border-b-0 bg-card/80 p-3 shadow-soft">
        <div className="space-y-1.5">
          <div className="h-1.5 w-2/3 rounded bg-fg/15" />
          <div className="h-1.5 w-full rounded bg-fg/8" />
          <div className="h-1.5 w-5/6 rounded bg-fg/8" />
          <div className="h-1.5 w-3/4 rounded bg-fg/8" />
        </div>
      </div>
      <div className="absolute right-3 bottom-3 grid size-8 place-items-center rounded-lg border border-border-strong/60 bg-elevated shadow-soft">
        <Icon className="size-4 text-muted" />
      </div>
      <span className="absolute top-3 left-3 rounded-md bg-fg/85 px-1.5 py-0.5 font-semibold text-[10px] text-bg uppercase">
        {ext}
      </span>
    </div>
  );
}

export function ArtifactsPage() {
  const artifacts = useApp((s) => s.artifacts);
  const agents = useApp((s) => s.agents);
  useEffect(() => {
    void load.artifacts(true);
  }, []);
  return (
    <PageShell
      title="Artifacts"
      subtitle="Files your agents made for you."
      icon={<Shapes className="size-4 text-muted" />}
      wide
    >
      {artifacts && artifacts.length === 0 && (
        <EmptyNote
          icon={<Shapes />}
          title="No artifacts yet"
          body="Reports, spreadsheets and files your agents save will appear here."
        />
      )}
      <div
        className="grid grid-cols-[repeat(auto-fill,minmax(230px,1fr))] gap-4"
        data-testid="artifacts-grid"
      >
        {(artifacts ?? []).map((a) => {
          const agent = agents[a.agentId];
          return (
            <div
              key={a.id}
              data-kind={a.kind ?? "file"}
              className={cn(
                "group overflow-hidden rounded-2xl border bg-card transition-all duration-200 hover:-translate-y-0.5 hover:shadow-soft",
                a.kind === "bug"
                  ? "border-danger/50 hover:border-danger"
                  : "border-border hover:border-border-strong",
              )}
            >
              <Preview a={a} />
              <div className="flex items-center gap-2.5 border-border border-t p-3">
                {agent && <AgentAvatar agent={agent} size={24} state="idle" quiet />}
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-medium text-sm", a.kind === "bug" && "text-danger")}>
                    {a.title}
                  </div>
                  <div className="truncate text-muted text-xs">
                    {fileSize(a.size)} · {ago(a.createdAt)}
                  </div>
                </div>
                <a
                  href={api().artifactUrl(a.id)}
                  download={a.path.split("/").pop()}
                  aria-label={`Download ${a.title}`}
                  className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-fg"
                >
                  <Download className="size-4" />
                </a>
              </div>
            </div>
          );
        })}
      </div>
    </PageShell>
  );
}
