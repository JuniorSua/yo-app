import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import {
  agentdListenPort,
  ComputerLifecycle,
  colimaNoMountArgs,
  computerDockerEnv,
  computerImagePlan,
  friendlyStartError,
  type HostExec,
  hasSourceCheckout,
  LOCAL_IMAGE,
  PUBLISHED_IMAGE,
  PullProgress,
  RECONNECTING,
  staleImageTags,
} from "./ComputerLifecycle";
import { LIMA_BOOT_OVERRIDE } from "./hostTools";

const GHCR = "ghcr.io/juniorsua/yo-computer";

describe("where the agent's computer image comes from", () => {
  it("builds from the source checkout when there is one (the owner's Mac, pnpm dev)", () => {
    expect(computerImagePlan({ computerImage: null, hasSourceCheckout: true })).toEqual({
      image: LOCAL_IMAGE,
      source: "build",
    });
  });

  it("pulls the image a public build pins to its own version, checkout or not", () => {
    for (const hasSourceCheckout of [true, false])
      expect(computerImagePlan({ computerImage: `${GHCR}:0.1.313`, hasSourceCheckout })).toEqual({
        image: `${GHCR}:0.1.313`,
        source: "pull",
      });
  });

  it("pulls the latest published image when there is neither", () => {
    expect(computerImagePlan({ computerImage: null, hasSourceCheckout: false })).toEqual({
      image: PUBLISHED_IMAGE,
      source: "pull",
    });
  });

  it("recognizes a checkout by compose.yaml and the Dockerfile", () => {
    const repo = path.resolve(import.meta.dirname, "..", "..", "..", "..");
    expect(hasSourceCheckout(repo)).toBe(true);
    // A downloaded Yo.app: whatever repoRoot it has, there is no checkout behind it.
    expect(hasSourceCheckout(fs.mkdtempSync(path.join(os.tmpdir(), "yo-no-checkout-")))).toBe(false);
  });

  it("wires the plan from config: YO_COMPUTER_IMAGE wins, the checkout path is unchanged", () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), "yo-app-"));
    const pinned = new ComputerLifecycle(
      loadConfig({ YO_REPO_ROOT: empty, YO_COMPUTER_IMAGE: ` ${GHCR}:0.1.313 ` }),
      "t".repeat(64),
    );
    expect(pinned.plan).toEqual({ image: `${GHCR}:0.1.313`, source: "pull" });
    const source = new ComputerLifecycle(loadConfig({}), "t".repeat(64));
    expect(source.plan).toEqual({ image: LOCAL_IMAGE, source: "build" });
    expect(loadConfig({ YO_COMPUTER_IMAGE: "" }).computerImage).toBeNull();
  });

  it("cleans up only older tags of the same image", () => {
    expect(
      staleImageTags(GHCR, "0.1.313", ["0.1.313", "0.1.312", "latest", "<none>", "", "0.1.300"]),
    ).toEqual([`${GHCR}:0.1.312`, `${GHCR}:0.1.300`]);
  });

  it("runs the computer in the Mac's time zone, not New York's", () => {
    const base = { colimaProfile: "yo", token: "t".repeat(64), image: `${GHCR}:0.1.313` };
    const env = computerDockerEnv({ ...base, timeZone: "Europe/Lisbon" });
    expect(env.YO_TZ).toBe("Europe/Lisbon");
    expect(env.DOCKER_CONTEXT).toBe("colima-yo");
    expect(env.YO_COMPUTER_IMAGE).toBe(`${GHCR}:0.1.313`);
    // Unset port: compose.runtime.yaml's own default (7801) would do the same.
    expect(env.YO_AGENTD_PORT).toBe("7801");
    // Can't tell: leave it to compose's default.
    expect(computerDockerEnv({ ...base, timeZone: null }).YO_TZ).toBe(process.env.YO_TZ);
  });

  it("publishes agentd on the configured host port, and 7801 when that port is unset", () => {
    const yaml = fs.readFileSync(
      path.resolve(import.meta.dirname, "..", "..", "..", "..", "computer", "compose.runtime.yaml"),
      "utf8",
    );
    expect(yaml).toMatch(/127\.0\.0\.1:\$\{YO_AGENTD_PORT:-7801\}:7801/);
    expect(yaml).not.toContain("127.0.0.1:7801:7801");
    expect(agentdListenPort("http://127.0.0.1:7801")).toBe(7801);
    expect(agentdListenPort("http://127.0.0.1:17801")).toBe(17801);
    expect(agentdListenPort("http://yo-computer")).toBe(7801);
    expect(agentdListenPort("not a url")).toBe(7801);
    const base = { colimaProfile: "yo", token: "t".repeat(64), image: "yo-computer:dev" };
    expect(computerDockerEnv(base).YO_AGENTD_PORT).toBe("7801");
    expect(computerDockerEnv({ ...base, agentdPort: 17801 }).YO_AGENTD_PORT).toBe("17801");
    expect(computerDockerEnv({ ...base, agentdPort: 0 }).YO_AGENTD_PORT).toBe("7801");
  });

  it("points Colima and Docker at Yo's folder, with the bundled bin first on PATH", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yo-env-"));
    const bundled = path.join(root, "Resources");
    for (const rel of [
      "bin/colima",
      "bin/lima",
      "bin/limactl",
      "bin/docker",
      "bin/docker-compose",
      "share/lima/lima-guestagent.Linux-aarch64.gz",
    ]) {
      const file = path.join(bundled, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "bin");
    }
    const data = path.join(root, "data");
    const home = path.join(root, "home");
    fs.mkdirSync(home);
    const env = computerDockerEnv({
      colimaProfile: "yo",
      token: "t".repeat(64),
      image: `${GHCR}:0.1.313`,
      timeZone: "Europe/Lisbon",
      dataDir: data,
      homeDir: home,
      bundledRoot: bundled,
    });
    expect(env.COLIMA_HOME).toBe(path.join(data, "colima"));
    expect(env.LIMA_HOME).toBe(path.join(data, "lima"));
    expect(env.DOCKER_CONFIG).toBe(path.join(data, "docker"));
    expect(env.DOCKER_CONTEXT).toBe("colima-yo");
    expect(env.YO_TZ).toBe("Europe/Lisbon");
    expect(String(env.PATH).startsWith(`${path.join(bundled, "bin")}:`)).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});

