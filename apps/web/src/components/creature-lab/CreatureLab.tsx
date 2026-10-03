import {
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  Check,
  ChevronRight,
  Circle,
  CircleHelp,
  Coffee,
  Headphones,
  Lightbulb,
  Moon,
  MoreHorizontal,
  MousePointer2,
  Pause,
  Play,
  Plus,
  Sparkles,
  Sprout,
  Volume2,
  Zap,
} from "lucide-react";
import { useState } from "react";
import { workspacePalette, workspaceVariables } from "../../lib/creatureHue";
import { CreatureCanvas } from "./CreatureCanvas";
import { CREATURES, type CreatureId, type CreatureState } from "./creatures";
import "./creature-lab.css";

const STATES = [
  { id: "idle", label: "Idle", icon: Coffee, note: "Just happy to be here.", activity: "Ready when you are" },
  {
    id: "working",
    label: "Working",
    icon: Zap,
    note: "Laptop out. Little hands, hard at work.",
    activity: "Putting the pieces together…",
  },
  {
    id: "thinking",
    label: "Thinking",
    icon: Lightbulb,
    note: "Give that little brain a moment.",
    activity: "Thinking through the details…",
  },
  {
    id: "question",
    label: "Question",
    icon: CircleHelp,
    note: "A little nudge when they need you.",
    activity: "A quick question for you",
  },
  {
    id: "done",
    label: "Done",
    icon: Sparkles,
    note: "All finished. Time for a little polish.",
    activity: "All done. Nice teamwork.",
  },
  {
    id: "sleeping",
    label: "Resting",
    icon: Moon,
    note: "Even busy little bugs need a break.",
    activity: "Taking a little breather",
  },
] as const;

