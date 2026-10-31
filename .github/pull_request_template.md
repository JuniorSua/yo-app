<!--
Keep the PR small and about one thing. Title in plain words, like the recent history:
"Window control: clear feedback when the Mac confirmation is cancelled".
"None" is a fine answer for any section. See CONTRIBUTING.md.
-->

## What changes for the user
<!-- What someone using Yo will notice. For internal-only changes, say what gets better and for whom. -->

## Fixes a public issue?
<!-- Fixing a bug someone reported on JuniorSua/yo-app? Write "Fixes yo-app#N" here AND as a line in one of the
commit messages (that's what the release reads). Never "JuniorSua/yo-app#N": GitHub would close it too early. -->

## Lane / branch
<!-- The branch, and the area or lane it belongs to, e.g. "UI polish (ui/polish)". -->

## How it was tested
- [ ] `pnpm check` (typecheck + lint + unit tests)
- [ ] `pnpm e2e` (UI tests against the mock backend)
- [ ] Checked in the real app (Yo.app / dev server). What I did:
<!-- Commands, results, test counts. Say what you could NOT check (e.g. "needs a real Mac"). -->

## Screenshots
<!-- Required for anything visible: before/after, dark and light if colors changed. Drag images into this box;
don't commit PR-only images. -->

## Touches shared files?
<!-- Files other open work also changes, e.g. styles.css, apps/desktop/src/main.ts,
packages/contracts. Name them so the merges can be checked together. -->

## Security-sensitive?
<!-- Auth/tokens, Electron (preload, IPC, windows), device or Mac access, approvals, secrets/Keychain, network
exposure, database migrations. If yes, explain what's enforced and where. -->

## Deploy notes
<!-- Anything needed after merge: a core redeploy, a Yo.app rebuild, migrations, rollback. -->
