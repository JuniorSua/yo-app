import WebSocket from "ws";

const ws = new WebSocket("ws://127.0.0.1:7777/ws");
let acc,
  started = false,
  t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + "s";
ws.on("open", () => ws.send(JSON.stringify({ id: "l", method: "account.list", params: {} })));
ws.on("message", (raw) => {
  const f = JSON.parse(raw.toString());
  if (f.id === "l") {
    acc = f.result.find((a) => a.provider === process.argv[2]);
    t0 = Date.now();
    ws.send(JSON.stringify({ id: "s", method: "account.login.start", params: { id: acc.id } }));
  } else if (f.id === "s") {
    started = true;
    console.log(el(), "start:", JSON.stringify(f));
  } else if (f.push === "account.login") {
    const d = f.data;
    console.log(el(), "login push:", d.phase, d.url ?? "", d.userCode ?? "", d.needsInput, d.message);
    if (d.phase === "prompt" && process.argv[3] !== "keep")
      ws.send(JSON.stringify({ id: "c", method: "account.login.cancel", params: { id: acc.id } }));
  } else if (f.push === "account.updated" && f.data.id === acc?.id)
    console.log(el(), "account:", f.data.status, f.data.message);
  else if (f.id === "c") {
    console.log("cancelled");
    setTimeout(() => process.exit(0), 300);
  }
});
setTimeout(() => {
  console.log("timeout");
  process.exit(1);
}, 90000);
