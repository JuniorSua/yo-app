// fetch-vm-tools.mjs: the pins the app downloads are https URLs with full sha256 checksums.
import { describe, expect, it } from "vitest";
import { limaMembersToExtract, PINS, stampBody } from "./fetch-vm-tools.mjs";

describe("vm tool pins", () => {
  it("pins https downloads of Colima, Lima, Docker and Compose with 64-hex checksums", () => {
    expect(Object.keys(PINS).sort()).toEqual(["colima", "compose", "docker", "lima"]);
    for (const pin of Object.values(PINS)) {
      expect(pin.url).toMatch(/^https:\/\//);
      expect(pin.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(pin.version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    expect(PINS.colima.url).toContain("Darwin-arm64");
    expect(PINS.lima.url).toContain("Darwin-arm64");
    expect(PINS.docker.url).toContain("aarch64");
    expect(PINS.compose.url).toContain("darwin-aarch64");
    expect(stampBody().sha256.lima).toBe(PINS.lima.sha256);
  });

  it("extracts lima, limactl, the Linux guest agent, and the templates directory, not each template file", () => {
    const picked = limaMembersToExtract([
      "./bin/lima",
      "./bin/limactl",
      "./libexec/lima/lima-driver-krunkit",
      "./share/lima/lima-guestagent.Linux-aarch64.gz",
      "./share/lima/lima-guestagent.Darwin-aarch64.gz",
      "./share/lima/templates/",
      "./share/lima/templates/default.yaml",
      "./share/doc/lima/templates",
    ]);
    expect(picked).toEqual([
      "./bin/lima",
      "./bin/limactl",
      "./share/lima/lima-guestagent.Linux-aarch64.gz",
      "./share/lima/templates/",
    ]);
  });
});
