/** Settings → About: versions, "Check for updates", and the update status in words. */
import { useState } from "react";
import { desktopStatusText, isGithubDownload } from "../../lib/updates";
import { updates, useUpdates } from "../../stores/updates";
import { Button } from "../ui/button";
import { Group, Row } from "./parts";

export function UpdatesSettings() {
  const desktop = useUpdates((s) => s.desktop);
  const ownBuild = useUpdates((s) => s.ownBuild);
  const server = useUpdates((s) => s.server);
  const refresh = useUpdates((s) => s.refresh);
  const webCheckedAt = useUpdates((s) => s.webCheckedAt);
  const [checking, setChecking] = useState(false);

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
  const serverText = !ownBuild
    ? "Development build: no update checks."
    : refresh
      ? `A new version is on the server (${serverBuild}). Refresh to load it.`
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
              <Button size="sm" variant="primary" onClick={() => void updates.install()}>
                Restart to update
              </Button>
            ) : isGithubDownload(desktop) ? (
              <Button
                size="sm"
                variant="primary"
                data-testid="settings-update-download"
                onClick={() => void updates.download()}
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
          {refresh ? (
            <Button size="sm" variant="primary" onClick={updates.refresh}>
              Refresh
            </Button>
          ) : !desktop && ownBuild ? (
            checkButton
          ) : null}
        </Row>
      </div>
    </Group>
  );
}
