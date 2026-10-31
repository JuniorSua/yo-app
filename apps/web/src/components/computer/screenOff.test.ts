import { describe, expect, it } from "vitest";
import { COMPUTER_OFF_MESSAGE, vncClosedBecauseOff } from "./screenOff";

describe("live view when the computer is off", () => {
  it("treats core's 4404 close as the computer being off", () => {
    expect(vncClosedBecauseOff(4404, "computer is not running")).toBe(true);
    expect(vncClosedBecauseOff(4404, "")).toBe(true);
    expect(vncClosedBecauseOff(1000, "computer is not running")).toBe(true);
    expect(vncClosedBecauseOff(1005, "")).toBe(false);
    expect(vncClosedBecauseOff(1006, "closed")).toBe(false);
    expect(COMPUTER_OFF_MESSAGE).toBe("Your computer is off — start it");
  });
});
