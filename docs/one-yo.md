# One Yo

You talk to one agent: Yo. Everything else works for Yo.

This page is the reference for Yo's prompts (`apps/core/src/orchestrator/PromptBuilder.ts`) and for how the app
shows the team. When they disagree with it, this page wins.

## The model

| Who | Lives | Talks to the user | Has its own |
| --- | --- | --- | --- |
| **Yo** (the primary agent) | always | yes, the only one | chat, memory, computer seat, routines, helpers |
| **Specialists** (one for sales leads, one for personal life, a content manager…) | until archived | no | job, memory focus, computer seat, routines, task ledger |
| **Helpers** | one job | no | a fresh screen for that job; report to whoever started them |

- `isLead()` (contracts `memoryLabels.ts`) is true only for the primary. A memory focus (`space`) is just which
  memories an agent sees; it no longer makes an agent a lead.
- A specialist is a long-lived agent with `kind: "agent"` (or no kind) that isn't primary. The API keeps those
  values; "specialist" is the user-facing word (it replaces "teammate").

## How Yo routes

For each request Yo picks one of four things:

1. **Do it itself** when it's quick or general.
2. **Hand it to the specialist whose job fits** with `message_agent`, and tell the user in one line ("Asked Dew
   to follow up on the leads."). When the specialist reports back, Yo relays it in a few lines.
3. **Start helpers** for parallel, self-contained one-offs no specialist owns.
4. **Suggest a specialist** when a recurring area has none. `create_agent` adds it after the user approves.

"Take care of pending leads" goes to the specialist whose job covers leads; "pull content info" goes to the content
manager, or to helpers if there's none. Yo weighs the request's area and who's busy.

## Specialists

- Get work from Yo and report back to Yo (`message_agent`) when done or blocked. Reports are short.
- Keep their own seat, memory focus, routines and approvals. A card they raise is still the user's to answer.
  A `notify_user` from a specialist carries its name, so the user knows who it came from.
- Don't start helpers, add agents or make phone links.

## Visibility

- The user can **watch** a specialist (its activity, screen and timeline) but can't chat with it.
- A message aimed at a specialist from any client (`chat.send`, the phone, Telegram, Tasks Start) goes to Yo
  as `@<Name> <text>`, so Yo routes it. Older clients keep working; nothing is rejected.
- Yo's chat shows each exchange: `message_agent` steps and the specialist's messages carry
  `item.exchange = { direction: "to" | "from", agentId, name, text, at, exchangeId? }` (contracts `events.ts`).
- The team list (`AgentView`) gives each specialist's `teamRole`, job (`role`), `activity`, `lastActiveAt`,
  `statusLine` and `currentTask`.

## Why

One voice is simpler to use and to trust: the user never wonders whom to ask, and Yo keeps the whole picture
(memory, context, priorities). Specialists give depth and separation (sign-ins, memory focus, models) without
making the user manage a team. Helpers give parallelism without anything standing around. The foundation
works with one agent and gets better as specialists join.
