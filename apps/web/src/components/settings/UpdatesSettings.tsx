/**
 * Settings → About: versions, "Check for updates", and the update status in words. Its Restart, Reload and
 * Download buttons open the update window, like the notice does.
 */
import { ArrowUpRight } from "lucide-react";
import { useState } from "react";
import { useBrowserAuth } from "../../lib/browserAuth";
import { desktopStatusText, isGithubDownload, pendingServerUpdate } from "../../lib/updates";
import { updates, useUpdates } from "../../stores/updates";
import { CopyBox } from "../connect/parts";
import { Button } from "../ui/button";
import { Group, Row } from "./parts";

export function UpdatesSettings() {
  const desktop = useUpdates((s) => s.desktop);
  const ownBuild = useUpdates((s) => s.ownBuild);
  const server = useUpdates((s) => s.server);
  const refresh = useUpdates((s) => s.refresh);
  const webCheckedAt = useUpdates((s) => s.webCheckedAt);
  const [checking, setChecking] = useState(false);
  // The PC edition updates with its helper on the PC (`yo-app update`), not from this page.
  const browser = useBrowserAuth((s) => s.browserMode);
  const helper = useBrowserAuth((s) => s.info?.helperCommand) || "yo-app";
  const release = browser ? server?.release : null;
  const applying = useUpdates((s) => s.applying);

  const check = async () => {
    setChecking(true);
    try {
      await updates.checkNow();
    } finally {
      setChecking(false);
    }
  };
  const busy = checking || desktop?.status === "checking";
  const checkButton = (
    <Button size="sm" data-testid="check-updates" disabled={busy} onClick={() => void check()}>
      {busy ? "Checking…" : "Check for updates"}
    </Button>
  );

  const serverBuild = server?.web ?? server?.build ?? null;
  const pending = pendingServerUpdate(server);
  const result = server?.server?.lastResult;
  const serverApplying = applying?.kind === "server";
  const serverText = !ownBuild
    ? "Development build: no update checks."
    : serverApplying
      ? "Updating now."
      : pending
        ? "An update is ready. Restart when it suits you."
        : refresh
          ? `A new version is on the server (${serverBuild}). Reload to use it.`
          : result && !result.ok
            ? `Last update didn't finish: ${result.message}`
            : webCheckedAt
              ? "Up to date"
              : "Not checked yet";

  return (
    <Group title="Updates" testId="settings-updates">
      <div className="divide-y divide-border rounded-2xl border border-border bg-card px-4 shadow-card">
        {desktop && (
          <Row
            title={`Yo app ${desktop.currentVersion}`}
            desc={<span data-testid="desktop-update-status">{desktopStatusText(desktop)}</span>}
          >
            {desktop.status === "downloaded" ? (
              <Button
                size="sm"
                variant="primary"
                data-testid="settings-app-restart"
                disabled={!!applying}
                onClick={() => updates.open()}
              >
                Restart to update
              </Button>
            ) : isGithubDownload(desktop) ? (
              <Button
                size="sm"
                variant="primary"
                data-testid="settings-update-download"
                onClick={() => updates.open()}
              >
                Download
              </Button>
            ) : desktop.status !== "disabled" ? (
              checkButton
            ) : null}
          </Row>
        )}
        <Row
          title={ownBuild ? `Server build ${serverBuild ?? ownBuild}` : "Server"}
          desc={<span data-testid="web-update-status">{serverText}</span>}
        >
          {pending || serverApplying ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="settings-server-restart"
              onClick={() => updates.open()}
            >
              {serverApplying ? "Show progress" : "Restart to update"}
            </Button>
          ) : refresh ? (
            <Button
              size="sm"
              variant="primary"
              data-testid="settings-server-reload"
              disabled={!!applying}
              onClick={() => updates.open()}
            >
              Reload
            </Button>
          ) : !desktop && ownBuild ? (
            checkButton
          ) : null}
        </Row>
      </div>
      {release && (
        <div
          className="mt-3 rounded-2xl border border-border bg-card px-4 py-3.5 shadow-card"
          data-testid="release-update"
        >
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-0 flex-1 basis-60">
              <div className="font-medium">Yo {release.version} is available</div>
              <div className="text-muted text-sm">
                To update, run <code className="font-mono text-fg-2">{helper} update</code> on the PC running
                Yo.
              </div>
            </div>
            <a
              href={release.url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-fg-2 text-sm underline-offset-2 hover:text-fg hover:underline"
              data-testid="release-notes"
            >
              What's new <ArrowUpRight className="size-3.5" />
            </a>
          </div>
          <CopyBox command={`${helper} update`} testId="release-command" />
        </div>
      )}
    </Group>
  );
}
