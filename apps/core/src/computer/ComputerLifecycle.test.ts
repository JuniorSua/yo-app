import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import {
  ComputerLifecycle,
  computerDockerEnv,
  computerImagePlan,
  hasSourceCheckout,
  LOCAL_IMAGE,
  PUBLISHED_IMAGE,
  staleImageTags,
} from "./ComputerLifecycle";

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
    // Can't tell: leave it to compose's default.
    expect(computerDockerEnv({ ...base, timeZone: null }).YO_TZ).toBe(process.env.YO_TZ);
  });
});
