# Security policy

Yo runs AI agents that can browse, use a computer, and (when you allow it) reach into your Mac. Security
reports are very welcome.

## Reporting a vulnerability

Please **don't open a public issue**. Report it privately through GitHub:
[Security → Report a vulnerability](https://github.com/JuniorSua/yo-app/security/advisories/new).

Include what an attacker could do, the steps to reproduce, and the Yo version (Settings → About) or commit. You'll usually hear
back within a week. Please give us a reasonable chance to fix it before talking about it publicly.

## What's in scope

- Getting around an approval, a takeover, or a Mac access grant (files, apps, window control).
- Reaching yo-core, agentd, VNC, CDP, or the terminal without the right token, or from outside the machine.
- Electron issues: renderer escaping to Node, unsafe IPC, loading remote content in a privileged window.
- Credentials (subscription logins, tokens, Keychain items) ending up in logs, URLs, files, or the agent's
  reach.
- Prompt injection that leads to one of the above. Prompt injection on its own (the agent was persuaded to say
  or do something silly inside its own computer) is a normal bug report.

## Supported versions

Only the latest release (and the latest `main`) is supported. Please check the issue still happens there.
