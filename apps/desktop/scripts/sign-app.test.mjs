// sign-app.mjs: nested binaries are signed one at a time, and limactl keeps its entitlement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { collectSignTargets, machoMagic, shouldSignFile, signArgs, signPlan } from "./sign-app.mjs";

const dirs = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "yo-sign-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A tiny fake Mach-O (thin 64-bit magic) so the walker treats the file as code. */
function machO(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(0xfeedfacf, 0);
  fs.writeFileSync(file, buf, { mode: 0o755 });
}

describe("sign-app", () => {
  it("recognizes Mach-O magic and skips a non-executable fat file (Java class files)", () => {
    const thin = Buffer.alloc(4);
    thin.writeUInt32BE(0xfeedfacf, 0);
    expect(machoMagic(thin)).toBe(0xfeedfacf);
    expect(shouldSignFile(thin, 0o644)).toBe(true);
    const fat = Buffer.alloc(4);
    fat.writeUInt32BE(0xcafebabe, 0);
    expect(shouldSignFile(fat, 0o644)).toBe(false);
    expect(shouldSignFile(fat, 0o755)).toBe(true);
    expect(shouldSignFile(Buffer.from("hello"), 0o755)).toBe(false);
  });

  it("signs nested code deepest first, the app last, and never with --deep", () => {
    const root = tmp();
    const app = path.join(root, "Yo.app");
    machO(path.join(app, "Contents", "MacOS", "Yo"));
    machO(path.join(app, "Contents", "Resources", "bin", "limactl"));
    machO(path.join(app, "Contents", "Resources", "bin", "lima-driver-vz"));
    machO(path.join(app, "Contents", "Resources", "YoDeviceBridge"));
    machO(path.join(app, "Contents", "Frameworks", "Electron Framework.framework", "Electron Framework"));
    const java = path.join(app, "Contents", "Resources", "Nope.class");
    fs.writeFileSync(java, Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 0]));

    const targets = collectSignTargets(app);
    expect(targets.some((t) => t.endsWith("Nope.class"))).toBe(false);
    const framework = targets.find((t) => t.endsWith("Electron Framework.framework"));
    const inner = targets.find((t) => t.endsWith(`${path.sep}Electron Framework`));
    expect(framework).toBeTruthy();
    expect(inner).toBeTruthy();
    expect(targets.indexOf(inner)).toBeLessThan(targets.indexOf(framework));

    const entitlements = path.join(root, "lima-vz.plist");
    const plan = signPlan(app, entitlements);
    expect(plan.at(-1)?.target).toBe(app);
    expect(plan.flatMap((step) => step.args)).not.toContain("--deep");
    const lima = plan.find((step) => step.target.endsWith(`${path.sep}limactl`));
    const driver = plan.find((step) => step.target.endsWith("lima-driver-vz"));
    const bridge = plan.find((step) => step.target.endsWith("YoDeviceBridge"));
    expect(lima?.args).toEqual(["--entitlements", entitlements]);
    expect(driver?.args).toEqual(["--entitlements", entitlements]);
    expect(bridge?.args).toEqual(["--identifier", "dev.yo.app.devicebridge"]);
    expect(signArgs(path.join(app, "Contents", "MacOS", "Yo"), entitlements)).toEqual([]);
  });
});
