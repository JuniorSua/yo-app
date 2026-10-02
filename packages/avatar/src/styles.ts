/**
 * Avatar animation stylesheet. Injected once via React 19 <style href precedence> hoisting, so the
 * package has no CSS build step. All motion is disabled under prefers-reduced-motion.
 */
export const AVATAR_CSS = `
.yo-av{overflow:visible;display:inline-block;vertical-align:middle;flex-shrink:0}
.yo-av .yo-av-figure,.yo-av .yo-av-body,.yo-av .yo-av-look,.yo-av .yo-av-blink,.yo-av .yo-av-ring,
.yo-av .yo-av-shadow,.yo-av .yo-av-antenna,.yo-av .yo-av-z{transform-box:fill-box;transform-origin:center}
.yo-av .yo-av-body{transform-origin:50% 100%}
.yo-av .yo-av-look{transition:transform .35s cubic-bezier(.4,0,.2,1)}
.yo-av .yo-av-ring{opacity:0}
.yo-av--waiting .yo-av-ring{opacity:.85}
.yo-av--waiting .yo-av-look{transform:translateY(-3.4px)}
.yo-av--error .yo-av-body{filter:saturate(.15) brightness(.78)}
.yo-av--sleeping .yo-av-body{filter:saturate(.75) brightness(.92)}
.yo-av-z{opacity:0}
.yo-av--anim .yo-av-body{animation:yo-av-breathe 4.8s ease-in-out infinite;animation-delay:var(--yo-av-d,0s)}
.yo-av--anim .yo-av-blink{animation:yo-av-blink 5.6s infinite;animation-delay:var(--yo-av-d,0s)}
.yo-av--anim.yo-av--working .yo-av-figure{animation:yo-av-bob 1.15s ease-in-out infinite}
.yo-av--anim.yo-av--working .yo-av-look{animation:yo-av-scan 2.6s ease-in-out infinite}
.yo-av--anim.yo-av--working .yo-av-blink{animation-duration:3.8s}
.yo-av--anim.yo-av--working .yo-av-antenna{animation:yo-av-glow 1.15s ease-in-out infinite}
.yo-av--anim.yo-av--working .yo-av-shadow{animation:yo-av-shadow 1.15s ease-in-out infinite}
.yo-av--anim.yo-av--waiting .yo-av-ring{animation:yo-av-ring 1.8s cubic-bezier(.2,.6,.3,1) infinite}
.yo-av--anim.yo-av--waiting .yo-av-figure{animation:yo-av-sway 2.4s ease-in-out infinite}
.yo-av--anim.yo-av--done .yo-av-figure{animation:yo-av-hop .9s cubic-bezier(.3,.7,.4,1) 1 both}
.yo-av--anim.yo-av--done .yo-av-shadow{animation:yo-av-hop-shadow .9s cubic-bezier(.3,.7,.4,1) 1 both}
.yo-av--anim.yo-av--error .yo-av-figure{animation:yo-av-shake .5s ease-in-out 1}
.yo-av--anim.yo-av--sleeping .yo-av-body{animation-duration:7s}
.yo-av--anim.yo-av--sleeping .yo-av-z{animation:yo-av-z 3.6s ease-out infinite}
.yo-av--anim.yo-av--sleeping .yo-av-z2{animation-delay:1.8s}
.yo-av--noblink .yo-av-blink{animation:none!important}
@keyframes yo-av-breathe{0%,100%{transform:scale(1,1)}50%{transform:scale(1.014,1.028)}}
@keyframes yo-av-blink{0%,92%,97%,100%{transform:scaleY(1)}94.5%{transform:scaleY(.08)}}
@keyframes yo-av-bob{0%,100%{transform:translateY(0)}50%{transform:translateY(-3.5px)}}
@keyframes yo-av-shadow{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.86);opacity:.7}}
@keyframes yo-av-scan{0%,100%{transform:translateX(-3.4px)}38%,50%{transform:translateX(3.4px)}88%{transform:translateX(-3.4px)}}
@keyframes yo-av-glow{0%,100%{opacity:1}50%{opacity:.45}}
@keyframes yo-av-ring{0%{transform:scale(.92);opacity:.95}100%{transform:scale(1.16);opacity:0}}
@keyframes yo-av-sway{0%,100%{transform:rotate(0)}25%{transform:rotate(-2.5deg)}75%{transform:rotate(2.5deg)}}
@keyframes yo-av-hop{0%{transform:translateY(0) scale(1,1)}18%{transform:translateY(1px) scale(1.05,.94)}
40%{transform:translateY(-10px) scale(.96,1.05)}62%{transform:translateY(0) scale(1.06,.93)}
80%{transform:translateY(-1.5px) scale(.99,1.01)}100%{transform:translateY(0) scale(1,1)}}
@keyframes yo-av-hop-shadow{0%,18%,62%,100%{transform:scale(1);opacity:1}40%{transform:scale(.7);opacity:.5}}
@keyframes yo-av-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-3px)}40%{transform:translateX(3px)}
60%{transform:translateX(-2px)}80%{transform:translateX(2px)}}
@keyframes yo-av-z{0%{transform:translate(0,3px) scale(.5);opacity:0}25%{opacity:.9}100%{transform:translate(8px,-14px) scale(1.15);opacity:0}}
/* Dimensional finish (Violet Copilot direction): calmer motion carried by the eyes, per the design handoff.
   idle: quick blink every ~4–7s, no breathing. working: small gaze shift (1.8s), no bob. waiting: look up +
   one 3deg tilt, then hold (no repeating pulse). done: happy eyes + one 320ms nod. error: still, attentive.
   sleeping: closed eyes, no motion. */
.yo-av--dim.yo-av--anim .yo-av-body{animation:none}
.yo-av--dim.yo-av--anim .yo-av-blink{animation:yo-av-dim-blink 5.6s infinite;animation-delay:var(--yo-av-d,0s)}
.yo-av--dim.yo-av--anim.yo-av--working .yo-av-figure,.yo-av--dim.yo-av--anim.yo-av--working .yo-av-shadow{animation:none}
.yo-av--dim.yo-av--anim.yo-av--working .yo-av-look{animation:yo-av-gaze 1.8s ease-in-out infinite}
.yo-av--dim.yo-av--anim.yo-av--working .yo-av-blink{animation-duration:4.4s}
.yo-av--dim .yo-av-ring{stroke-width:2.6}
.yo-av--dim.yo-av--waiting .yo-av-look{transform:translateY(-2px)}
.yo-av--dim.yo-av--anim.yo-av--waiting .yo-av-ring{animation:none;opacity:.8}
.yo-av--dim.yo-av--anim.yo-av--waiting .yo-av-figure{animation:yo-av-tilt .6s cubic-bezier(.3,.7,.4,1) 1 both}
.yo-av--dim.yo-av--anim.yo-av--done .yo-av-figure{animation:yo-av-nod .32s ease-in-out 1}
.yo-av--dim.yo-av--anim.yo-av--done .yo-av-shadow{animation:none}
.yo-av--dim.yo-av--anim.yo-av--error .yo-av-figure{animation:none}
.yo-av--dim.yo-av--error .yo-av-body{filter:saturate(.55) brightness(.9)}
.yo-av--dim.yo-av--sleeping .yo-av-body{filter:saturate(.8) brightness(.94)}
.yo-av--dim .yo-av-z{animation:none!important;opacity:.55}
.yo-av--dim .yo-av-z2{opacity:.35}
@keyframes yo-av-dim-blink{0%,95%,97.5%,100%{transform:scaleY(1)}96.2%{transform:scaleY(.08)}}
@keyframes yo-av-gaze{0%,100%{transform:translateX(-2px)}45%,55%{transform:translateX(2px)}}
@keyframes yo-av-tilt{0%{transform:rotate(0)}100%{transform:rotate(3deg)}}
@keyframes yo-av-nod{0%,100%{transform:translateY(0)}45%{transform:translateY(2.2px)}}
/* Headset mic: while working, the mouthpiece dips a little now and then (mostly still). */
.yo-av--anim.yo-av--working .yo-av-mic{animation:yo-av-mic 3.6s ease-in-out infinite;animation-delay:var(--yo-av-d,0s)}
@keyframes yo-av-mic{0%,52%,100%{transform:rotate(0)}60%{transform:rotate(-6deg)}68%{transform:rotate(1.5deg)}
75%{transform:rotate(-3.5deg)}84%{transform:rotate(0)}}
/* Logo: Sunlit Satin finish keeps the same blink/look hooks. */
@media (prefers-reduced-motion:reduce){.yo-av *{animation:none!important;transition:none!important}}
`;
