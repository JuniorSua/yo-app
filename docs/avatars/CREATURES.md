# Creature avatars: Sprout, Pebble and Mimi

Three procedural Three.js characters (from the `?creature-lab=1` workshop) that any agent can wear. Pick one in
the avatar studio (new agent, agent settings, onboarding "Meet Yo"). The other avatar styles stay available.

## Data

`Avatar.creature = { kind: "sprout" | "pebble" | "mimi" }` (packages/contracts). Picking a creature also fills
`shape`/`color` with a close drawn look (`CREATURE_FALLBACK`: Sprout → lime pebble, Pebble → orange bubble,
Mimi → violet cloud), shown while the renderer loads, without WebGL, or after a render error. Picking any drawn
style, a living character, a CupCat or an image clears `creature` (`editDrawn` / `pickCreature` in
`apps/web/src/components/avatarEdit.ts`).

## Poses and the activity mapping

| AgentActivity | Pose | What you see |
| --- | --- | --- |
| idle | idle | gentle breathing |
| working | working | pulls out a laptop with one hand and types on it |
| working, turn reasoning / writing | thinking | thought cloud above the head, laptop put away |
| waiting (question, approval) | question | hands up, yellow glow around the avatar |
| done | done | polishes the outside of its laptop lid with a cloth |
| sleeping | sleeping | sleeping eyes |
| error | question, no glow | the question pose plus a small red badge (the status pill says "Error") |

Headsets are always on. Hands follow explicit elbow/hand targets so they never pass through the head, earcups,
microphone or laptop lid; `packages/avatar/src/creatures/model.test.ts` walks every state transition at both
geometry levels and checks this.

### When is it "thinking"?

`creatureState(activity, turnInfo)` in `packages/avatar/src/creatures/state.ts` (pure, unit-tested):

- Only for `working`. The current turn is everything after the last user message in the agent's timeline.
- **Thinking** when no tool-like step (command, file change, tool, browser, web) is running and the newest step
  is reasoning, a streaming reply, or there's no step yet.
- **Working** while a tool step runs, and between two tool steps (the newest step is a finished tool), so the
  laptop doesn't flicker in and out.
- The plan (todo) and notices are ignored (a plan stays "running" for the whole turn).
- Where the timeline isn't at hand (sidebar, lists) it's always **working**. Only the live avatar of the agent
  you're viewing reads its timeline (`AgentAvatar live`).

## Performance design

The owner's Mac has 16 GB, so the goal is: a list of creature agents costs pictures, not WebGL.

- **`three` is never in the main bundle.** `<Avatar>` lazy-loads `creatures/CreatureAvatar` only when a
  creature avatar is rendered; three.js lands in its own chunk (shared with the workshop page). Agents without
  creatures load nothing new.
- **One WebGL context for all creatures** (`creatures/engine.ts`). It's created on first use and released 5 s
  after nothing needs it (cached pictures stay).
- **One live canvas.** Avatars of the agent you're viewing ask to be live (chat header, empty-state hero,
  studio preview). The largest one on screen gets the renderer's canvas, moved into its box; every other avatar
  shows a still picture. Rendering straight into the visible canvas means no per-frame pixel read-back.
- **Still pictures for lists.** Sidebar, timeline, pickers, palettes: one picture per (creature, pose, size
  bucket), drawn once at 2x and scaled down, shared by every `<img>` as an object URL. Size buckets are 48, 96,
  160 and 256 device px, so all small list sizes share one picture per pose.
- **Fast start.** The app's renderer skips the workshop's environment-map prefilter (seconds of CPU without a
  GPU); a brighter sky light stands in for it.
- **Cheap frames.** Lighter geometry for avatars (`detail: "avatar"`), no shadow map (a contact shadow grounds
  the creature), no MSAA (the live canvas is drawn at 2x its CSS size instead), merged keycaps. Frame rate:
  8 fps for calm poses (idle, asleep, question) in small avatars, 15 fps for busy ones; 20/30 fps from 64 px.
- **Pauses.** The loop stops when the window is hidden (`visibilitychange`) or the canvas is offscreen
  (IntersectionObserver). With `prefers-reduced-motion` (or `animated={false}`) each pose is one settled still
  frame, redrawn only when it changes; the glow doesn't pulse.
- **Disposal.** Every built creature disposes its geometries/materials when it's replaced; the stage
  (textures, environment map in the workshop) and the renderer are disposed (and the context released) with the engine.

## Crash safety

- An error boundary around each creature falls back to its drawn look (a broken creature never blanks the app).
- A failed dynamic import is caught by the same boundary.
- No WebGL: the engine constructor throws once, the failure is remembered, and every creature shows its drawn
  look. A lost WebGL context does the same for live avatars; a new engine is made on the next request.
- Still-picture promises are always handled (rejections turn into the drawn fallback).

## Where things are

- `packages/avatar/src/creatures/meta.ts`: names, `creatureAvatar`, drawn fallbacks (no three.js).
- `packages/avatar/src/creatures/state.ts`: activity mapping, `turnInfo`, cache keys, frame rates (no three.js).
- `packages/avatar/src/creatures/model.ts` + `poses.ts`: the rigs (also used by the `?creature-lab=1` workshop
  through `@yo/avatar/creatures`).
- `packages/avatar/src/creatures/engine.ts` + `CreatureAvatar.tsx` + `styles.ts`: renderer, React component and
  its own CSS (glow, error badge).
- `/?gallery=1&creature=sprout` (dev page): every pose of one creature, as the app draws it.
- Mock: `&mockCreatures=1` gives every mock agent a creature. `scripts/avatar-perf.mjs` measures memory/CPU.
