import { describe, expect, it } from "vitest";
import {
  type DesktopUpdateState,
  friendlyUpdateError,
  initialUpdateState,
  isNothingPublished,
  reduceUpdate,
  type UpdateEvent,
} from "./updateState";

const run = (events: UpdateEvent[], s: DesktopUpdateState = initialUpdateState("0.1.312", true)) =>
  events.reduce(reduceUpdate, s);

describe("update state machine", () => {
  it("stays disabled in development builds", () => {
    const s = initialUpdateState("0.1.0", false);
    expect(
      run(
        [
          { type: "check", at: 1 },
          { type: "available", version: "0.1.2", at: 2 },
        ],
        s,
      ),
    ).toBe(s);
    expect(s.status).toBe("disabled");
  });

  it("checks, finds nothing, and says when", () => {
    const s = run([
      { type: "check", at: 1 },
      { type: "none", at: 2 },
    ]);
    expect(s).toMatchObject({ status: "up-to-date", checkedAt: 2, availableVersion: null });
  });

  it("downloads a new build and becomes ready", () => {
    let s = run([
      { type: "check", at: 1 },
      { type: "available", version: "0.1.313", at: 2 },
    ]);
    expect(s).toMatchObject({ status: "available", availableVersion: "0.1.313", canRetry: false });
    s = run([{ type: "progress", percent: 41.5 }], s);
    expect(s).toMatchObject({ status: "downloading", percent: 41.5 });
    s = run([{ type: "progress", percent: 140 }], s);
    expect(s.percent).toBe(100);
    s = run([{ type: "downloaded", version: "0.1.313" }], s);
    expect(s).toMatchObject({ status: "downloaded", downloadedVersion: "0.1.313", canRetry: true });
  });

  it("keeps a downloaded build ready whatever later checks say", () => {
    const ready = run([
      { type: "available", version: "0.1.313", at: 1 },
      { type: "downloaded", version: "0.1.313" },
    ]);
    for (const e of [
      { type: "check", at: 5 },
      { type: "none", at: 6 },
      { type: "error", message: "offline" },
      { type: "progress", percent: 3 },
      { type: "available", version: "0.1.313", at: 7 },
    ] as UpdateEvent[]) {
      const s = reduceUpdate(ready, e);
      expect(s.status).toBe("downloaded");
      expect(s.downloadedVersion).toBe("0.1.313");
    }
  });

  it("doesn't restart a running download when a periodic check sees the same version", () => {
    const s = run([
      { type: "available", version: "0.1.313", at: 1 },
      { type: "progress", percent: 50 },
    ]);
    expect(reduceUpdate(s, { type: "check", at: 2 }).status).toBe("downloading");
    expect(reduceUpdate(s, { type: "available", version: "0.1.313", at: 3 })).toBe(s);
  });

  it("tells check errors from download errors, and both can be retried", () => {
    const check = run([
      { type: "check", at: 1 },
      { type: "error", message: "Couldn't reach Yo." },
    ]);
    expect(check).toMatchObject({ status: "error", errorContext: "check", canRetry: true });
    const download = run([
      { type: "available", version: "0.1.313", at: 1 },
      { type: "progress", percent: 20 },
      { type: "error", message: "damaged" },
    ]);
    expect(download).toMatchObject({
      status: "error",
      errorContext: "download",
      availableVersion: "0.1.313",
      percent: null,
      canRetry: true,
    });
    // Retrying goes back through a check.
    expect(reduceUpdate(download, { type: "check", at: 9 }).status).toBe("checking");
  });

  it("reports a failed install but keeps the build", () => {
    const s = run([
      { type: "available", version: "0.1.313", at: 1 },
      { type: "downloaded", version: "0.1.313" },
      { type: "install-failed", message: "nope" },
    ]);
    expect(s).toMatchObject({ status: "error", errorContext: "install", downloadedVersion: "0.1.313" });
  });
});

describe("github channel (public builds)", () => {
  const gh = () => initialUpdateState("0.1.312", true, "github");
  const URL = "https://github.com/JuniorSua/yo-app/releases/tag/v0.1.313";

  it("starts on the channel it was built with; the feed is the default", () => {
    expect(gh()).toMatchObject({ status: "idle", channel: "github", releaseUrl: null });
    expect(initialUpdateState("0.1.312", true).channel).toBe("feed");
  });

  it("offers a newer release with its page, and nothing to download", () => {
    const s = run(
      [
        { type: "check", at: 1 },
        { type: "available", version: "0.1.313", url: URL, at: 2 },
      ],
      gh(),
    );
    expect(s).toMatchObject({
      status: "available",
      availableVersion: "0.1.313",
      releaseUrl: URL,
      percent: null,
      canRetry: false,
    });
    // A later check that finds nothing newer (e.g. it was installed by hand) clears it.
    expect(run([{ type: "none", at: 3 }], s)).toMatchObject({
      status: "up-to-date",
      availableVersion: null,
      releaseUrl: null,
    });
  });

  it("keeps a found release through a check that can't reach GitHub", () => {
    const s = run(
      [
        { type: "available", version: "0.1.313", url: URL, at: 1 },
        { type: "check", at: 2 },
        { type: "quiet", message: "later" },
      ],
      gh(),
    );
    expect(s).toMatchObject({ status: "available", releaseUrl: URL, message: null, errorContext: null });
  });

  it("is quiet, not an error, when the first check gets no answer", () => {
    const s = run(
      [
        { type: "check", at: 1 },
        { type: "quiet", message: "Couldn't check for updates right now." },
      ],
      gh(),
    );
    expect(s).toMatchObject({
      status: "idle",
      message: "Couldn't check for updates right now.",
      errorContext: null,
    });
    // Outside a check (or for a stale answer) it changes nothing.
    const upToDate = run([{ type: "none", at: 1 }], gh());
    expect(run([{ type: "quiet", message: "x" }], upToDate)).toBe(upToDate);
  });
});

describe("update errors", () => {
  it("treats an empty feed as nothing to update", () => {
    expect(isNothingPublished({ code: "ERR_UPDATER_CHANNEL_FILE_NOT_FOUND" })).toBe(true);
    expect(isNothingPublished(new Error("HttpError: 500"))).toBe(false);
  });

  it("keeps messages short and human", () => {
    expect(friendlyUpdateError(new Error("net::ERR_CONNECTION_REFUSED at …"))).toBe(
      "Couldn't reach Yo to check for updates.",
    );
    expect(friendlyUpdateError(new Error("HttpError: 401 Unauthorized\n  at x"))).toMatch(/signed in/);
    expect(friendlyUpdateError(new Error("sha512 checksum mismatch, expected abc"))).toMatch(/damaged/);
    expect(friendlyUpdateError(new Error("Code signature at URL … did not pass validation"))).toMatch(
      /signed like the installed Yo/,
    );
    expect(friendlyUpdateError(new Error(`x${"y".repeat(400)}`)).length).toBeLessThanOrEqual(160);
  });
});
