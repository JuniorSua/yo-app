/** Proof sheet: all 15 CupCats (renders /tmp/yo-cupcats.png). */

import { writeFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AVATAR_CSS, Avatar, CUPCAT_VARIANTS, RARITY_COLOR, RARITY_LABEL } from "../src/index";

void React;
const cat = (variant: string) => ({
  shape: "cupcat" as const,
  color: "yo",
  eyes: "capsule" as const,
  accessory: "headset" as const,
  variant,
});
const section = (bg: string, fg: string) =>
  renderToStaticMarkup(
    <div style={{ background: bg, color: fg, padding: 20, font: "11px system-ui" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(8, 140px)", gap: 10 }}>
        {CUPCAT_VARIANTS.map((v) => (
          <div key={v.id} style={{ textAlign: "center" }}>
            <Avatar avatar={cat(v.id)} size={128} animated={false} />
            <div style={{ fontWeight: 600 }}>
              {v.name} <span style={{ opacity: 0.6 }}>{v.jp}</span>
            </div>
            <div style={{ color: RARITY_COLOR[v.rarity] }}>
              {RARITY_LABEL[v.rarity]} · {v.odds}%
            </div>
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 14 }}>
        {CUPCAT_VARIANTS.map((v) => (
          <Avatar key={v.id} avatar={cat(v.id)} size={34} animated={false} />
        ))}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", marginTop: 10 }}>
        {CUPCAT_VARIANTS.map((v) => (
          <Avatar key={v.id} avatar={cat(v.id)} size={20} animated={false} />
        ))}
        {(["idle", "working", "waiting", "done", "error", "sleeping"] as const).map((st) => (
          <Avatar key={st} avatar={cat("matcha")} size={56} state={st} animated={false} />
        ))}
      </div>
    </div>,
  );
writeFileSync(
  "/tmp/yo-cupcats.html",
  `<html><head><meta charset="utf-8"><style>${AVATAR_CSS}</style></head><body style="margin:0">${section("#0B0C0E", "#ECECEE")}${section("#FAFAF8", "#1A1A1A")}</body></html>`,
);
const { chromium } = await import("@playwright/test");
const b = await chromium.launch();
const pg = await b.newPage({ viewport: { width: 1240, height: 900 }, deviceScaleFactor: 2 });
await pg.goto("file:///tmp/yo-cupcats.html");
await pg.screenshot({ path: "/tmp/yo-cupcats.png", fullPage: true });
await b.close();
console.log("ok");
