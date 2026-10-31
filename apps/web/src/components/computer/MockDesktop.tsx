/**
 * Mock-mode stand-in for the live noVNC screen: a rendered Linux desktop with a Chromium window
 * showing whatever the agent last browsed (derived from the timeline). Designed at 1280x800 and
 * scaled to fit, so it looks identical in the work pane and full screen.
 */

import { YoLogo } from "@yo/avatar";
import type { AgentView } from "@yo/contracts";
import { ArrowLeft, ArrowRight, Lock, MoreVertical, RotateCw, Search, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { hostOf } from "../../lib/utils";
import { useTimeline } from "../../stores/timeline";

const W = 1280;
const H = 800;

function useLatestUrl(agentId: string): string | null {
  const entries = useTimeline((s) => s.byAgent[agentId]);
  if (!entries) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    const url = (e.item.input as { url?: string } | undefined)?.url;
    if (e.item.kind === "browser" && url) return url;
  }
  return null;
}

const bar = (w: number | string, h = 10, c = "#e5e5e5") => (
  <div style={{ width: w, height: h, background: c, borderRadius: h / 2 }} />
);

function ShopPage({ query }: { query: string }) {
  const colors = ["#f1f5f9", "#fef3c7", "#e0f2fe", "#fce7f3", "#dcfce7", "#ede9fe", "#ffedd5", "#f5f5f4"];
  return (
    <div style={{ background: "#fff", height: "100%" }}>
      <div
        style={{
          background: "#131921",
          height: 64,
          display: "flex",
          alignItems: "center",
          gap: 20,
          padding: "0 24px",
        }}
      >
        <div style={{ color: "#fff", fontWeight: 700, fontSize: 24, letterSpacing: -0.5 }}>
          shop<span style={{ color: "#FF9900" }}>.</span>
        </div>
        <div
          style={{
            flex: 1,
            height: 40,
            background: "#fff",
            borderRadius: 8,
            display: "flex",
            alignItems: "center",
            padding: "0 14px",
            color: "#111",
            fontSize: 15,
          }}
        >
          {query}
        </div>
        <div style={{ width: 44, height: 40, background: "#febd69", borderRadius: 8 }} />
        {bar(80, 10, "#3a4553")}
      </div>
      <div style={{ padding: "20px 24px", color: "#565959", fontSize: 14 }}>1–24 of over 2,000 results</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 20, padding: "0 24px" }}>
        {colors.map((c, i) => (
          <div key={i} style={{ border: "1px solid #eee", borderRadius: 10, padding: 14 }}>
            <div
              style={{
                height: 150,
                background: c,
                borderRadius: 8,
                marginBottom: 12,
                display: "grid",
                placeItems: "center",
              }}
            >
              <div style={{ width: 70, height: 70, borderRadius: 18, background: "rgba(0,0,0,0.06)" }} />
            </div>
            {bar("92%", 9, "#d4d4d4")}
            <div style={{ height: 7 }} />
            {bar("70%", 9, "#e5e5e5")}
            <div style={{ height: 12 }} />
            <div style={{ fontSize: 20, fontWeight: 700, color: "#0F1111" }}>
              ${[24.99, 19.49, 31.0, 27.95, 22.5, 35.99, 18.75, 29.0][i]}
            </div>
            <div style={{ marginTop: 10, height: 28, borderRadius: 14, background: "#FFD814" }} />
          </div>
        ))}
      </div>
    </div>
  );
}

function ArticlePage({ title }: { title: string }) {
  return (
    <div style={{ background: "#fff", height: "100%", padding: "34px 120px", color: "#202122" }}>
      <div
        style={{
          fontFamily: "Georgia, serif",
          fontSize: 34,
          borderBottom: "1px solid #a2a9b1",
          paddingBottom: 8,
        }}
      >
        {title}
      </div>
      <div style={{ fontSize: 13, color: "#54595d", margin: "10px 0 22px" }}>From the free encyclopedia</div>
      <div style={{ display: "flex", gap: 36 }}>
        <div style={{ flex: 1, display: "grid", gap: 11 }}>
          {Array.from({ length: 16 }, (_, i) => (
            <div key={i}>
              {bar(
                `${[96, 100, 88, 94, 72, 100, 91, 97, 64, 99, 86, 93, 100, 78, 90, 55][i]}%`,
                10,
                "#e3e5e8",
              )}
            </div>
          ))}
        </div>
        <div
          style={{
            width: 260,
            border: "1px solid #a2a9b1",
            background: "#f8f9fa",
            padding: 12,
            display: "grid",
            gap: 10,
            alignContent: "start",
          }}
        >
          <div style={{ height: 150, background: "linear-gradient(135deg,#cbd5e1,#e2e8f0)" }} />
          {bar("80%", 9, "#d9dce0")}
          {bar("60%", 9, "#d9dce0")}
          {bar("70%", 9, "#d9dce0")}
        </div>
      </div>
    </div>
  );
}

