// Tiny CLI client for the Yo core API: node scripts/api.mjs <method> '<json params>'
import WebSocket from "ws";

const [method, params = "{}"] = process.argv.slice(2);
const ws = new WebSocket(process.env.YO_WS ?? "ws://127.0.0.1:7777/ws");
ws.on("open", () => ws.send(JSON.stringify({ id: "1", method, params: JSON.parse(params) })));
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.id === "1") {
    console.log(JSON.stringify(f.result ?? f, null, 2));
    ws.close();
  } else if (process.env.YO_PUSHES) console.error("push", f.push, JSON.stringify(f.data).slice(0, 300));
});
