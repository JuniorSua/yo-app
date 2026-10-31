# pc/: Yo's PC edition package

Yo on a Windows or Linux PC: Yo's core and the agent's computer run in Docker, and the user opens Yo in a browser
at `http://127.0.0.1:7777`. This folder is everything that gets them there. The release workflow
(`.github/workflows/release.yml`, job `pc`) attaches it to every GitHub release with the version baked in, and
the public README's one-liners run the latest release's installer:

```text
Windows (PowerShell):  irm https://github.com/JuniorSua/yo-app/releases/latest/download/install.ps1 | iex
Linux (incl. WSL):     curl -fsSL https://github.com/JuniorSua/yo-app/releases/latest/download/install.sh | bash
```

## Files

| File | Release asset | What it is |
| --- | --- | --- |
| `compose.yaml` | `yo-app-compose.yaml` | The stack: `init` (makes the core volume writable by uid 1000, then exits), `yo-core` (published on `127.0.0.1:$YO_PORT` only, same port inside), `yo-computer` (not published). Header comment explains the limits. |
| `install.ps1` | `install.ps1` | Windows installer (PowerShell 5.1, ASCII only, safe under `irm \| iex`: no `exit`, all inside one function). |
| `install.sh` | `install.sh` | Linux installer (also Ubuntu on WSL; safe under `curl \| bash`: all inside `main`, prompts read `/dev/tty`). |
| `yo-app.ps1` | `yo-app.ps1` | Windows helper: `open`, `signin`, `status`, `start`, `stop`, `restart`, `update`, `logs`, `version`, `uninstall`, `help`. |
| `yo-app.cmd` | `yo-app.cmd` | The `yo-app` command on Windows (CRLF). Lives in `bin\`, the only folder put on the PATH: with `yo-app.ps1` on the PATH, PowerShell would pick the `.ps1` and refuse it under the default execution policy. |
| `yo-app` | `yo-app` | Linux helper, same commands and words as `yo-app.ps1`. |
| `yo.ico` | `yo.ico` | Shortcut icon, from `apps/desktop/build/icon.png`: 32-bit BMP entries 16 to 128 px (GDI+ and the tray read those) and a PNG 256 px entry. |

The release replaces `__YO_VERSION__` in every file (`sed`), so an installer fetches the files and images of its
own release. With the placeholder still in (a checkout), the installers use `YO_APP_VERSION`, `dev` with
`YO_APP_SOURCE`, or the latest release from the GitHub API.

## What gets installed

| | Windows | Linux |
| --- | --- | --- |
| Install folder | `%LOCALAPPDATA%\Yo`: `compose.yaml`, `.env`, `yo-app.ps1`, `yo.ico`, `bin\yo-app.cmd` | `~/.local/share/yo-app`: `compose.yaml`, `.env`, `yo-app` |
| Command | `bin\` added to the user PATH (registry, `REG_EXPAND_SZ`) | `~/.local/bin/yo-app` symlink |
| Shortcuts | "Yo" in the Start menu and on the desktop: `powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "<home>\yo-app.ps1" open --gui` | none (`yo-app open`) |
| `.env` privacy | ACL: the current user only, no inheritance | mode 600 (folder 700) |
| Data | Docker volumes `<project>_core-data`, `<project>_computer-data` | same |

`.env` keys: `YO_AGENTD_TOKEN` (64 hex, kept on reinstall and update), `YO_APP_PROJECT`, `YO_PORT` (7777, or the
next free port up to 7799), `YO_TZ` (IANA; Windows maps `TimeZoneInfo.Local.Id` with a table, else UTC),
`YO_COMPUTER_MEMORY` (`3g` below 16 GB of RAM, else `4500m`), `YO_CORE_IMAGE`, `YO_COMPUTER_IMAGE`, `YO_VERSION`,
and on Linux `YO_APP_LINK` (where the command's symlink is, for uninstall). Compose ignores the ones it doesn't use.

The helpers always run `docker compose --project-name <YO_APP_PROJECT> -f compose.yaml --env-file .env ...` from
the install folder with relative paths, so the stack is found from anywhere (and a Windows `docker` that is really
a shim into WSL works too).

Sign-in: `yo-app open` / `signin` write a fresh 64-hex token with
`docker compose exec -T yo-core sh -c 'umask 077 && cat > /data/enroll-token'` (token on stdin, never in a command
line) and open `http://127.0.0.1:<port>/#signin=<token>`. Core accepts it once, within 10 minutes
(`apps/core/src/auth/ControllerAuth.ts`). A browser that is already signed in ignores it. The link is never on a
command line either (other users can read those): the helper writes a page that forwards to it,
`<install folder>/yo-signin-<random>.html` (mode 600 / current user only), opens that file, and deletes it 20 s
later. The link is also printed in the terminal, for copying. Links use `127.0.0.1`, not `localhost`: Docker
publishes on `127.0.0.1` only, and a browser trying `::1` first could reach another local program there.

