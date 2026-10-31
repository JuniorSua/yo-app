import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config";
import { openMemoryDb } from "../src/db/db";
import { Store } from "../src/db/store";
import { PAGE_CSP } from "../src/http/server";
import { Hub } from "../src/hub";
import { startCore } from "../src/main";
import { MemorySecretStore } from "../src/secrets/SecretStore";
import { createYoTools } from "../src/tools/yoTools";
import { MockAgentd } from "./mockAgentd";

const TOKEN = "t".repeat(64);
const PAGE = "<!doctype html><html><body><h1>Q3 sales</h1><svg></svg></body></html>";

let dataDir: string;

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "yo-pages-test-"));
});
afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

function setup(files: Record<string, string> = {}) {
  const store = new Store(openMemoryDb());
  const hub = new Hub();
  const pushes: { channel: string; data: any }[] = [];
  hub.subscribe((channel, data) => pushes.push({ channel, data }));
  const agent = { id: "agt_test" };
  const tools = createYoTools({
    store,
    hub,
    scheduler: null as never,
    dataDir,
    fetchFile: async (_id, p) => {
      if (!(p in files)) throw new Error(`no such file ${p}`);
      return Buffer.from(files[p]!, "utf8");
    },
    bugReports: null as never,
  });
  return { store, agent, tools, pushes };
}

describe("create_page", () => {
  it("keeps the page as a Page in Your files and tells the chat its id", async () => {
    const { store, agent, tools, pushes } = setup();
    const out = await tools(agent.id, "create_page", { title: "Q3 sales", html: PAGE });
    const id = /\[page:(art_\w+)\]/.exec(out)?.[1];
    expect(id).toBeTruthy();
    const art = store.getArtifact(id!)!;
    expect(art).toMatchObject({ kind: "page", title: "Q3 sales", mime: "text/html", pinnedAt: null });
    expect(fs.readFileSync(store.artifactFile(id!)!.storedPath, "utf8")).toBe(PAGE);
    expect(pushes.some((p) => p.channel === "artifact.new" && p.data.id === id)).toBe(true);
  });

  it("keeps what kind of page it is for the Make page (page when not given or unknown)", async () => {
    const { store, agent, tools } = setup();
    const idOf = (out: string) => /\[page:(art_\w+)\]/.exec(out)![1]!;
    const dash = idOf(
      await tools(agent.id, "create_page", { title: "Orders", kind: "dashboard", html: PAGE }),
    );
    const deck = idOf(await tools(agent.id, "create_page", { title: "Pitch", kind: "Slides", html: PAGE }));
    const plain = idOf(await tools(agent.id, "create_page", { title: "Plain", html: PAGE }));
    const odd = idOf(await tools(agent.id, "create_page", { title: "Odd", kind: "poster", html: PAGE }));
    expect(store.getArtifact(dash)).toMatchObject({ kind: "page", pageKind: "dashboard" });
    expect(store.getArtifact(deck)?.pageKind).toBe("slides");
    expect(store.getArtifact(plain)?.pageKind).toBe("page");
    expect(store.getArtifact(odd)?.pageKind).toBe("page");
    const out = await tools(agent.id, "create_page", { title: "Notes", kind: "doc", html: PAGE });
    expect(out).toMatch(
      /^The page "Notes" is ready; the user sees it in the chat and on their Make page\. \[page:art_\w+\]$/,
    );
    // Files and bug reports have no page kind.
    const file = store.addArtifact({
      agentId: agent.id,
      title: "notes.txt",
      path: "notes.txt",
      mime: "text/plain",
      size: 3,
      storedPath: path.join(dataDir, "notes.txt"),
    });
    expect(file.pageKind).toBeUndefined();
  });

  it("takes an .html file from the computer instead", async () => {
    const { store, agent, tools } = setup({ "/home/agent/chart.html": PAGE });
    const out = await tools(agent.id, "create_page", { title: "Chart", path: "/home/agent/chart.html" });
    const id = /\[page:(art_\w+)\]/.exec(out)![1]!;
    expect(store.getArtifact(id)).toMatchObject({ kind: "page", path: "/home/agent/chart.html" });
  });

  it("refuses a page without a title or content, one that isn't HTML, and one over 2 MB", async () => {
    const { agent, tools } = setup();
    await expect(tools(agent.id, "create_page", { html: PAGE })).rejects.toThrow(/title/);
    await expect(tools(agent.id, "create_page", { title: "x" })).rejects.toThrow(/html, or the path/);
    await expect(tools(agent.id, "create_page", { title: "x", html: "just words" })).rejects.toThrow(
      /doesn't look like an HTML page/,
    );
    const big = `<div>${"a".repeat(2 * 1024 * 1024)}</div>`;
    await expect(tools(agent.id, "create_page", { title: "x", html: big })).rejects.toThrow(/under 2 MB/);
  });
});

