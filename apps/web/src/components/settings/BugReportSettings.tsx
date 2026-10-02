/**
 * Settings → Bug reports: where the reports your agent submits (after you say yes) go. With a GitHub token
 * they're filed as issues automatically; without one, each report card has an "Open on GitHub" button.
 * The token is write-only: core stores it (Keychain on a Mac) and only ever says whether one is set.
 */
import type { BugReportFiling } from "@yo/contracts";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { run } from "../../stores/sync";
import { Button } from "../ui/button";
import { Badge, Input } from "../ui/controls";
import { Group, H, Row } from "./parts";

export function BugReportSettings() {
  const [status, setStatus] = useState<BugReportFiling | null>(null);
  const [token, setToken] = useState("");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);

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
          title="Filing on GitHub"
          desc={
            status?.configured
              ? `Reports you approve are filed as issues in ${status.repo}.`
              : "No token: each report gets an “Open on GitHub” button so you can file it with your own account."
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
