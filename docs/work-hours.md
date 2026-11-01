# Your work hours

Yo used to split the day into two **spaces**, Work and Personal, each with its own main agent: Yo during work hours
and Pip after them. A switch in the rail showed the space, it flipped on the work-hours schedule (⌘⇧M by hand), the
app could move the chat to Pip at 7 PM, and Personal time had a warmer look. Spaces were removed on 31 October 2026.

## Why it went

People already pick their agents for each part of life, for example one teammate for work and Pip for home. Spaces
got in the way of that. The app swapped agents on a timer, an update could leave the wrong agent in front, and
turning spaces off archived Pip. Spaces were really two features mixed together: knowing when you work, and picking
which agent to talk to. You already pick the agent by opening its chat, so only the first part is kept.

## What it is now

- **Every agent is a normal teammate.** Yo is the primary agent. Pip, Pepe and the rest are teammates in the Team
  popover, each with its own chats, and any of them except Yo can be archived. New users start with Yo only: no
  Pip is created for them.
- **The app reopens the last chat** you had open on that device (or Yo's, if that agent is gone). Nothing changes
  with the time of day.
- **Settings → Profile → Your work hours.** Each day can be on or off, with a start and an end time; hours that end at
  or before they start run past midnight. The time zone setting sits below them.
- **Every agent's prompt says the hours** (`workHoursLine` in `packages/contracts/src/workHours.ts`, used by
  `PromptBuilder.ts`): "Sam's work hours: every day 11:00–19:00 (America/New_York). It's now Sat 6:40 PM, inside
  work hours." The prompt also asks agents, gently, not to bring up work outside those hours unless the user does,
  and to save non-urgent work notifications for work hours. The user can still ask for anything at any time. Each
  message's time stamp adds "· work hours" or "· outside work hours", so a long session keeps up. Users with no
  days on get neither the line nor the tag.
- **Memory focus.** Each memory has a label: Work, Personal or Everywhere. An agent can have a memory focus (stored
  as `space` on the agent). Yo's is Work and Pip's is Personal, so each prompt shows the memories with that label
  plus the Everywhere ones. An agent with no focus, like Pepe or any new teammate, sees every memory. `recall`
  searches everything and shows each result's label. On the Memory page you can filter by label and change a
  memory's label ("Label as…").
- **Phone and Telegram** go to Yo, the primary agent. You can still choose another agent: Telegram's `/use` does
  that, and while the phone is in the middle of a task, its messages stay with that task's agent. The Tasks page,
  the phone's task list and the morning brief belong to Yo too.

## The upgrade (migration 16, `apps/core/src/db/db.ts`)

- Deletes the `spacesOn` and `spaceManual` settings. The work hours, agents, memories with their labels, and chats
  stay the same.
- Never archives, deletes or restores an agent. If Pip was archived because spaces were turned off, it stays
  archived.
- If spaces were turned off, every agent was already seeing every memory. The upgrade clears the live agents'
  memory focus so that stays true. Otherwise (the owner's install), Yo keeps Work and Pip keeps Personal.

Code map: `packages/contracts/src/workHours.ts` (schedule maths and the prompt line), `memoryLabels.ts`,
`apps/core/src/team/memoryFocus.ts`, and `apps/web/src/components/settings/ProfileSettings.tsx`.