`update` asks the GitHub API for the latest release (or takes `YO_APP_VERSION`), only moves forward, downloads that
release's compose file and helper, sets the new image tags, pulls (putting `.env` and `compose.yaml` back if the
pull fails), then `up -d` and waits for `/healthz`. Backups of `.env`, `compose.yaml` and the helper (in `.update/`)
are kept until the new version answers; if `up` fails or `/healthz` doesn't answer within 3 minutes, it puts them
back, starts the old version again and says the update was rolled back (exit code 1). `uninstall` asks first, then
whether to delete the data (default No; Yes = `down --volumes`), removes only Yo's own `ghcr.io/juniorsua/*` images,
and deletes only the files it installed (above, plus leftover sign-in pages and `.update/`), then the folder if it
is empty: a custom `YO_APP_HOME` may hold other files.

## Overrides (tests and advanced use)

| Variable | Effect |
| --- | --- |
| `YO_APP_HOME` | Install folder |
| `YO_APP_BIN_DIR` | Linux: folder for the `yo-app` symlink (default `~/.local/bin`) |
| `YO_APP_PORT` | First port to try (default 7777; tries up to 7799) |
| `YO_APP_PROJECT` | Compose project name (default `yo-app`). Not `yo-app` on Windows: shortcuts are named "Yo (<project>)". |
| `YO_APP_VERSION` | Version to install or update to |
| `YO_APP_SOURCE` | A folder to copy the files from instead of downloading (this `pc/` folder works) |
| `YO_APP_RELEASES` | Release download base (default `https://github.com/JuniorSua/yo-app/releases/download`; `file://` works) |
| `YO_CORE_IMAGE`, `YO_COMPUTER_IMAGE` | Images instead of `ghcr.io/juniorsua/yo-core:<version>` and `yo-computer:<version>` |
| `YO_APP_SKIP_PULL=1` | Don't pull (local images) |
| `YO_APP_NO_BROWSER=1` | Print the sign-in link instead of opening it |
| `YO_APP_YES=1` | Answer yes to every question (including deleting data on uninstall) |
| `YO_APP_NO_SHORTCUTS=1` | Windows: no Start menu or desktop shortcuts |

## Testing locally

Use a spare project name and port so nothing touches a real install, and bring it down at the end.

Linux, with locally built images (`docker images yo-core`):

```bash
export YO_APP_SOURCE=$PWD/pc YO_APP_HOME=/tmp/yo-test/home YO_APP_BIN_DIR=/tmp/yo-test/bin \
  YO_APP_PROJECT=yo-app-test YO_APP_PORT=7799 YO_CORE_IMAGE=yo-core:<tag> YO_COMPUTER_IMAGE=yo-computer:<tag> \
  YO_APP_SKIP_PULL=1 YO_APP_NO_BROWSER=1 YO_APP_YES=1
bash pc/install.sh
/tmp/yo-test/bin/yo-app status        # also: signin, stop, start, restart, logs core, open
YO_APP_VERSION=0.0.2 /tmp/yo-test/bin/yo-app update   # with other local images in YO_*_IMAGE to see them swap
/tmp/yo-test/bin/yo-app uninstall     # YO_APP_YES=1 also deletes the data
```

To test the download path, bake a fake release: copy the files into `<dir>/v0.1.999/` with `__YO_VERSION__`
replaced (and `compose.yaml` named `yo-app-compose.yaml`), then run the baked `install.sh` with
`YO_APP_RELEASES=file://<dir>` and without `YO_APP_SOURCE`.

Windows without Docker Desktop, against Docker in WSL: put a test-only `docker.cmd` in a temp folder,

```bat
@wsl.exe -d Ubuntu-24.04 --cd "%CD%" --exec docker %*
```

prepend that folder to `PATH` for the test process only, copy `pc\` to a Windows folder and run `install.ps1`
with the same overrides (`YO_APP_HOME` under `%LOCALAPPDATA%\Temp`). WSL forwards `127.0.0.1:<port>` to Windows.
Then run `yo-app ...` in a new PowerShell (the default `Restricted` policy is fine: the command is the `.cmd`).
Checks: parse with
`[System.Management.Automation.Language.Parser]::ParseFile(...)` in Windows PowerShell 5.1, `bash -n` and
`shellcheck` for the bash files (the release job runs both on the baked files).
