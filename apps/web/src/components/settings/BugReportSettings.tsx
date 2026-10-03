/**
 * Settings → Bug reports: where the reports your agent submits (after you say yes) go. With a GitHub token
 * they're filed as issues automatically; without one, each report card has an "Open on GitHub" button.
 * The token is write-only: core stores it (Keychain on a Mac) and only ever says whether one is set.
 * "Report a problem" opens GitHub's bug form directly, for when the agent can't help.
 */
import type { BugReportFiling } from "@yo/contracts";
import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { bugFormUrl } from "../../lib/bugForm";
import { WEB_BUILD } from "../../lib/updates";
import { run } from "../../stores/sync";
import { useUpdates } from "../../stores/updates";
import { Button } from "../ui/button";
import { Badge, Input } from "../ui/controls";
import { Group, H, Row } from "./parts";

export function BugReportSettings() {
  const [status, setStatus] = useState<BugReportFiling | null>(null);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  // Yo.app's version ("0.1.313"); in a browser, the web build ("313-abc1234") is the closest thing.
  const version = useUpdates((s) => s.desktop?.currentVersion) ?? WEB_BUILD;
  const formUrl = status ? bugFormUrl(status.repo, version) : null;

  useEffect(() => {
    void run(api().call("bugReports.status", {}), "Couldn't load bug report settings").then((s) => {
      if (!s) return;
      setStatus(s);
      setRepo(s.repo);
    });
  }, []);

  const save = async (patch: { token?: string | null; repo?: string | null }, done: string) => {
    setBusy(true);
    const s = await run(api().call("bugReports.configure", patch), "Couldn't save");
    setBusy(false);
    if (!s) return;
    setStatus(s);
    setRepo(s.repo);
    setToken("");
    toast.success(done);
  };

  return (
    <div data-testid="bug-report-settings">
      <H desc="When you ask your agent to report a bug, it looks into it, suggests a fix and asks before sending anything.">
        Bug reports
      </H>
      <div className="divide-y divide-border">
        <Row
          title="Report a problem yourself"
          desc="Opens the bug form on GitHub with your Yo version filled in. You need a free GitHub account. Or ask your agent to “report this bug”: it looks into it for you first."
        >
          {formUrl && (
            <a
              href={formUrl}
              target="_blank"
              rel="noreferrer"
              data-testid="bug-report-form"
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border-strong/70 bg-elevated px-2.5 font-medium text-sm shadow-soft transition-colors hover:border-border-strong hover:bg-hover"
            >
              Report a problem
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </Row>
        <Row
          title="Filing on GitHub"
          desc={
            status?.configured
              ? `Reports you approve are filed as issues in ${status.repo}.`
              : "No token: each report your agent writes gets an “Open on GitHub” button, and you send it with your own GitHub account."
          }
        >
          {status && (
            <Badge tone={status.configured ? "success" : "neutral"}>
              {status.configured ? "Set up" : "Not set up"}
            </Badge>
          )}
        </Row>
      </div>

      <Group title="GitHub token">
        <p className="mb-3 px-1 text-muted text-sm">
          A fine-grained token with <span className="text-fg-2">Issues: Read and write</span> on the
          repository. It stays on your Yo server and is never shown again.
        </p>
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (token.trim()) void save({ token: token.trim() }, "GitHub token saved");
          }}
        >
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={
              status?.configured ? "•••••••• (saved) — paste a new one to replace it" : "github_pat_…"
            }
            aria-label="GitHub token"
            data-testid="bug-token-input"
            className="min-w-0 flex-1 basis-60"
          />
          <Button
            type="submit"
            variant="primary"
            disabled={busy || !token.trim()}
            data-testid="bug-token-save"
          >
            Save token
          </Button>
          {status?.configured && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => save({ token: null }, "GitHub token removed")}
              data-testid="bug-token-clear"
            >
              Remove
            </Button>
          )}
        </form>
      </Group>

      <Group title="Repository">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save({ repo: repo.trim() || null }, "Repository saved");
          }}
        >
          <Input
            value={repo}
            onChange={(e) => setRepo(e.target.value)}
            placeholder={status?.defaultRepo ?? "owner/name"}
            aria-label="Repository"
            data-testid="bug-repo-input"
            className="min-w-0 flex-1 basis-60"
          />
          <Button type="submit" disabled={busy || !status || repo.trim() === status.repo}>
            Save
          </Button>
        </form>
        <p className="mt-2 px-1 text-muted text-xs">
          “owner/name”, e.g. {status?.defaultRepo ?? "JuniorSua/yo-app"} (the default). Secrets and your home
          folder are removed from reports before they're sent.
        </p>
      </Group>
    </div>
  );
}