export function CreatureLab() {
  const [selected, setSelected] = useState<CreatureId>("sprout");
  const [state, setState] = useState<CreatureState>("working");
  const [headset, setHeadset] = useState(true);
  const [paused, setPaused] = useState(false);
  const [dark, setDark] = useState(false);
  const [saved, setSaved] = useState(false);
  const [downloadError, setDownloadError] = useState("");
  const creature = CREATURES.find((c) => c.id === selected)!;
  const palette = workspacePalette(selected, dark);
  const currentState = STATES.find((s) => s.id === state)!;
  const download = () => {
    setDownloadError("");
    const canvas = document.querySelector<HTMLCanvasElement>(`.cl-card [data-creature="${selected}"]`);
    if (!canvas) {
      setDownloadError("The preview is not ready to export yet.");
      return;
    }
    canvas.dispatchEvent(new Event("creature-export"));
    canvas.toBlob((blob) => {
      if (!blob) {
        setDownloadError("Couldn't export this preview. Please try again.");
        return;
      }
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `yo-${selected}-${state}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }, "image/png");
  };
  const select = (id: CreatureId) => {
    setSelected(id);
    setSaved(false);
  };
  return (
    <div
      className="cl-page"
      data-hue={dark ? "neutral" : selected}
      style={
        !dark
          ? ({
              "--cl-bg": palette.bg,
              "--cl-soft": palette.surface,
              "--cl-active": palette.active,
              "--cl-ink": palette.text,
              "--cl-muted": palette.muted,
              "--cl-line": palette.line,
              "--cl-accent": creature.ink,
            } as React.CSSProperties)
          : undefined
      }
    >
      <header className="cl-nav">
        <a href="/" className="cl-brand" aria-label="Back to Yo">
          <span className="cl-brand-icon">
            <i />
            <i />
            <i />
            <i />
          </span>
          yo<span className="cl-brand-period">.</span>
        </a>
        <span className="cl-nav-divider" />
        <span className="cl-nav-title">Character workshop</span>
        <span className="cl-nav-edition">
          EXPLORATION 001 <span> / </span> THE LITTLE THINGS
        </span>
        <a className="cl-back" href="/">
          <ArrowLeft size={14} /> Back to workspace
        </a>
      </header>
      <main className="cl-main">
        <section className="cl-intro">
          <div>
            <div className="cl-eyebrow">
              <span /> A LITTLE MORE ALIVE
            </div>
            <h1>
              Good things come
              <br />
              with <span>little helpers.</span>
              <svg viewBox="0 0 44 44" className="cl-doodle" aria-hidden="true">
                <path d="M21 3 23 15 34 9 28 21 41 24 28 27 33 38 22 31 16 42 15 29 3 32 10 22 1 15 15 16Z" />
              </svg>
            </h1>
          </div>
          <div className="cl-intro-right">
            <p>
              A new kind of teammate.
              <br />A little curious. A little quirky.
              <br />
              Very much on your side.
            </p>
            <a href="#meet-the-team">
              Meet your next team <ArrowDown size={15} />
            </a>
          </div>
        </section>
        <section id="meet-the-team" aria-label="Compare agent characters">
          <div className="cl-section-heading">
            <span>THREE CHARACTERS. PLENTY OF CHARACTER.</span>
            <span>
              <span className="cl-live-dot" /> Live 3D previews{" "}
              <span className="cl-heading-separator">/</span> Move your cursor. Say hello.
            </span>
          </div>
          <div className="cl-grid">
            {CREATURES.map((c) => (
              <article
                className={`cl-card ${selected === c.id ? "cl-card-selected" : ""} ${state === "question" ? "cl-card-question" : ""}`}
                key={c.id}
                style={
                  {
                    "--creature-bg": c.background,
                    "--creature-ink": state === "question" ? "#856418" : c.ink,
                  } as React.CSSProperties
                }
              >
                <div className="cl-stage">
                  <div className="cl-stage-top">
                    <span className="cl-number">NO. {c.number}</span>
                    <button
                      className="cl-select"
                      aria-label={`Select ${c.name}`}
                      aria-pressed={selected === c.id}
                      onClick={() => select(c.id)}
                    >
                      {selected === c.id ? (
                        <>
                          <Check size={12} /> Selected
                        </>
                      ) : (
                        <>
                          Explore <Plus size={12} />
                        </>
                      )}
                    </button>
                  </div>
                  <CreatureCanvas
                    id={c.id}
                    background={c.background}
                    state={state}
                    headset={headset}
                    paused={paused}
                  />
                  {state === "question" && (
                    <div className="cl-question-bubble" role="img" aria-label={`${c.name} has a question`}>
                      ?
                    </div>
                  )}
                  <div className="cl-stage-bottom">
                    <span className="cl-state-label">
                      <span className={paused ? "" : "cl-dot-pulse"} />
                      {paused
                        ? "Paused for a portrait"
                        : currentState.label === "Done"
                          ? "Finishing touches"
                          : currentState.label === "Working"
                            ? "In the flow"
                            : state === "question"
                              ? "Needs your input"
                              : currentState.label}
                    </span>
                    <span className="cl-orbit-mark">
                      <MousePointer2 size={12} /> interactive
                    </span>
                  </div>
                </div>
                <button
                  className="cl-card-caption"
                  onClick={() => select(c.id)}
                  aria-label={`Explore ${c.name}`}
                >
                  <div>
                    <h2>
                      {c.name}
                      <span>{c.id === "sprout" ? "✳" : c.id === "pebble" ? "◒" : "✧"}</span>
                    </h2>
                    <p>{c.species}</p>
                  </div>
                  <span className="cl-card-arrow">
                    <ArrowRight size={18} />
                  </span>
                </button>
              </article>
            ))}
          </div>
        </section>
        <section className="cl-motion-bar" aria-label="Animation controls">
          <div className="cl-motion-title">
            <span className="cl-tiny-label">PERSONALITY IN MOTION</span>
            <span>See them in their element.</span>
          </div>
          <div className="cl-state-tabs" role="group" aria-label="Agent activity">
            {STATES.map((s) => (
              <button
                key={s.id}
                aria-pressed={state === s.id}
                onClick={() => setState(s.id)}
                className={`${state === s.id ? "is-active" : ""} ${s.id === "question" ? "cl-question-tab" : ""}`}
              >
                <s.icon size={14} />
                {s.label}
              </button>
            ))}
          </div>
          <div className="cl-accessories">
            <button
              className="cl-headset-control"
              role="switch"
              aria-checked={headset}
              aria-label="Headsets"
              onClick={() => setHeadset(!headset)}
            >
              <Headphones size={15} />
              <span>Headsets</span>
              <span className={`cl-toggle ${headset ? "is-on" : ""}`}>
                <i />
              </span>
            </button>
            <span className="cl-controls-divider" />
            <button
              className="cl-pause"
              aria-label={paused ? "Play animations" : "Pause animations"}
              aria-pressed={paused}
              onClick={() => setPaused(!paused)}
            >
              {paused ? <Play size={15} /> : <Pause size={15} />}
            </button>
          </div>
        </section>
        <div className="cl-motion-note">
          <span>
            <Circle size={5} fill="currentColor" /> {currentState.note}
          </span>
          <span>Soft movements. Real personality. Zero noise.</span>
        </div>
        <section className="cl-detail" aria-label={`${creature.name} in your workspace`}>
          <div className="cl-detail-copy">
            <span className="cl-eyebrow">A SMALL PRESENCE. A BIG DIFFERENCE.</span>
            <h2>
              Made to feel
              <br />
              like <em>your</em> teammate.
            </h2>
            <p>{creature.description}</p>
            <div className="cl-traits">
              <span>
                <Sprout size={13} /> Thoughtfully animated
              </span>
              <span>
                <Volume2 size={13} /> Delightfully quiet
              </span>
            </div>
            <div className="cl-actions">
              <button
                className="cl-primary"
                onClick={() => {
                  setSaved(true);
                  document.getElementById("cl-workspace")?.scrollIntoView({
                    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
                    block: "nearest",
                  });
                }}
              >
                {saved ? (
                  <>
                    <Check size={15} /> {creature.name} is your favorite
                  </>
                ) : (
                  <>
                    Pick {creature.name} <ArrowRight size={15} />
                  </>
                )}
              </button>
              <button className="cl-download" onClick={download}>
                <ArrowDownToLine size={14} /> Save portrait
              </button>
            </div>
            <span className="cl-save-note" role="status">
              {downloadError ||
                (saved
                  ? "Selected for this preview. Your existing agents are unchanged."
                  : "Try a favorite here. Make yourself at home.")}
            </span>
          </div>
          <div
            className={`cl-workspace ${dark ? "cl-workspace-dark" : ""} ${state === "question" ? "cl-workspace-question" : ""}`}
            style={workspaceVariables(selected, dark) as React.CSSProperties}
            data-hue={dark ? "neutral" : selected}
            id="cl-workspace"
          >
            <div className="cl-workspace-top">
              <span>AT HOME IN YO</span>
              <button
                onClick={() => setDark(!dark)}
                aria-label={dark ? "Use light workspace preview" : "Use dark workspace preview"}
              >
                <span className={!dark ? "active" : ""}>Light</span>
                <span className={dark ? "active" : ""}>Dark</span>
              </button>
            </div>
            <div className="cl-mini-app">
              <aside>
                <div className="cl-mini-wordmark">yo.</div>
                <div className="cl-mini-nav">
                  <Plus size={12} /> New thread
                </div>
                <span className="cl-mini-section">
                  YOUR TEAM <Plus size={11} />
                </span>
                {CREATURES.map((c) => (
                  <button
                    className={selected === c.id ? "active" : ""}
                    key={c.id}
                    onClick={() => select(c.id)}
                  >
                    <span style={{ background: c.background, color: c.ink }}>{c.name[0]}</span>
                    {c.name}
                    {selected === c.id && <span className="cl-mini-active-dot" />}
                  </button>
                ))}
                <div className="cl-mini-bottom">
                  <span>JS</span> Your workspace
                  <ChevronRight size={12} />
                </div>
              </aside>
              <div className="cl-mini-conversation">
                <div className="cl-chat-header">
                  <span className="cl-chat-avatar">
                    <CreatureCanvas
                      id={selected}
                      background={palette.active}
                      state={state}
                      headset={headset}
                      paused={paused}
                      miniature
                    />
                  </span>
                  <div>
                    <strong>{creature.name}</strong>
                    <span>
                      <i />
                      {currentState.activity}
                    </span>
                  </div>
                  <MoreHorizontal size={16} />
                </div>
                <div className="cl-chat-body">
                  <div className="cl-chat-user">Let's make something good.</div>
                  <div className="cl-chat-response">
                    <span
                      className="cl-response-icon"
                      style={{ background: creature.background, color: creature.ink }}
                    >
                      <Sparkles size={13} />
                    </span>
                    <div>
                      <strong>
                        {creature.name}
                        <span>just now</span>
                      </strong>
                      <p>
                        {state === "question" ? (
                          "Quick question before I go on: would you like a short summary or the full details?"
                        ) : state === "done" ? (
                          "All finished. Everything is ready for you — just giving the laptop a final polish."
                        ) : state === "thinking" ? (
                          "Let me think this through. I’m connecting a few ideas before the next step."
                        ) : (
                          <>
                            I'm on it. A little focus, a few helping hands,
                            <br className="cl-desktop-break" /> and we'll get there together.
                          </>
                        )}
                      </p>
                      {state === "working" || state === "thinking" ? (
                        <span className="cl-typing">
                          <i />
                          <i />
                          <i />
                        </span>
                      ) : (
                        <span className="cl-chat-done">{currentState.activity}</span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="cl-chat-input">
                  <span>Message {creature.name}…</span>
                  <span>
                    <Plus size={13} />
                    <ArrowRight size={14} />
                  </span>
                </div>
              </div>
            </div>
            <div className="cl-workspace-caption">
              <span>
                <span className="cl-live-dot" /> {creature.name}, at actual avatar size
              </span>
              <span>
                {dark
                  ? "A familiar dark workspace, for every character."
                  : `${creature.name}’s colors. Your whole workspace.`}
              </span>
            </div>
          </div>
        </section>
        <footer className="cl-footer">
          <span>
            <span className="cl-footer-flower">✳</span> A little more life in your everyday.
          </span>
          <span>
            YO CHARACTER LAB <i /> CONCEPT COLLECTION 01 <i /> OCT 2026
          </span>
        </footer>
      </main>
    </div>
  );
}
