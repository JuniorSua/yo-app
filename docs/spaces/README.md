# Work & Personal spaces

Yo splits the day in two. **Work** is Yo, the main agent. **Personal** is Pip, a second long-lived agent for the rest
of life: plans, errands, family, health, hobbies, and ideas for improving Yo itself. A switch in the chat header (and a
small badge in the rail) shows which space you're in. It follows your work hours on its own, or you pick one by hand.

## Why spaces (Cursor + T3, the Yo way)

Yo's ethos is "use whichever model you want, never stuck to one." Two products shaped how spaces work:

- **Cursor** treats the model as a part you pick per task: a sticky picker in the chat, switchable mid-chat, any
  provider. It once had saved "custom modes" (a setup with its own model, tools and memory) and removed them in 2.1;
  users missed them.
- **T3 Code** runs on the subscriptions you already pay for (Claude, Codex, …) behind one UI, with a provider and
  model per thread and "provider instances" (e.g. Claude Work and Claude Personal as two accounts).

A Yo **space** is that saved setup, kept alive: its own agent, with its own model and subscription (the agent's
model picker), memory focus, priorities, and look. Pick Claude for Work and ChatGPT for Personal, or the same for both.
Either agent can still do anything; a space only decides focus.

## How it works

- **Schedule.** Settings → Work & Personal. Default: Mon–Fri 11:00 AM–7:00 PM is Work; everything else is Personal.
  Hours use the time zone in Settings (not the device's), handle overnight shifts and daylight saving.
- **Switching.** Auto follows the schedule. A manual pick holds until the next schedule change ("Personal until
  11:00 AM"), then Auto resumes. Turning "Switch automatically" off pins the current space. ⌘⇧M flips spaces; the
  command palette has the same actions.
- **At 7 PM** (or any boundary) Yo opens Pip if you're on Yo's chat and not mid-draft; otherwise a toast offers
  "Open Pip / Stay in Work". Phone and Telegram messages go to the active space's agent (an open phone task, or a
  Telegram `/use` pick, wins).
- **Memory.** Each memory is Work, Personal or Everywhere. Each agent's prompt holds its space plus Everywhere;
  `recall` searches everything, labelled. Existing memories start as Everywhere (except ones tagged
  `[area:work]` / `[area:personal]`), so nothing disappears. Memory page: filter by space, "Move to…" any row.
- **Look.** Personal is warmer: Pip's creature palette in light mode, a "warm dusk" palette in dark mode, a soft glow,
  and a short cross-fade when the space changes. "Warm look in Personal time" turns it off (per device).
- **Off.** Turning spaces off archives Pip (chats kept); turning them on brings the same Pip back.

Code map: `packages/contracts/src/spaces.ts` (schedule maths, shared by core and web), `apps/core/src/team/spaces.ts`
(Pip, active space), `apps/web/src/stores/space.ts` + `components/SpaceSwitch.tsx` (switch, timer),
`components/settings/SpacesSettings.tsx`, `lib/spaceTheme.ts`.

## Roadmap (not built yet)

1. Hold Work notifications and routines during Personal time (opt-in).
2. Model picker upgrades from Cursor/T3: favourites and search, "Legacy" models hidden, ⌘/ to cycle.
3. "Auto" model choice with a visible reason, falling back to another subscription when one hits its limit.
4. One usage view across subscriptions with reset times.
5. Compare: run one request on two subscriptions and keep the better answer.
6. More spaces than two (e.g. a side-business space), each with its own agent.
7. Per-space Telegram/phone numbers.
