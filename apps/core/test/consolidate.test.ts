/** "Yo is now one assistant with helpers": team.consolidatePlan / team.consolidate (apps/core/src/team). */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConsolidationResult } from "@yo/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
type Core = Awaited<ReturnType<typeof startCore>>;

let dataDir: string;
let mock: MockAgentd;
let agentdUrl: string;
let cores: Core[] = [];
let port = 19200 + Math.floor(Math.random() * 500);

async function boot(): Promise<Core> {
  process.env.YO_AGENTD_TOKEN = TOKEN;
  const core = await startCore(
    {
      ...loadConfig({}),
      dev: false,
      port: port++,
      dataDir,
      agentdUrl,
      computerMode: "remote" as const,
      secrets: "file" as const,
      webDist: null,
    },
    { secrets: new MemorySecretStore() },
  );
  cores.push(core);
  await core.agentd.waitReady(5000);
  return core;
}

beforeEach(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-consolidate-test-"));
  mock = new MockAgentd(TOKEN);
  agentdUrl = await mock.listen();
});

afterEach(async () => {
  for (const c of cores) await c.shutdown().catch(() => {});
  cores = [];
  await mock.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

const primaryOf = (core: Core) => core.store.listAgents().find((a) => a.isPrimary)!;

function addAgent(core: Core, name: string, role = "", instructions = "") {
  return core.store.createAgent({
    name,
    role,
    instructions,
    avatar: primaryOf(core).avatar,
    accountId: null,
    model: null,
    effort: null,
    runtimeMode: "full-access",
    isPrimary: false,
    pinned: false,
  });
}

function addRoutine(core: Core, agentId: string, name: string, enabled = true) {
  return core.store.createRoutine({
    agentId,
    name,
    prompt: `${name} prompt`,
    cron: "0 9 * * *",
    runAt: null,
    timezone: "America/New_York",
    enabled,
    nextRunAt: Date.now() + 3_600_000,
  });
}

describe("team.consolidate", () => {
  it("never offers teammates on its own: they're first-class, so the one-time dialog stays shut", async () => {
    const core = await boot();
    const yo = primaryOf(core);
    const sam = addAgent(core, "Sam", "Sales desk");
    core.store.addMemory("Sam likes short emails", sam.id);
    addRoutine(core, sam.id, "Morning leads");

    const plan = await core.api["team.consolidatePlan"]({});
    expect(plan).toEqual({ primaryId: yo.id, agents: [] });
    // Nothing moved or archived.
    expect(core.store.getAgent(sam.id)?.archivedAt).toBeNull();
    expect(core.store.listRoutines(sam.id)).toHaveLength(1);
    expect(mock.copies).toEqual([]);
  });

  it("a user with only the main agent has nothing to move", async () => {
    const core = await boot();
    expect((await core.api["team.consolidatePlan"]({})).agents).toEqual([]);
    const res = await core.api["team.consolidate"]({ agentIds: [] });
    expect(res.agents).toEqual([]);
  });

  it("re-owns memories and routines (routines stay enabled), copies files, saves the role, archives", async () => {
    const core = await boot();
    const yo = primaryOf(core);
    const sam = addAgent(core, "Sam Smith", "Sales desk", "Always answer leads within an hour.");
    core.store.addMemory("Sam likes short emails", sam.id);
    core.store.addMemory("Sam's second memory", sam.id);
    const on = addRoutine(core, sam.id, "Morning leads", true);
    const off = addRoutine(core, sam.id, "Weekly report", false);
    const yoMemoriesBefore = core.store.listMemories(yo.id).length;

    const res: ConsolidationResult = await core.api["team.consolidate"]({ agentIds: [sam.id] });

    expect(res.primaryId).toBe(yo.id);
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0]).toMatchObject({
      agentId: sam.id,
      name: "Sam Smith",
      status: "done",
      memories: 2,
      routines: 2,
    });
    // Files: agentd was asked to copy this agent's home into ~/Shared/from-<name>.
    expect(mock.copies).toEqual([{ fromAgentId: sam.id, toDir: "from-Sam-Smith" }]);
    expect(res.agents[0]!.files).toMatchObject({ dir: "from-Sam-Smith", copied: 3 });

    // Memories now belong to Yo, plus one memory with the role and instructions.
    const yoMemories = core.store.listMemories(yo.id);
    expect(yoMemories.filter((m) => m.content.startsWith("Sam likes"))[0]?.agentId).toBe(yo.id);
    expect(core.store.listMemories(sam.id).filter((m) => m.agentId === sam.id)).toEqual([]);
    const handover = yoMemories.find((m) => m.content.startsWith("Handover from Sam Smith"));
    expect(handover?.agentId).toBe(yo.id);
    expect(handover?.content).toContain("Role: Sales desk");
    expect(handover?.content).toContain("Always answer leads within an hour.");
    expect(handover?.content).toContain("~/Shared/from-Sam-Smith/");
    expect(yoMemories.length).toBe(yoMemoriesBefore + 3);

    // Routines belong to Yo, still on or off exactly as they were.
    expect(core.store.getRoutine(on.id)).toMatchObject({ agentId: yo.id, enabled: true });
    expect(core.store.getRoutine(off.id)).toMatchObject({ agentId: yo.id, enabled: false });
    expect(core.store.listRoutines(sam.id)).toEqual([]);

    // The agent is archived and gone from the plan.
    expect(core.store.getAgent(sam.id)?.archivedAt).not.toBeNull();
    expect((await core.api["team.consolidatePlan"]({})).agents).toEqual([]);
  });

  it("is idempotent: a second run changes nothing and reports done", async () => {
    const core = await boot();
    const yo = primaryOf(core);
    const sam = addAgent(core, "Sam", "Sales", "Be quick.");
    core.store.addMemory("fact", sam.id);
    addRoutine(core, sam.id, "Leads");
    await core.api["team.consolidate"]({ agentIds: [sam.id] });
    const memoriesAfterFirst = core.store.listMemories(yo.id).length;
    const routinesAfterFirst = core.store.listRoutines(yo.id).length;

    const again = await core.api["team.consolidate"]({ agentIds: [sam.id, sam.id] });
    expect(again.agents).toHaveLength(1);
    expect(again.agents[0]!.status).toBe("done");
    expect(core.store.listMemories(yo.id).length).toBe(memoriesAfterFirst);
    expect(core.store.listRoutines(yo.id).length).toBe(routinesAfterFirst);
    expect(
      core.store.listMemories(yo.id).filter((m) => m.content.startsWith("Handover from Sam")),
    ).toHaveLength(1);
    expect(mock.copies).toHaveLength(1); // not copied again once archived
  });

  it("is resumable: a failed file copy changes nothing, and the next run finishes", async () => {
    const core = await boot();
    const yo = primaryOf(core);
    const sam = addAgent(core, "Sam", "Sales", "Be quick.");
    core.store.addMemory("fact", sam.id);
    const routine = addRoutine(core, sam.id, "Leads");

    mock.failCopy = true;
    const first = await core.api["team.consolidate"]({ agentIds: [sam.id] });
    expect(first.agents[0]).toMatchObject({ status: "pending", files: null });
    expect(first.agents[0]!.error).toContain("disk full");
    // Left exactly as it was: still active, still its own memories and routines.
    expect(core.store.getAgent(sam.id)?.archivedAt).toBeNull();
    expect(core.store.listMemories(sam.id).filter((m) => m.agentId === sam.id)).toHaveLength(1);
    expect(core.store.getRoutine(routine.id)?.agentId).toBe(sam.id);
    expect(core.store.listMemories(yo.id).some((m) => m.content.startsWith("Handover from"))).toBe(false);

    mock.failCopy = false;
    const second = await core.api["team.consolidate"]({ agentIds: [sam.id] });
    expect(second.agents[0]!.status).toBe("done");
    expect(core.store.getAgent(sam.id)?.archivedAt).not.toBeNull();
    expect(core.store.getRoutine(routine.id)).toMatchObject({ agentId: yo.id, enabled: true });
  });

  it("honors the skip list: Pepe is never consolidated, even if asked", async () => {
    const core = await boot();
    const pepe = addAgent(core, "Pepe", "Work", "Do the desk.");
    core.store.addMemory("Pepe fact", pepe.id);
    const routine = addRoutine(core, pepe.id, "Desk");

    const res = await core.api["team.consolidate"]({ agentIds: [pepe.id] });
    expect(res.agents[0]).toMatchObject({ name: "Pepe", status: "skipped" });
    expect(mock.copies).toEqual([]);
    expect(core.store.getAgent(pepe.id)?.archivedAt).toBeNull();
    expect(core.store.getRoutine(routine.id)?.agentId).toBe(pepe.id);
    expect(core.store.listMemories(pepe.id).filter((m) => m.agentId === pepe.id)).toHaveLength(1);

    // Case doesn't matter, and the list is a setting the owner can change.
    core.store.updateAgent(pepe.id, { name: "PEPE" });
    expect((await core.api["team.consolidate"]({ agentIds: [pepe.id] })).agents[0]?.status).toBe("skipped");
    await core.api["settings.update"]({ consolidateSkip: [] });
    expect((await core.api["team.consolidate"]({ agentIds: [pepe.id] })).agents[0]?.status).toBe("done");
  });

  it("life map: remember with an area tags the memory, and the next session's prompt shows the map", async () => {
    const core = await boot();
    for (let i = 0; i < 250 && !core.store.listAccounts().some((a) => a.status === "authenticated"); i++)
      await new Promise((r) => setTimeout(r, 20));
    const yo = primaryOf(core);
    await core.api["chat.send"]({
      agentId: yo.id,
      text: 'tool remember {"fact":"Desk quotes go out by Friday","area":"Work"}',
    });
    for (let i = 0; i < 250 && core.store.listMemories().length === 0; i++)
      await new Promise((r) => setTimeout(r, 20));
    expect(core.store.listMemories()[0]?.content).toBe("[area:work] Desk quotes go out by Friday");
    for (let i = 0; i < 250 && core.orchestrator.activityOf(yo.id) !== "done"; i++)
      await new Promise((r) => setTimeout(r, 20));
    await core.api["agent.newSession"]({ id: yo.id });
    await core.api["chat.send"]({ agentId: yo.id, text: "hi" });
    for (let i = 0; i < 250 && mock.count("session.start") < 2; i++)
      await new Promise((r) => setTimeout(r, 20));
    const sys = mock.last("session.start")!.systemAppend;
    expect(sys).toContain("# Your life map");
    expect(sys).toContain("- work: Desk quotes go out by Friday");
    expect(sys).toContain("# Areas, goals and new agents");
  });

  it("never moves the main agent", async () => {
    const core = await boot();
    const yo = primaryOf(core);
    const res = await core.api["team.consolidate"]({ agentIds: [yo.id] });
    expect(res.agents[0]!.status).toBe("skipped");
    expect(core.store.getAgent(yo.id)?.archivedAt).toBeNull();
  });
});