describe("pins", () => {
  it("pins and unpins a file", async () => {
    const { store, agent, tools } = setup();
    const id = /\[page:(art_\w+)\]/.exec(
      await tools(agent.id, "create_page", { title: "P", html: PAGE }),
    )![1]!;
    expect(store.setArtifactPinned(id, true)!.pinnedAt).toBeGreaterThan(0);
    expect(store.listArtifacts()[0]!.pinnedAt).toBeGreaterThan(0);
    expect(store.setArtifactPinned(id, false)!.pinnedAt).toBeNull();
    expect(store.setArtifactPinned("art_missing", true)).toBeNull();
  });
});

describe("the page viewer route", () => {
  let mock: MockAgentd;
  let core: Awaited<ReturnType<typeof startCore>> | null = null;
  afterEach(async () => {
    await core?.shutdown().catch(() => {});
    core = null;
    await mock?.close();
  });

  it("serves a Page sandboxed (scripts only, no network) and every other file as a download", async () => {
    process.env.YO_AGENTD_TOKEN = TOKEN;
    mock = new MockAgentd(TOKEN);
    const agentdUrl = await mock.listen();
    core = await startCore(
      {
        ...loadConfig({}),
        dev: true,
        port: 21800 + Math.floor(Math.random() * 500),
        dataDir,
        agentdUrl,
        computerMode: "remote" as const,
        secrets: "file" as const,
        webDist: null,
      },
      { secrets: new MemorySecretStore() },
    );
    const agentId = core.store.listAgents().find((a) => a.isPrimary)!.id;
    const stored = path.join(dataDir, "p.html");
    fs.writeFileSync(stored, PAGE);
    const page = core.store.addArtifact({
      agentId,
      title: "P",
      path: "p.html",
      mime: "text/html",
      size: PAGE.length,
      storedPath: stored,
      kind: "page",
    });
    const file = core.store.addArtifact({
      agentId,
      title: "F",
      path: "f.html",
      mime: "text/html",
      size: PAGE.length,
      storedPath: stored,
    });
    const base = `http://127.0.0.1:${core.cfg.port}/api/artifacts`;

    const view = await fetch(`${base}/${page.id}?view=page`);
    expect(view.status).toBe(200);
    expect(view.headers.get("content-type")).toContain("text/html");
    expect(view.headers.get("content-disposition")).toBe("inline");
    const csp = view.headers.get("content-security-policy")!;
    expect(csp).toBe(PAGE_CSP);
    expect(csp).toMatch(/^sandbox allow-scripts;/);
    expect(csp).not.toContain("allow-same-origin");
    expect(csp).toContain("connect-src 'none'");
    expect(await view.text()).toBe(PAGE);

    // An ordinary HTML file never renders: it downloads, under the plain sandbox.
    const other = await fetch(`${base}/${file.id}?view=page`);
    expect(other.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(other.headers.get("content-security-policy")).toBe("sandbox");
    await other.arrayBuffer();
  });
});
