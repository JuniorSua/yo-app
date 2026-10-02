/** Renders a proof sheet of the dimensional finish + satin logo (written to /tmp/yo-proof.html). */
import React from "react";

void React;

import { writeFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_CSS, Avatar, VIOLET_COPILOT, YoLogo } from "../src/index";

const sizes = [20, 30, 34, 48, 128];
const states = ["idle", "working", "waiting", "done", "error", "sleeping"] as const;
const flat = { ...VIOLET_COPILOT, finish: undefined };
const row = (bg: string, fg: string) =>
  renderToStaticMarkup(
    <div
      style={{ background: bg, color: fg, padding: 24, display: "flex", flexDirection: "column", gap: 18 }}
    >
      <div style={{ display: "flex", gap: 22, alignItems: "flex-end" }}>
        {sizes.map((s) => (
          <Avatar key={s} avatar={VIOLET_COPILOT} size={s} animated={false} />
        ))}
        <span style={{ width: 30 }} />
        {sizes.map((s) => (
          <Avatar key={`f${s}`} avatar={flat} size={s} animated={false} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
        {states.map((st) => (
          <div key={st} style={{ textAlign: "center", font: "12px system-ui" }}>
            <Avatar avatar={VIOLET_COPILOT} size={72} state={st} animated={false} />
            <div>{st}</div>
          </div>
        ))}
        <Avatar avatar={{ ...VIOLET_COPILOT, color: "cyan", shape: "pebble" }} size={72} animated={false} />
        <Avatar
          avatar={{ ...VIOLET_COPILOT, color: "yo", shape: "bubble", accessory: "none" }}
          size={72}
          animated={false}
        />
      </div>
      <div style={{ display: "flex", gap: 22, alignItems: "center" }}>
        {[16, 22, 32, 64, 148].map((s) => (
          <YoLogo key={s} size={s} />
        ))}
        <YoLogo size={64} finish="flat" />
      </div>
    </div>,
  );
const html = `<html><head><style>${AVATAR_CSS}</style></head><body style="margin:0">${row("#0B0C0E", "#ECECEE")}${row("#FAFAF8", "#1A1A1A")}</body></html>`;
writeFileSync("/tmp/yo-proof.html", html);
const { chromium } = await import("@playwright/test");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
await p.goto("file:///tmp/yo-proof.html");
await p.screenshot({ path: "/tmp/yo-proof.png", fullPage: true });
await b.close();
console.log("ok");
