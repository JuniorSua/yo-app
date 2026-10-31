import { describe, expect, it } from "vitest";
import { isVmPhase } from "./progress";

describe("isVmPhase", () => {
  it("is the VM step while core starts the virtual machine", () => {
    expect(isVmPhase("Starting Yo's computer (virtual machine)…")).toBe(true);
    expect(isVmPhase("Starting the Colima virtual machine…")).toBe(true);
    expect(isVmPhase("Starting Yo's computer…")).toBe(true);
    expect(isVmPhase(null)).toBe(true);
  });

  it("moves on once core downloads, unpacks or builds the computer", () => {
    expect(isVmPhase("Downloading Yo's computer (first run takes a few minutes)…")).toBe(false);
    expect(isVmPhase("Downloading Yo's computer: 412 MB so far…")).toBe(false);
    expect(isVmPhase("Unpacking Yo's computer…")).toBe(false);
    expect(isVmPhase("Building Yo's computer image (Chromium, desktop, tools)…")).toBe(false);
  });
});
