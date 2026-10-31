import { type AgentView, DEFAULT_SETTINGS, type Settings } from "@yo/contracts";
import { describe, expect, it } from "vitest";
import { agentOf, followPlan, manualFor, nextCheck, pickAgentId, spaceView } from "./space";

const view = (id: string, extra: Partial<AgentView> = {}) =>
  ({
    id,
    name: id,
    isPrimary: false,
    pinned: false,
    createdAt: 1,
    lastActiveAt: null,
    archivedAt: null,
    kind: "agent",
    ...extra,
  }) as AgentView;

const agents = {
  agt_yo: view("agt_yo", { isPrimary: true, space: "work" }),
  agt_home: view("agt_home", { space: "personal", pinned: true }),
  agt_shop: view("agt_shop", { lastActiveAt: 99 }),
};
const noPip = { agt_yo: agents.agt_yo, agt_shop: agents.agt_shop };

const settings = (over: Partial<Settings> = {}): Settings => ({
  ...DEFAULT_SETTINGS,
  timezone: "America/New_York",
  ...over,
});

// Tue Oct 13 2026, Eastern (UTC-4).
const TUE_3PM = Date.parse("2026-10-13T15:00:00-04:00");
const TUE_8PM = Date.parse("2026-10-13T20:00:00-04:00");
const TUE_7PM = Date.parse("2026-10-13T19:00:00-04:00");
const WED_11AM = Date.parse("2026-10-14T11:00:00-04:00");

describe("spaceView", () => {
  it("follows the work hours: Work on a weekday afternoon, Personal in the evening", () => {
    expect(spaceView(TUE_3PM, settings(), agents)).toMatchObject({
      space: "work",
      source: "schedule",
      until: TUE_7PM,
      available: true,
    });
    expect(spaceView(TUE_8PM, settings(), agents)).toMatchObject({
      space: "personal",
      source: "schedule",
      until: WED_11AM,
    });
  });

  it("is always Work, with no switch, when spaces are off, missing (older core) or there's no Personal agent", () => {
    const off = { space: "work", source: "off", available: false };
    expect(spaceView(TUE_8PM, settings({ spacesOn: false }), agents)).toMatchObject(off);
    const { spacesOn: _gone, ...old } = settings();
    expect(spaceView(TUE_8PM, old, agents)).toMatchObject(off);
    expect(spaceView(TUE_8PM, settings(), noPip)).toMatchObject(off);
    expect(
      spaceView(TUE_8PM, settings(), { ...agents, agt_home: { ...agents.agt_home, archivedAt: 5 } }),
    ).toMatchObject(off);
  });

  it("honours a manual or pinned choice", () => {
    expect(
      spaceView(TUE_3PM, settings({ spaceManual: { space: "personal", until: TUE_7PM } }), agents),
    ).toMatchObject({ space: "personal", source: "manual", until: TUE_7PM });
    expect(
      spaceView(TUE_8PM, settings({ spaceManual: { space: "work", until: null } }), agents),
    ).toMatchObject({ space: "work", source: "pinned", until: null });
  });
});

describe("agentOf / pickAgentId", () => {
  it("each space has its lead; without spaces it's the primary", () => {
    expect(agentOf(agents, "work", true)?.id).toBe("agt_yo");
    expect(agentOf(agents, "personal", true)?.id).toBe("agt_home");
    expect(agentOf(agents, "personal", false)?.id).toBe("agt_yo");
  });

  it("keeps the saved chat unless it's gone or it's the other space's agent", () => {
    const personal = { space: "personal" as const, available: true };
    const work = { space: "work" as const, available: true };
    expect(pickAgentId(agents, "agt_home", personal)).toBe("agt_home");
    expect(pickAgentId(agents, "agt_yo", personal)).toBe("agt_home");
    expect(pickAgentId(agents, "agt_home", work)).toBe("agt_yo");
    // A legacy teammate stays open whatever the space.
    expect(pickAgentId(agents, "agt_shop", personal)).toBe("agt_shop");
    expect(pickAgentId(agents, "agt_gone", personal)).toBe("agt_home");
    expect(pickAgentId(agents, null, work)).toBe("agt_yo");
    // Spaces off: Pip saved is kept (he's still a chat), nothing saved opens Yo.
    expect(pickAgentId(agents, "agt_home", { space: "work", available: false })).toBe("agt_home");
    expect(pickAgentId(agents, null, { space: "work", available: false })).toBe("agt_yo");
    // A reconnect keeps the chat on screen, even the other space's agent; a gone one still falls back.
    expect(pickAgentId(agents, "agt_yo", personal, { keepOpen: true })).toBe("agt_yo");
    expect(pickAgentId(agents, "agt_gone", personal, { keepOpen: true })).toBe("agt_home");
  });
});

describe("manualFor", () => {
  it("picking what the schedule says goes back to Auto; anything else holds until the next change", () => {
    expect(manualFor(TUE_3PM, settings(), "work")).toBeNull();
    expect(manualFor(TUE_3PM, settings(), "personal")).toEqual({ space: "personal", until: TUE_7PM });
  });

  it("with automatic switching off (pinned), it stays pinned to the new space", () => {
    const pinned = settings({ spaceManual: { space: "work", until: null } });
    expect(manualFor(TUE_3PM, pinned, "personal")).toEqual({ space: "personal", until: null });
    expect(manualFor(TUE_3PM, pinned, "work")).toEqual({ space: "work", until: null });
  });
});

describe("nextCheck", () => {
  it("wakes just after the next change, and at least once a minute", () => {
    expect(nextCheck({ available: true, until: TUE_7PM, next: TUE_7PM }, TUE_7PM - 30_000)).toBe(30_050);
    expect(nextCheck({ available: true, until: TUE_7PM, next: TUE_7PM }, TUE_3PM)).toBe(60_000);
    expect(nextCheck({ available: true, until: null, next: null }, TUE_3PM)).toBe(60_000);
    expect(nextCheck({ available: false, until: null, next: null }, TUE_3PM)).toBe(60_000);
    // Already past (a frozen timer after sleep): look again almost at once.
    expect(nextCheck({ available: true, until: TUE_7PM, next: TUE_7PM }, TUE_7PM + 5_000)).toBe(250);
  });
});

describe("followPlan: when the space changes on its own", () => {
  const base = {
    cause: "clock" as const,
    fromId: "agt_yo",
    toId: "agt_home",
    page: "agent",
    agentId: "agt_yo",
    busy: false,
  };
  it("opens the new agent when the window shows the previous one and nothing's in the way", () => {
    expect(followPlan(base)).toBe("open");
    expect(followPlan({ ...base, cause: "settings" })).toBe("open");
  });
  it("asks with a toast on a schedule change when the owner is elsewhere or busy", () => {
    expect(followPlan({ ...base, busy: true })).toBe("toast");
    expect(followPlan({ ...base, page: "activity" })).toBe("toast");
    expect(followPlan({ ...base, agentId: "agt_shop" })).toBe("toast");
  });
  it("stays quiet for changes made elsewhere, or when there's nothing to change", () => {
    expect(followPlan({ ...base, cause: "settings", page: "activity" })).toBe("none");
    expect(followPlan({ ...base, cause: "settings", busy: true })).toBe("none");
    expect(followPlan({ ...base, agentId: "agt_home" })).toBe("none");
    expect(followPlan({ ...base, toId: "agt_yo" })).toBe("none");
    expect(followPlan({ ...base, toId: undefined })).toBe("none");
  });
});
