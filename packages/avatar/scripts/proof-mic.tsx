import { writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_CSS, Avatar, CUPCAT_PRESETS, VIOLET_COPILOT } from "../src/index";

void React;
const html = renderToStaticMarkup(
  <div style={{ display: "flex", gap: 20, padding: 20, background: "#FAFAF8" }}>
    <Avatar
      avatar={CUPCAT_PRESETS.mochi}
      size={220}
      state="working"
      style={{ ["--yo-av-d" as string]: "0s" }}
    />
    <Avatar avatar={VIOLET_COPILOT} size={220} state="working" />
  </div>,
).replaceAll(/--yo-av-d:[^;"]+/g, "--yo-av-d:0s");
writeFileSync(
  "/tmp/yo-mic.html",
  `<html><head><style>${AVATAR_CSS}</style></head><body style="margin:0">${html}</body></html>`,
);
const { chromium } = await import("@playwright/test");
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 520, height: 260 } });
await p.goto("file:///tmp/yo-mic.html");
await p.waitForTimeout(200);
await p.screenshot({ path: "/tmp/yo-mic-a.png" });
await p.waitForTimeout(2000); // ~60% of the 3.6s cycle: mic dipped
await p.screenshot({ path: "/tmp/yo-mic-b.png" });
await b.close();
console.log("ok");