function FlightsPage() {
  return (
    <div style={{ background: "#fff", height: "100%", padding: "28px 80px", color: "#202124" }}>
      <div style={{ fontSize: 30, fontWeight: 400, marginBottom: 18 }}>Flights</div>
      <div style={{ display: "flex", gap: 12, marginBottom: 24 }}>
        {["Miami", "Lisbon", "Oct 10", "Oct 14"].map((t) => (
          <div
            key={t}
            style={{
              flex: 1,
              border: "1px solid #dadce0",
              borderRadius: 8,
              height: 52,
              display: "flex",
              alignItems: "center",
              padding: "0 16px",
              fontSize: 16,
            }}
          >
            {t}
          </div>
        ))}
      </div>
      <div style={{ border: "1px solid #dadce0", borderRadius: 12, overflow: "hidden" }}>
        {[
          ["7:05 AM – 8:40 PM", "JetBlue", "Nonstop", "$318"],
          ["9:40 AM – 11:05 PM", "Delta", "Nonstop", "$352"],
          ["1:15 PM – 6:30 AM+1", "United", "1 stop", "$361"],
          ["4:50 PM – 9:10 AM+1", "TAP Air Portugal", "Nonstop", "$389"],
          ["8:25 PM – 1:45 PM+1", "American", "1 stop", "$402"],
        ].map((r, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              padding: "18px 22px",
              borderTop: i ? "1px solid #eee" : undefined,
              fontSize: 16,
            }}
          >
            <div
              style={{
                width: 34,
                height: 34,
                borderRadius: 8,
                background: ["#dbeafe", "#fee2e2", "#e0e7ff", "#dcfce7", "#f3f4f6"][i],
              }}
            />
            <div style={{ flex: 1 }}>
              <div style={{ fontWeight: 500 }}>{r[0]}</div>
              <div style={{ color: "#70757a", fontSize: 13 }}>{r[1]}</div>
            </div>
            <div style={{ width: 120, color: "#70757a" }}>{r[2]}</div>
            <div style={{ fontWeight: 600, color: i === 0 ? "#188038" : undefined }}>{r[3]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ListPage() {
  return (
    <div style={{ background: "#f6f6ef", height: "100%" }}>
      <div
        style={{
          background: "#ff6600",
          height: 30,
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "0 10px",
          fontSize: 14,
          fontWeight: 700,
        }}
      >
        <div
          style={{
            width: 18,
            height: 18,
            border: "1px solid #fff",
            color: "#fff",
            display: "grid",
            placeItems: "center",
            fontSize: 12,
          }}
        >
          Y
        </div>
        News
      </div>
      <div style={{ padding: "10px 16px", display: "grid", gap: 14 }}>
        {Array.from({ length: 14 }, (_, i) => (
          <div key={i} style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span style={{ color: "#828282", width: 22, textAlign: "right", fontSize: 14 }}>{i + 1}.</span>
            <div style={{ display: "grid", gap: 5 }}>
              {bar(300 + ((i * 97) % 380), 10, "#c9c9bd")}
              {bar(180 + ((i * 53) % 90), 7, "#dedbd0")}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function NewTabPage() {
  return (
    <div style={{ background: "#202124", height: "100%", display: "grid", placeItems: "center" }}>
      <div style={{ display: "grid", justifyItems: "center", gap: 26, marginTop: -60 }}>
        <YoLogo size={92} />
        <div
          style={{
            width: 560,
            height: 46,
            borderRadius: 23,
            background: "#303134",
            display: "flex",
            alignItems: "center",
            gap: 12,
            padding: "0 18px",
            color: "#9aa0a6",
            fontSize: 16,
          }}
        >
          <Search size={18} /> Search or type a URL
        </div>
      </div>
    </div>
  );
}

function PageFor({ url }: { url: string | null }) {
  const host = hostOf(url ?? "");
  if (!url) return <NewTabPage />;
  if (/amazon|shop|bestbuy|bhphoto/.test(host)) {
    const q = (() => {
      try {
        return new URL(url).searchParams.get("k") ?? "";
      } catch {
        return "";
      }
    })();
    return <ShopPage query={q || "Search"} />;
  }
  if (/google/.test(host)) return <FlightsPage />;
  if (/ycombinator|reddit/.test(host)) return <ListPage />;
  return (
    <ArticlePage
      title={
        host
          .split(".")
          .slice(-2, -1)[0]
          ?.replace(/^\w/, (c) => c.toUpperCase()) ?? "Page"
      }
    />
  );
}

export function MockDesktop({ agent, interactive }: { agent: AgentView; interactive?: boolean }) {
  const url = useLatestUrl(agent.id);
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.3);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setScale(el.clientWidth / W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const working = agent.activity === "working";
  const host = hostOf(url ?? "") || "New Tab";

  return (
    <div
      ref={ref}
      data-testid="mock-desktop"
      className="relative h-full w-full overflow-hidden"
      style={{ cursor: interactive ? "default" : undefined }}
    >
      <div
        style={{
          width: W,
          height: H,
          transform: `scale(${scale})`,
          transformOrigin: "0 0",
          fontFamily: "Inter, 'Geist Variable', system-ui, sans-serif",
          background:
            "radial-gradient(1200px 700px at 80% 110%, rgba(255,212,59,0.22), transparent 60%), radial-gradient(900px 600px at 0% 0%, #2b2d36, transparent 70%), #121317",
          position: "relative",
        }}
      >
        {/* top panel */}
        <div
          style={{
            height: 28,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 14px",
            color: "#d4d4d8",
            fontSize: 13,
            background: "rgba(0,0,0,0.45)",
          }}
        >
          <span style={{ fontWeight: 600 }}>Activities</span>
          <span>
            {new Date().toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}
          </span>
          <span style={{ display: "flex", gap: 8 }}>
            <span style={{ width: 14, height: 9, borderRadius: 2, border: "1.5px solid #d4d4d8" }} />
          </span>
        </div>
        {/* chromium window */}
        <div
          style={{
            position: "absolute",
            left: 34,
            top: 50,
            right: 34,
            bottom: 26,
            borderRadius: 12,
            overflow: "hidden",
            background: "#fff",
            boxShadow: "0 30px 80px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.08)",
            display: "flex",
            flexDirection: "column",
          }}
        >
          <div
            style={{
              background: "#dee1e6",
              height: 40,
              display: "flex",
              alignItems: "flex-end",
              padding: "0 10px",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", gap: 7, alignSelf: "center", marginRight: 10 }}>
              {["#ff5f57", "#febc2e", "#28c840"].map((c) => (
                <span
                  key={c}
                  style={{ width: 12, height: 12, borderRadius: 6, background: c, opacity: 0.85 }}
                />
              ))}
            </div>
            <div
              style={{
                background: "#fff",
                height: 32,
                borderRadius: "10px 10px 0 0",
                width: 240,
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 12px",
                fontSize: 13,
                color: "#202124",
              }}
            >
              <span
                style={{ width: 16, height: 16, borderRadius: 4, background: url ? "#94a3b8" : "#FFD43B" }}
              />
              <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {host}
              </span>
            </div>
            <div style={{ color: "#5f6368", alignSelf: "center", fontSize: 20, marginLeft: 4 }}>+</div>
          </div>
          <div
            style={{
              background: "#fff",
              height: 44,
              display: "flex",
              alignItems: "center",
              gap: 14,
              padding: "0 14px",
              borderBottom: "1px solid #e5e7eb",
              color: "#5f6368",
            }}
          >
            <ArrowLeft size={18} />
            <ArrowRight size={18} opacity={0.4} />
            <RotateCw size={16} />
            <div
              style={{
                flex: 1,
                height: 32,
                borderRadius: 16,
                background: "#f1f3f4",
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 14px",
                fontSize: 14,
                color: "#202124",
              }}
            >
              {url ? <Lock size={13} color="#5f6368" /> : <Search size={14} />}
              <span style={{ overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis" }}>
                {url ? url.replace(/^https?:\/\//, "") : "Search or type a URL"}
              </span>
              <span style={{ flex: 1 }} />
              <Star size={15} />
            </div>
            <MoreVertical size={18} />
          </div>
          <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
            <PageFor url={url} />
          </div>
        </div>
        {working && (
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              animation: "yo-mock-cursor 7s ease-in-out infinite",
              filter: "drop-shadow(0 2px 3px rgba(0,0,0,0.4))",
            }}
          >
            <path
              d="M4 2l16 9.5-7 1.6-3.6 6.9z"
              fill="#111"
              stroke="#fff"
              strokeWidth="1.5"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </div>
      <style>{`@keyframes yo-mock-cursor{0%{transform:translate(520px,300px)}20%{transform:translate(760px,180px)}40%{transform:translate(640px,460px)}60%{transform:translate(300px,380px)}80%{transform:translate(900px,560px)}100%{transform:translate(520px,300px)}}`}</style>
    </div>
  );
}
