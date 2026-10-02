# Contributing to Yo

Thanks for helping. Yo has one maintainer, and most changes are written by AI agents working in parallel, so
this guide is mostly about keeping many small changes easy to check and merge.

## Setup

You need Node 22 (see `.nvmrc`) and pnpm 9 (`corepack enable` picks the right version from `package.json`).

```bash
pnpm install
pnpm check                      # typecheck + lint + unit tests
pnpm e2e                        # Playwright UI tests against the in-browser mock backend
pnpm --filter @yo/web dev:mock  # the UI alone, with the mock backend
pnpm dev                        # core + web for real, at http://127.0.0.1:5173
```

The first `pnpm e2e` may ask you to run `pnpm exec playwright install chromium`. Building the agent's computer
(`pnpm computer:build`) needs Docker; the Mac app (`pnpm app:build`) needs macOS on Apple silicon. Neither is
needed for most changes.

## Branches, and how changes land

- One branch per change, cut from an up-to-date `main`. Never commit straight to `main`.
- Several changes are usually in flight at once. If yours touches files other open work also changes (shared
  styles, `apps/desktop/src/main.ts`, `packages/contracts`), say so in the PR ("Touches shared files?").
- Releases and deploys are made from `main` only, after merging. Never from a feature branch.
- Yo is developed in the maintainer's own repository and published to the public repo as one snapshot commit
  per release. A pull request on the public repo is reviewed there as usual; once accepted, the maintainer
  brings it into the development repo, and it ships in the next snapshot with credit in the PR.

## Before you open a PR

1. Rebase on `main` (`git fetch && git rebase origin/main`).
2. Run `pnpm check` and `pnpm e2e`. Both must pass.
3. For anything visible, try it in the real app and take screenshots (before/after; dark and light if colors
   changed). Attach them to the PR, don't commit them. The reference shots in `e2e/screenshots/` are refreshed
   with `pnpm e2e --grep screenshots` only when a UI change is meant to change them.
4. Fill in the PR template. "None" is a fine answer.

CI runs the same checks on every PR (typecheck, lint, unit tests, builds, and the e2e suite in Chromium). The
PR can only be merged when the `ci` check is green.

## Style

- **Small, focused PRs.** One problem per PR. A second fix or an unrelated cleanup gets its own PR.
- **Commits and PR titles in plain words**, describing the result, like the existing history:
  `Window control: clear feedback when the Mac confirmation is cancelled`,
  `Handoff: R3 + R4 deployed; T3 Code on the home PC`. An area prefix (`Web:`, `Helper:`, `Docs:`) helps.
- **PR descriptions start with what changes for the user**, then evidence: commands run, test counts, and
  anything you couldn't check (for example, "needs a real Mac").
- Code style is enforced by biome (`pnpm lint`; `pnpm exec biome check --write .` fixes most of it).
- Tests go next to the code (`*.test.ts`, vitest) and UI flows in `e2e/tests` (against the mock backend in
  `apps/web`).

## Security

Changes to auth, Electron (preload, IPC, windows), device and Mac access, approvals, secrets, or anything that
listens on the network need a sentence in the PR on what's enforced and where. Never commit tokens, personal
addresses, or machine-specific paths. To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Bugs and ideas

Use the issue forms (Bug report, Feature request). Yo agents can file bug reports themselves; those carry the
`from-yo` label.
