/** Bridges a WebSocket (noVNC speaks raw RFB over WS) to the display's loopback x11vnc TCP port. */
import net from "node:net";
import type { WebSocket } from "ws";
import type { Logger } from "./log";

const HIGH_WATER = 4 * 1024 * 1024;

export function bridgeVnc(ws: WebSocket, port: number, log: Logger, label: string): void {
  const tcp = net.connect({ host: "127.0.0.1", port });
  tcp.setNoDelay(true);
  let closed = false;
  const closeBoth = (why: string) => {
    if (closed) return;
    closed = true;
    log.info("vnc bridge closed", { label, why });
    tcp.destroy();
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close(1000, "closed");
  };

  tcp.on("data", (chunk: Buffer) => {
    if (ws.readyState !== ws.OPEN) return;
    ws.send(chunk, { binary: true }, () => {
      if (tcp.isPaused() && ws.bufferedAmount < HIGH_WATER / 2) tcp.resume();
    });
    if (ws.bufferedAmount > HIGH_WATER) tcp.pause();
  });
  tcp.on("error", (err) => closeBoth(`tcp error: ${err.message}`));
  tcp.on("close", () => closeBoth("tcp closed"));

  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    tcp.write(buf);
  });
  ws.on("close", () => closeBoth("ws closed"));
  ws.on("error", (err) => closeBoth(`ws error: ${err.message}`));
  log.info("vnc bridge opened", { label, port });
}
