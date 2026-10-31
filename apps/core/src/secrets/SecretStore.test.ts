import { afterEach, describe, expect, it } from "vitest";
import { KeychainSecretStore, keychainService } from "./SecretStore";

const previous = process.env.YO_BUNDLE_ID_SUFFIX;

afterEach(() => {
  if (previous === undefined) delete process.env.YO_BUNDLE_ID_SUFFIX;
  else process.env.YO_BUNDLE_ID_SUFFIX = previous;
});

describe("Keychain service", () => {
  it("stays Yo when YO_BUNDLE_ID_SUFFIX is unset, so existing items still match", () => {
    delete process.env.YO_BUNDLE_ID_SUFFIX;
    expect(keychainService()).toBe("Yo");
    expect(keychainService({ YO_BUNDLE_ID_SUFFIX: "   " })).toBe("Yo");
    expect(new KeychainSecretStore().service).toBe("Yo");
  });

  it("uses Yo Test for a test build, and does not write the production service", () => {
    process.env.YO_BUNDLE_ID_SUFFIX = "test";
    expect(keychainService()).toBe("Yo Test");
    expect(new KeychainSecretStore().service).toBe("Yo Test");
    expect(keychainService({ YO_BUNDLE_ID_SUFFIX: "qa-lab" })).toBe("Yo Qa Lab");
    expect(keychainService({ YO_BUNDLE_ID_SUFFIX: "Test" })).toBe("Yo Test");
    expect(keychainService({ YO_BUNDLE_ID_SUFFIX: "test" })).not.toBe("Yo");
  });
});
