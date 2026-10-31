import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { AgentdClient } from "../src/agentd/AgentdClient";

const TOKEN = "t".repeat(64);

/** A tiny agentd that answers hello; with `autoPong: false` it goes silent like a half-open connection. */
async function fakeAgentd(autoPong: boolean) {
  const server = http.createServer();
  const wss = new WebSocketServer({ server, autoPong });
  let connections = 0;
  wss.on("connection", (ws) => {
    connections++;
    ws.on("message", (raw) => {
      const req = JSON.parse(raw.toString());
      if (req.type === "hello")
        ws.send(JSON.stringify({ type: "ok", re: req.id, data: { agentdVersion: "fake", providers: [] } }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    connections: () => connections,
    close: async () => {
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("AgentdClient", () => {
  it("drops and redials a control connection that stops answering pings", async () => {
    const agentd = await fakeAgentd(false);
    cleanups.push(agentd.close);
    const client = new AgentdClient(agentd.url, TOKEN, "test", 100);
    cleanups.push(() => client.stop());
    let disconnects = 0;
    client.on("disconnected", () => disconnects++);
    client.start();
    await client.waitReady(2000);
    const start = Date.now();
    while (agentd.connections() < 2 && Date.now() - start < 3000) await new Promise((r) => setTimeout(r, 20));
    expect(disconnects).toBeGreaterThanOrEqual(1);
    expect(agentd.connections()).toBeGreaterThanOrEqual(2);
  });

  it("keeps a healthy connection that answers pings", async () => {
    const agentd = await fakeAgentd(true);
    cleanups.push(agentd.close);
    const client = new AgentdClient(agentd.url, TOKEN, "test", 50);
    cleanups.push(() => client.stop());
    let disconnects = 0;
    client.on("disconnected", () => disconnects++);
    client.start();
    await client.waitReady(2000);
    await new Promise((r) => setTimeout(r, 400));
    expect(disconnects).toBe(0);
    expect(agentd.connections()).toBe(1);
    expect(client.connected).toBe(true);
  });

  it("a timed-out wait for the connection doesn't linger", async () => {
    const client = new AgentdClient("http://127.0.0.1:9", TOKEN, "test", 0);
    await expect(client.waitReady(30)).rejects.toThrow(/not connected/);
    expect((client as unknown as { readyWaiters: unknown[] }).readyWaiters).toHaveLength(0);
  });
});
