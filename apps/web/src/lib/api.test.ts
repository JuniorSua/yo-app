import { afterEach, expect, it, vi } from "vitest";
import { WsClient } from "./api";

class Socket {
  static OPEN = 1;
  static latest: Socket;
  readyState = 0;
  onopen?: () => void;
  onclose?: (ev?: { code: number }) => void;
  sent: string[] = [];
  constructor() {
    Socket.latest = this;
  }
  send(frame: string) {
    this.sent.push(frame);
  }
  open() {
    this.readyState = Socket.OPEN;
    this.onopen?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("does not send an expired queued mutation after a late connection", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", Socket);
  const client = new WsClient("ws://localhost/ws");
  const expired = client.call("chat.send", { agentId: "a", text: "old request" });
  const rejected = expect(expired).rejects.toThrow("timed out");
  await vi.advanceTimersByTimeAsync(60_000);
  await rejected;
  const fresh = client.call("chat.send", { agentId: "a", text: "retry" });
  const freshRejected = expect(fresh).rejects.toThrow("timed out");
  Socket.latest.open();
  expect(Socket.latest.sent.map((s) => JSON.parse(s).params.text)).toEqual(["retry"]);
  await vi.advanceTimersByTimeAsync(60_000);
  await freshRejected;
});

it("asks the sign-in gate before connecting: stop stays closed until reconnectNow", async () => {
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", Socket);
  Socket.latest = undefined as unknown as Socket;
  const answers: ("go" | "stop" | "retry")[] = ["stop", "go"];
  const gate = vi.fn(async () => answers.shift() ?? "go");
  const statuses: string[] = [];
  const client = new WsClient("ws://localhost/ws", gate);
  client.onStatus((s) => statuses.push(s));
  await vi.waitFor(() => expect(statuses).toContain("closed"));
  expect(Socket.latest).toBeUndefined();
  client.reconnectNow();
  await vi.waitFor(() => expect(Socket.latest).toBeDefined());
  expect(gate).toHaveBeenCalledTimes(2);
  Socket.latest.open();
  expect(client.status()).toBe("open");
});

it("a socket closed with 4401 (signed out) doesn't reconnect and tells browser sign-in", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("window", globalThis);
  vi.stubGlobal("WebSocket", Socket);
  const onSignedOut = vi.fn();
  const gate = vi.fn(async () => "go" as const);
  const client = new WsClient("ws://localhost/ws", { gate, onSignedOut });
  await vi.advanceTimersByTimeAsync(0);
  const first = Socket.latest;
  first.open();
  first.onclose?.({ code: 4401 });
  expect(onSignedOut).toHaveBeenCalledTimes(1);
  expect(client.status()).toBe("closed");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(gate).toHaveBeenCalledTimes(1);
  expect(Socket.latest).toBe(first);
});
