/** Creature avatar CSS (its own sheet: the app's styles.css and theme tokens are untouched). */
export const CREATURE_CSS = `
.yo-cr{position:relative;display:inline-block;flex:none;vertical-align:middle;isolation:isolate}
.yo-cr-host{position:absolute;inset:0;display:block}
.yo-cr canvas,.yo-cr>img{position:absolute;inset:0;width:100%;height:100%;display:block;pointer-events:none;user-select:none}
.yo-cr[data-glow]::before{content:"";position:absolute;inset:-16%;z-index:-1;border-radius:50%;pointer-events:none;
  background:radial-gradient(closest-side,rgba(255,206,58,.62),rgba(255,206,58,.3) 55%,rgba(255,206,58,0));
  animation:yo-cr-glow 2.2s ease-in-out infinite}
@keyframes yo-cr-glow{0%,100%{opacity:.7;transform:scale(.94)}50%{opacity:1;transform:scale(1.04)}}
.yo-cr-badge{position:absolute;right:0;bottom:4%;width:max(7px,14%);height:max(7px,14%);border-radius:50%;
  background:#ef4444;box-shadow:0 0 0 max(1.5px,4%) var(--bg,#fff)}
@media (prefers-reduced-motion:reduce){.yo-cr[data-glow]::before{animation:none}}
`;