/** A fake host: answers colima/docker by their arguments and records every call. */
function fakeHost(answer: (cmd: string, args: string[]) => string | Error) {
  const calls: string[] = [];
  const exec: HostExec = async (cmd, args) => {
    calls.push(`${cmd} ${args.slice(0, 2).join(" ")}`);
    const r = answer(cmd, args);
    if (r instanceof Error) throw r;
    return { stdout: r };
  };
  return { calls, exec, hasBinary: async (_name: string) => true };
}

function lifecycle(host: { exec: HostExec; hasBinary: (name: string) => Promise<boolean> }) {
  const cfg = loadConfig({
    YO_REPO_ROOT: fs.mkdtempSync(path.join(os.tmpdir(), "yo-app-")),
    YO_COMPUTER_IMAGE: `${GHCR}:0.1.313`,
    YO_DATA_DIR: os.tmpdir(),
    YO_COLIMA_PROFILE: "yo-test",
  });
  return new ComputerLifecycle(cfg, "t".repeat(64), host);
}

const colimaStarts = (calls: string[]) => calls.filter((c) => c.startsWith("colima start")).length;

describe("starting the computer on this Mac", () => {
  it("repairs a half-started VM (a degraded first boot): force-stops it and starts it again", async () => {
    // Seen on a busy Mac: colima start exits 1 with the VM up but Docker never set up, and colima status fails
    // ("error retrieving current runtime: empty value") until the VM is stopped and started again.
    let starts = 0;
    let stopped = false;
    const host = fakeHost((cmd, args) => {
      if (cmd === "colima" && args[0] === "status")
        return starts >= 2 && stopped ? "" : new Error("error retrieving current runtime: empty value");
      if (cmd === "colima" && args[0] === "start") {
        starts++;
        return starts === 1
          ? new Error("error starting vm: error at 'creating and starting': exit status 1")
          : "";
      }
      if (cmd === "colima" && args[0] === "stop") {
        expect(args).toContain("--force");
        stopped = true;
      }
      return "";
    });
    const lc = lifecycle(host);
    const messages: string[] = [];
    lc.on("changed", () => messages.push(`${lc.runtime}: ${lc.message ?? ""}`));
    await lc.start();
    expect(lc.runtime).toBe("running");
    expect(starts).toBe(2);
    expect(host.calls).toContain("colima stop --force");
    expect(messages).toContain("starting: Restarting Yo's computer (the first try didn't finish)…");
  });

  it("also repairs a VM colima says it started while colima status still fails", async () => {
    // "Try again" after the case above, before this fix: colima start said "already running" and returned 0.
    let fixed = false;
    const host = fakeHost((cmd, args) => {
      if (cmd === "colima" && args[0] === "status") return fixed ? "" : new Error("empty value");
      if (cmd === "colima" && args[0] === "stop") fixed = true;
      return "";
    });
    const lc = lifecycle(host);
    await lc.start();
    expect(lc.runtime).toBe("running");
    expect(colimaStarts(host.calls)).toBe(2);
  });

  it("gives up after one repair, with a plain error instead of colima's log", async () => {
    const host = fakeHost((cmd, args) =>
      cmd === "colima" && (args[0] === "status" || args[0] === "start")
        ? Object.assign(new Error("Command failed: colima start"), {
            stderr: 'time="x" level=fatal msg="error starting vm: exit status 1"',
          })
        : "",
    );
    const lc = lifecycle(host);
    await expect(lc.start()).rejects.toThrow();
    expect(lc.runtime).toBe("error");
    expect(lc.message).not.toMatch(/level=|colima start/);
    expect(lc.message).toMatch(/Try again/);
    expect(colimaStarts(host.calls)).toBe(2);
  });

  it("doesn't retry a start that already timed out (that would double a 20-minute wait)", async () => {
    const host = fakeHost((cmd, args) =>
      cmd === "colima" && args[0] === "status"
        ? new Error("not running")
        : cmd === "colima" && args[0] === "start"
          ? Object.assign(new Error("Command failed"), { killed: true, signal: "SIGTERM" })
          : "",
    );
    const lc = lifecycle(host);
    await expect(lc.start()).rejects.toThrow();
    expect(colimaStarts(host.calls)).toBe(1);
    expect(lc.message).toMatch(/took too long/);
  });

  it("starts Colima with ssh-config off, so a space in Application Support is not written into ~/.ssh/config", async () => {
    let startArgs: string[] = [];
    let started = false;
    const host = fakeHost((cmd, args) => {
      if (cmd === "colima" && args[0] === "status") return started ? "" : new Error("not running");
      if (cmd === "colima" && args[0] === "start") {
        startArgs = args;
        started = true;
        return "";
      }
      return "";
    });
    const lc = lifecycle(host);
    await lc.start();
    expect(startArgs[0]).toBe("start");
    expect(startArgs).toContain("--ssh-config=false");
    expect(startArgs.join(" ")).not.toMatch(/ssh\/config|Include /);
  });

  it("starts Colima with --mount none, so the Mac home folder is not mounted into the VM", async () => {
    let startArgs: string[] = [];
    let started = false;
    const host = fakeHost((cmd, args) => {
      if (cmd === "colima" && args[0] === "version") return "colima version 0.10.3\ngit commit: 00f6c29\n";
      if (cmd === "colima" && args[0] === "status") return started ? "" : new Error("not running");
      if (cmd === "colima" && args[0] === "start") {
        startArgs = args;
        started = true;
        return "";
      }
      return "";
    });
    await lifecycle(host).start();
    const at = startArgs.indexOf("--mount");
    expect(at).toBeGreaterThan(0);
    expect(startArgs[at + 1]).toBe("none");
    expect(startArgs.filter((a) => a === "--mount")).toHaveLength(1);
  });

  it("still starts with an older Colima (no --mount none before 0.10) or when colima version fails", async () => {
    for (const version of [() => "colima version 0.9.1\n", () => new Error("boom")]) {
      let startArgs: string[] = [];
      let started = false;
      const host = fakeHost((cmd, args) => {
        if (cmd === "colima" && args[0] === "version") return version();
        if (cmd === "colima" && args[0] === "status") return started ? "" : new Error("not running");
        if (cmd === "colima" && args[0] === "start") {
          startArgs = args;
          started = true;
          return "";
        }
        return "";
      });
      await lifecycle(host).start();
      expect(startArgs[0]).toBe("start");
      expect(startArgs).not.toContain("--mount");
    }
  });

  it("finishes a Move that left the Docker disk behind before it asks Colima to start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "yo-stranded-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const payload = Buffer.from("containers/abc\nimage/overlay2/layer\nvolumes/data/_data\n");
    const oldDisk = path.join(home, ".colima", "_lima", "_disks", "colima-yo");
    fs.mkdirSync(oldDisk, { recursive: true });
    fs.writeFileSync(path.join(oldDisk, "datadisk"), payload);
    fs.symlinkSync(path.join(home, ".colima", "_lima", "colima-yo"), path.join(oldDisk, "in_use_by"));
    const instance = path.join(data, "lima", "colima-yo");
    fs.mkdirSync(instance, { recursive: true });
    fs.writeFileSync(
      path.join(instance, "lima.yaml"),
      "additionalDisks:\n  - name: colima-yo\n    format: false\n",
    );
    fs.mkdirSync(path.join(data, "colima", "yo"), { recursive: true });
    fs.writeFileSync(path.join(data, "colima", "yo", "colima.yaml"), "runtime: docker\n");
    fs.mkdirSync(path.join(data, "colima", "_store"), { recursive: true });
    fs.writeFileSync(
      path.join(data, "colima", "_store", "colima-yo.json"),
      `${JSON.stringify({ disk_formatted: true })}\n`,
    );
    fs.mkdirSync(data, { recursive: true });
    fs.writeFileSync(
      path.join(data, "vm-home.json"),
      `${JSON.stringify({ choice: "move", originalKept: false, at: 1 })}\n`,
    );
    const prevHome = process.env.YO_HOME;
    process.env.YO_HOME = home;
    try {
      const cfg = loadConfig({
        YO_REPO_ROOT: path.join(root, "repo"),
        YO_COMPUTER_IMAGE: `${GHCR}:0.1.313`,
        YO_DATA_DIR: data,
        YO_COLIMA_PROFILE: "yo",
      });
      let checked = false;
      const host = fakeHost(() => {
        if (!checked) {
          checked = true;
          expect(fs.existsSync(oldDisk)).toBe(false);
          expect(
            fs.readFileSync(path.join(data, "lima", "_disks", "colima-yo", "datadisk")).equals(payload),
          ).toBe(true);
        }
        return "";
      });
      const lc = new ComputerLifecycle(cfg, "t".repeat(64), host);
      await lc.start();
      expect(checked).toBe(true);
      expect(fs.readlinkSync(path.join(data, "lima", "_disks", "colima-yo", "in_use_by"))).toBe(instance);
      expect(fs.readFileSync(path.join(data, "lima", "_config", "override.yaml"), "utf8")).toBe(
        LIMA_BOOT_OVERRIDE,
      );
      expect(fs.existsSync(path.join(home, ".colima", "_lima", "_disks", "colima-yo"))).toBe(false);
    } finally {
      if (prevHome === undefined) delete process.env.YO_HOME;
      else process.env.YO_HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts straight away when the VM is up and the image is there (second launch)", async () => {
    const host = fakeHost(() => "");
    const lc = lifecycle(host);
    await lc.start();
    expect(lc.runtime).toBe("running");
    expect(colimaStarts(host.calls)).toBe(0);
    expect(host.calls).toContain("docker compose -p");
  });

  it("repairs a computer Yo can't reach: force-stops the VM and starts it again, saying 'Reconnecting…'", async () => {
    let vmUp = true;
    const host = fakeHost((cmd, args) => {
      if (cmd === "colima" && args[0] === "status") return vmUp ? "" : new Error("not running");
      if (cmd === "colima" && args[0] === "stop") {
        expect(args).toEqual(["stop", "--force", "--profile", "yo-test"]);
        vmUp = false;
      }
      if (cmd === "colima" && args[0] === "start") vmUp = true;
      return "";
    });
    const lc = lifecycle(host);
    await lc.start();
    const messages: string[] = [];
    lc.on("changed", () => messages.push(`${lc.runtime}: ${lc.message ?? ""}`));
    const repair = lc.repair();
    expect(lc.busy).toBe(true);
    await repair;
    expect(lc.busy).toBe(false);
    expect(lc.runtime).toBe("running");
    expect(host.calls.filter((c) => c === "colima stop --force")).toHaveLength(1);
    expect(colimaStarts(host.calls)).toBe(1);
    // One plain status line all along, not the first-run wording.
    const starting = messages.filter((m) => m.startsWith("starting"));
    expect(starting.length).toBeGreaterThan(0);
    expect(new Set(starting)).toEqual(new Set([`starting: ${RECONNECTING}`]));
    expect(messages.at(-1)).toBe("running: ");
  });

  it("says plainly when the Docker command is missing", async () => {
    const host = { ...fakeHost(() => ""), hasBinary: async (n: string) => n !== "docker" };
    const lc = lifecycle(host);
    await expect(lc.start()).rejects.toThrow();
    expect(lc.message).toMatch(/brew install docker docker-compose/);
  });

  it("keeps an existing ~/.colima VM instead of refusing to start, and deletes nothing", async () => {
    const base = process.platform === "darwin" ? "/tmp" : os.tmpdir();
    const root = fs.mkdtempSync(path.join(base, "yo-legacy-"));
    const home = path.join(root, "home");
    const data = path.join(root, "data");
    const disk = path.join(home, ".colima", "_lima", "colima-yo", "disk");
    fs.mkdirSync(path.dirname(disk), { recursive: true });
    fs.writeFileSync(disk, "vm-disk");
    fs.mkdirSync(path.join(home, ".colima", "yo"), { recursive: true });
    fs.writeFileSync(path.join(home, ".colima", "yo", "colima.yaml"), "runtime: docker\n");
    const prevHome = process.env.YO_HOME;
    process.env.YO_HOME = home;
    try {
      const cfg = loadConfig({
        YO_REPO_ROOT: path.join(root, "repo"),
        YO_COMPUTER_IMAGE: `${GHCR}:0.1.313`,
        YO_DATA_DIR: data,
        YO_COLIMA_PROFILE: "yo",
      });
      const host = fakeHost(() => "");
      const lc = new ComputerLifecycle(cfg, "t".repeat(64), host);
      await lc.start();
      expect(lc.runtime).toBe("running");
      expect(lc.message ?? "").not.toMatch(/Choose Keep or Move/);
      expect(host.calls.some((c) => c.startsWith("colima delete"))).toBe(false);
      expect(fs.readFileSync(disk, "utf8")).toBe("vm-disk");
      expect(fs.existsSync(path.join(data, "lima", "colima-yo"))).toBe(false);
      const choice = JSON.parse(fs.readFileSync(path.join(data, "vm-home.json"), "utf8")) as {
        choice: string;
      };
      expect(choice.choice).toBe("reuse");
    } finally {
      if (prevHome === undefined) delete process.env.YO_HOME;
      else process.env.YO_HOME = prevHome;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("download progress from docker compose pull", () => {
  it("adds up each layer's latest size, and says unpacking only once every layer is downloaded", () => {
    // Lines as `docker compose pull` printed them in a real first run (Colima, compose 5.5).
    const p = new PullProgress();
    const feed = (lines: string) => lines.split("\n").map((l) => p.add(l));
    feed(`Image ghcr.io/juniorsua/yo-computer:0.1.278 Pulling
 aaaaaaaaaaaa Pulling fs layer 0B
bbbbbbbbbbbb Pulling fs layer 0B
aaaaaaaaaaaa Downloading 36.57kB
bbbbbbbbbbbb Downloading 1.049MB
bbbbbbbbbbbb Downloading 2.097MB`);
    expect(Math.round(p.bytes / 1e3)).toBe(2134);
    feed("aaaaaaaaaaaa Download complete 0B\naaaaaaaaaaaa Extracting 68B");
    // Docker unpacks the first layer while the second is still downloading.
    expect(p.unpacking).toBe(false);
    expect(p.add("bbbbbbbbbbbb Downloading 398.8MB")).toBe(true);
    expect(Math.round(p.bytes / 1e6)).toBe(399);
    // An older, smaller figure for the same layer doesn't count twice or go backwards.
    expect(p.add("bbbbbbbbbbbb Downloading 398MB")).toBe(false);
    expect(p.add("bbbbbbbbbbbb Download complete 0B")).toBe(true);
    expect(p.unpacking).toBe(true);
    expect(p.add("not a progress line")).toBe(false);
  });
});

describe("start errors in plain words", () => {
  const cases: [unknown, RegExp][] = [
    [{ stderr: "write /var/lib/docker/tmp/x: no space left on device" }, /out of disk space/],
    [{ message: "docker: unknown command: docker compose" }, /Turn on Docker Compose/],
    [
      {
        message:
          'Error response from daemon: Get "https://ghcr.io/v2/": dial tcp: lookup ghcr.io: no such host',
      },
      /online/,
    ],
    [{ message: "manifest unknown" }, /Yo update/],
    [{ message: "Bind for 127.0.0.1:7801 failed: port is already allocated" }, /port my computer needs/],
    [{ message: "toomanyrequests: retry later" }, /busy/],
    [{ killed: true, message: "Command failed" }, /took too long/],
    [
      new Error("Colima is not installed. Run: brew install colima docker docker-compose"),
      /brew install colima/,
    ],
    ["something nobody expected", /didn't start\. Press Try again/],
  ];

  it.each(cases)("%j", (err, expected) => {
    const text = friendlyStartError(err);
    expect(text).toMatch(expected);
    // A sentence or two, never a log dump.
    expect(text.length).toBeLessThan(220);
    expect(text).not.toMatch(/level=|stderr|\n/);
  });
});

describe("colimaNoMountArgs", () => {
  it("turns Colima's home-folder mount off from 0.10.0 on", () => {
    expect(colimaNoMountArgs("colima version 0.10.0")).toEqual(["--mount", "none"]);
    expect(colimaNoMountArgs("colima version 0.10.3\ngit commit: 00f6c29")).toEqual(["--mount", "none"]);
    expect(colimaNoMountArgs("colima version v0.11.2")).toEqual(["--mount", "none"]);
    expect(colimaNoMountArgs("colima version 1.0.0")).toEqual(["--mount", "none"]);
  });

  it("leaves older or unknown versions alone (they would read none as a folder)", () => {
    expect(colimaNoMountArgs("colima version 0.9.1")).toEqual([]);
    expect(colimaNoMountArgs("colima version 0.6.10")).toEqual([]);
    expect(colimaNoMountArgs("")).toEqual([]);
    expect(colimaNoMountArgs("command not found")).toEqual([]);
  });
});
