# yo-app.ps1: start, stop, update and sign in to Yo (PC edition) on Windows. The Linux twin is pc/yo-app: same
# commands, same words. Installed by install.ps1 into %LOCALAPPDATA%\Yo; you run it as `yo-app <command>` through
# bin\yo-app.cmd (on your PATH), or through the "Yo" shortcut, which runs
#   powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File yo-app.ps1 open --gui
# (--gui: no console, so it reports progress in a notification and problems in a message box).
#
# Every Docker command runs from the install folder, with relative paths, as
#   docker compose --project-name <YO_APP_PROJECT> -f compose.yaml --env-file .env ...
# The project name and port live in .env. Windows PowerShell 5.1 compatible, ASCII only.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$YoHelperVersion = '__YO_VERSION__'
$Repo = 'JuniorSua/yo-app'
$Releases = if ($env:YO_APP_RELEASES) { $env:YO_APP_RELEASES } else { "https://github.com/$Repo/releases/download" }
$ApiLatest = "https://api.github.com/repos/$Repo/releases/latest"
$CoreRepo = 'ghcr.io/juniorsua/yo-core'
$ComputerRepo = 'ghcr.io/juniorsua/yo-computer'
$InstallCmd = "irm https://github.com/$Repo/releases/latest/download/install.ps1 | iex"
$PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

$AppHome = if ($env:YO_APP_HOME) { $env:YO_APP_HOME } else { $PSScriptRoot }
$EnvFile = Join-Path $AppHome '.env'
$Gui = $args -contains '--gui'
$CmdArgs = @($args | Where-Object { $_ -ne '--gui' })
$script:Notify = $null

# ------------------------------------------------------------------ output and prompts
function Say([string]$Text = '') { Write-Host $Text }

function Hide-Notice {
  if ($script:Notify) { try { $script:Notify.Visible = $false; $script:Notify.Dispose() } catch { } ; $script:Notify = $null }
}

# A tray notification, only when started from the shortcut (there's no console window to read).
function Show-Notice([string]$Text) {
  if (-not $Gui) { return }
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    if (-not $script:Notify) {
      $script:Notify = New-Object System.Windows.Forms.NotifyIcon
      $ico = Join-Path $AppHome 'yo.ico'
      if (Test-Path -LiteralPath $ico) { $script:Notify.Icon = New-Object System.Drawing.Icon($ico) }
      else { $script:Notify.Icon = [System.Drawing.SystemIcons]::Information }
      $script:Notify.Text = 'Yo'
      $script:Notify.Visible = $true
    }
    $script:Notify.ShowBalloonTip(15000, 'Yo', $Text, [System.Windows.Forms.ToolTipIcon]::Info)
  } catch { }
}

function Fail([string[]]$Lines) {
  Hide-Notice
  $text = $Lines -join "`r`n"
  if ($Gui) {
    try {
      Add-Type -AssemblyName System.Windows.Forms
      [void][System.Windows.Forms.MessageBox]::Show($text, 'Yo', 'OK', 'Warning')
    } catch { }
  }
  Write-Host ''
  foreach ($l in $Lines) { Write-Host $l }
  exit 1
}

# Ask "Question?" with a default; YO_APP_YES=1 answers yes; without a console, the default.
function Ask([string]$Question, [bool]$DefaultYes = $true) {
  $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
  if ($env:YO_APP_YES -eq '1') { Say "$Question $hint yes"; return $true }
  $interactive = $true
  try { if ([Console]::IsInputRedirected) { $interactive = $false } } catch { }
  if (-not $interactive -or $Gui) { return $DefaultYes }
  $ans = Read-Host "$Question $hint"
  if ($ans -match '^\s*[Yy]') { return $true }
  if ($ans -match '^\s*[Nn]') { return $false }
  return $DefaultYes
}

# ------------------------------------------------------------------ settings (.env)
function Get-EnvValue([string]$Key) {
  if (-not (Test-Path -LiteralPath $EnvFile)) { return '' }
  $value = ''
  foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
    if ($line.StartsWith("$Key=")) { $value = $line.Substring($Key.Length + 1).Trim() }
  }
  return $value
}

function Set-EnvValue([string]$Key, [string]$Value) {
  $lines = New-Object System.Collections.Generic.List[string]
  $done = $false
  if (Test-Path -LiteralPath $EnvFile) {
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
      if ($line.StartsWith("$Key=")) {
        if (-not $done) { $lines.Add("$Key=$Value"); $done = $true }
      } else { $lines.Add($line) }
    }
  }
  if (-not $done) { $lines.Add("$Key=$Value") }
  # UTF-8 without a BOM and LF endings: what Docker Compose reads best.
  [IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
}

function New-RandomHex {
  $bytes = New-Object byte[] 32
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  $rng.GetBytes($bytes)
  $rng.Dispose()
  return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
}

$Project = Get-EnvValue 'YO_APP_PROJECT'
if (-not $Project) { $Project = if ($env:YO_APP_PROJECT) { $env:YO_APP_PROJECT } else { 'yo-app' } }
$Port = Get-EnvValue 'YO_PORT'
if (-not $Port) { $Port = '7777' }

# ------------------------------------------------------------------ running Docker
# Native commands write progress to stderr; with 'Stop', Windows PowerShell 5.1 would turn that into errors.
function Invoke-Capture([string]$Exe, [string[]]$ArgList, [string]$InputText = $null) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($InputText) { $out = $InputText | & $Exe @ArgList 2>&1 | ForEach-Object { "$_" } }
    else { $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" } }
    $code = $LASTEXITCODE
  } catch { $out = @("$_"); $code = 1 }
  finally { $ErrorActionPreference = $prev }
  return [pscustomobject]@{ Code = $code; Out = (@($out) -join "`n") }
}

function Invoke-Shown([string]$Exe, [string[]]$ArgList) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host "$_" }
    $code = $LASTEXITCODE
  } catch { Write-Host "$_"; $code = 1 }
  finally { $ErrorActionPreference = $prev }
  return $code
}

function Get-ComposeArgs([string[]]$More) {
  return @('compose', '--project-name', $Project, '-f', 'compose.yaml', '--env-file', '.env') + $More
}

# Runs docker compose from the install folder. -Capture returns Code/Out; otherwise output is shown, the exit
# code returned.
function Invoke-Compose([string[]]$More, [switch]$Capture, [string]$InputText = $null) {
  Push-Location -LiteralPath $AppHome
  try {
    if ($Capture -or $InputText) { return Invoke-Capture 'docker' (Get-ComposeArgs $More) $InputText }
    return Invoke-Shown 'docker' (Get-ComposeArgs $More)
  } finally { Pop-Location }
}

function Get-DockerDesktopExe {
  $p = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path -LiteralPath $p) { return $p }
  return $null
}

function Find-DockerCli {
  if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
  $bin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
  if (Test-Path -LiteralPath (Join-Path $bin 'docker.exe')) { $env:Path = "$bin;$env:Path"; return $true }
  return $false
}

function Test-DockerRunning {
  $r = Invoke-Capture 'docker' @('info', '--format', '{{.ServerVersion}}')
  return ($r.Code -eq 0)
}

function Wait-Docker([int]$Seconds) {
  $start = Get-Date
  $next = 30
  Write-Host -NoNewline 'Waiting for Docker...'
  while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
    if (Test-DockerRunning) { Write-Host ' done.'; return $true }
    Start-Sleep -Seconds 5
    $elapsed = [int]((Get-Date) - $start).TotalSeconds
    if ($elapsed -ge $next) { Write-Host -NoNewline (" {0} min" -f [math]::Floor($elapsed / 60)); $next += 30 }
    else { Write-Host -NoNewline '.' }
  }
  Write-Host ''
  return $false
}

function Confirm-Docker {
  if (-not (Find-DockerCli)) {
    Fail @("Docker Desktop isn't installed, and Yo runs in it.", "Run the Yo installer again in PowerShell; it installs Docker Desktop for you:", "  $InstallCmd")
  }
  if (Test-DockerRunning) { return }
  $exe = Get-DockerDesktopExe
  if (-not $exe) {
    Fail @("Docker isn't running.", "Start Docker, wait until it's running, then try again.")
  }
  Say 'Starting Docker Desktop (it can take a minute or two)...'
  Show-Notice 'Starting Docker for Yo. Yo opens in your browser when it is ready (a minute or two).'
  Start-Process -FilePath $exe | Out-Null
  if (-not (Wait-Docker 600)) {
    Fail @("Docker Desktop didn't finish starting.", "Open Docker Desktop from the Start menu, wait until it says the engine is running, then try again.")
  }
}

function Confirm-Installed {
  if (-not ((Test-Path -LiteralPath (Join-Path $AppHome 'compose.yaml')) -and (Test-Path -LiteralPath $EnvFile))) {
    Fail @("Yo isn't installed in $AppHome (no compose.yaml or .env there).", "Install it in PowerShell with:  $InstallCmd")
  }
}

# ------------------------------------------------------------------ Yo's containers
function Get-ContainerId([string]$Service) {
  $r = Invoke-Compose @('ps', '-a', '-q', $Service) -Capture
  if ($r.Code -ne 0) { return '' }
  return (($r.Out -split "`n") | Where-Object { $_ -match '^[0-9a-f]{12,}$' } | Select-Object -First 1)
}

function Get-ServiceState([string]$Service) {
  $id = Get-ContainerId $Service
  if (-not $id) { return 'not created' }
  $r = Invoke-Capture 'docker' @('inspect', '-f', '{{.State.Status}}{{if and .State.Running .State.Health}} ({{.State.Health.Status}}){{end}}', $id)
  if ($r.Code -ne 0) { return 'unknown' }
  return $r.Out.Trim()
}

function Test-CoreRunning {
  $r = Invoke-Compose @('ps', '-q', '--status', 'running', 'yo-core') -Capture
  return ($r.Code -eq 0 -and $r.Out -match '[0-9a-f]{12}')
}

# Asks core directly, without any proxy the PC may be set to use.
function Test-Healthz {
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/healthz")
    $req.Proxy = $null
    $req.Timeout = 3000
    $resp = $req.GetResponse()
    $ok = ([int]$resp.StatusCode -eq 200)
    $resp.Close()
    return $ok
  } catch { return $false }
}

# $true once core answers (within 3 minutes); else shows core's last messages and returns $false.
function Wait-HealthyOrNot {
  Write-Host -NoNewline 'Waiting for Yo to start...'
  $start = Get-Date
  while (((Get-Date) - $start).TotalSeconds -lt 180) {
    if (Test-Healthz) { Write-Host ' done.'; return $true }
    Write-Host -NoNewline '.'
    Start-Sleep -Seconds 2
  }
  Write-Host ''
  Say "Yo's core didn't answer within 3 minutes. Its last messages:"
  $r = Invoke-Compose @('logs', '--tail', '30', 'yo-core') -Capture
  foreach ($l in ($r.Out -split "`n")) { Say "  $l" }
  return $false
}

function Wait-Healthy {
  if (-not (Wait-HealthyOrNot)) {
    Fail @("Yo didn't start. Try:  yo-app restart", "If it keeps happening, send the output of 'yo-app logs' with a bug report.")
  }
}

# docker compose up -d; returns its exit code.
function Invoke-Up {
  Say 'Starting Yo...'
  Show-Notice 'Starting Yo. It opens in your browser in a moment.'
  return (Invoke-Compose @('up', '-d'))
}

function Start-Stack {
  $code = Invoke-Up
  if ($code -ne 0) {
    Fail @("Docker couldn't start Yo (the messages above say why).", "If it mentions a port, another program is using port $Port`: close it, or run the installer again to pick a free port.")
  }
}

# A PowerShell string literal: 'text', with any ' doubled.
function ConvertTo-Literal([string]$Text) { return "'" + $Text.Replace("'", "''") + "'" }

# Runs PowerShell code in a hidden window after $Seconds, without waiting for it (also after this script ends).
function Start-Later([int]$Seconds, [string]$Code) {
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes("Start-Sleep -Seconds $Seconds; $Code"))
  try {
    Start-Process -FilePath $PowerShellExe -WindowStyle Hidden -ArgumentList @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc) | Out-Null
  } catch { }
}

# Writes a new file that only the current user can read, from the moment it exists (no inherited permissions).
function Write-PrivateFile([string]$Path, [byte[]]$Bytes) {
  $acl = New-Object System.Security.AccessControl.FileSecurity
  $acl.SetAccessRuleProtection($true, $false)
  $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')))
  $fs = [IO.File]::Create($Path, 4096, [IO.FileOptions]::None, $acl)
  try { $fs.Write($Bytes, 0, $Bytes.Length) } finally { $fs.Close() }
}

# Opens the sign-in link without putting its code on a command line (where other programs could read it): the
# browser opens a page in the install folder, readable by the current user only, that forwards it to the link.
# The page is deleted 20 seconds later. $true if a browser was asked to open it.
function Open-Signin([string]$Url) {
  if ($env:YO_APP_NO_BROWSER -eq '1') { return $false }
  $page = Join-Path $AppHome ('yo-signin-' + (New-RandomHex).Substring(0, 16) + '.html')
  $html = "<!doctype html>`n<html><head><meta charset=`"utf-8`"><meta name=`"referrer`" content=`"no-referrer`">`n" +
    "<meta http-equiv=`"refresh`" content=`"0;url=$Url`">`n<title>Yo</title><script>location.replace(`"$Url`")</script></head>`n" +
    "<body><a href=`"$Url`">Open Yo</a></body></html>`n"
  try { Write-PrivateFile $page ([Text.Encoding]::ASCII.GetBytes($html)) } catch { return $false }
  Start-Later 20 ('Remove-Item -LiteralPath ' + (ConvertTo-Literal $page) + ' -Force -ErrorAction SilentlyContinue')
  try { Start-Process -FilePath $page | Out-Null; return $true }
  catch { Remove-Item -LiteralPath $page -Force -ErrorAction SilentlyContinue; return $false }
}

# ------------------------------------------------------------------ commands
function Invoke-Signin {
  Confirm-Installed
  Confirm-Docker
  if (-not (Test-CoreRunning)) { Fail @("Yo isn't running. Start it with:  yo-app open") }
  if (-not (Test-Healthz)) { Wait-Healthy }
  $token = New-RandomHex
  $r = Invoke-Compose @('exec', '-T', 'yo-core', 'sh', '-c', 'umask 077 && cat > /data/enroll-token') -InputText $token
  if ($r.Code -ne 0) {
    if ($r.Out) { Say $r.Out }
    Fail @("Couldn't hand the sign-in code to Yo's core. Try:  yo-app restart")
  }
  $url = "http://127.0.0.1:$Port/#signin=$token"
  Say ''
  if (Open-Signin $url) { Say "Opening Yo in your browser. If it didn't open, use this sign-in link:" }
  else { Say 'Open this link in your browser to sign in:' }
  Say "  $url"
  Say "It works once, for 10 minutes. Run 'yo-app signin' for a new one."
}

function Invoke-Open {
  Confirm-Installed
  Confirm-Docker
  if (-not (Test-CoreRunning)) { Start-Stack }
  if (-not (Test-Healthz)) { Wait-Healthy }
  Invoke-Signin
}

function Invoke-Start {
  Confirm-Installed
  Confirm-Docker
  Start-Stack
  Wait-Healthy
  Say "Yo is running at http://127.0.0.1:$Port  ('yo-app open' signs this browser in)."
}

function Invoke-Stop {
  Confirm-Installed
  Confirm-Docker
  if ((Invoke-Compose @('stop')) -ne 0) { Fail @("Docker couldn't stop Yo (the messages above say why).") }
  Say "Yo is stopped. Your chats and files are kept. Start it again with:  yo-app start"
}

function Invoke-Restart {
  Confirm-Installed
  Confirm-Docker
  if (-not (Test-CoreRunning)) { Invoke-Start; return }
  if ((Invoke-Compose @('restart', 'yo-computer', 'yo-core')) -ne 0) { Fail @("Docker couldn't restart Yo (the messages above say why).") }
  Wait-Healthy
  Say "Yo restarted: http://127.0.0.1:$Port"
}

function Invoke-Status {
  Confirm-Installed
  $v = Get-EnvValue 'YO_VERSION'
  if (-not $v) { $v = 'unknown version' }
  Say "Yo (PC edition) $v"
  if ((Find-DockerCli) -and (Test-DockerRunning)) {
    Say '  Docker:          running'
    Say ("  Yo's core:       " + (Get-ServiceState 'yo-core'))
    Say ("  Yo's computer:   " + (Get-ServiceState 'yo-computer'))
    if (Test-Healthz) { Say "  Yo answers at:   http://127.0.0.1:$Port  (open it with: yo-app open)" }
    else { Say "  Yo answers at:   not answering on http://127.0.0.1:$Port  (start it with: yo-app start)" }
  } else {
    Say '  Docker:          not running (start Docker Desktop, or just run: yo-app open)'
  }
  Say "  Installed in:    $AppHome"
  Say "  Data:            Docker volumes ${Project}_core-data and ${Project}_computer-data"
}

function Test-Version([string]$V) { return ($V -match '^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.+-]*)?$') }

function Invoke-Version {
  Confirm-Installed
  Say ('Yo ' + (Get-EnvValue 'YO_VERSION'))
  Say ('  core:      ' + (Get-EnvValue 'YO_CORE_IMAGE'))
  Say ('  computer:  ' + (Get-EnvValue 'YO_COMPUTER_IMAGE'))
  if (Test-Version $YoHelperVersion) { Say "  helper:    $YoHelperVersion" } else { Say '  helper:    development copy' }
}

function Invoke-Logs([string[]]$Rest) {
  Confirm-Installed
  Confirm-Docker
  $svc = @()
  $follow = @()
  foreach ($a in $Rest) {
    switch ($a) {
      'core' { $svc += 'yo-core' }
      'computer' { $svc += 'yo-computer' }
      { $_ -eq '-f' -or $_ -eq '--follow' } { $follow = @('--follow') }
      default { Fail @("Unknown option '$a'. Use: yo-app logs [core|computer] [--follow]") }
    }
  }
  if ($svc.Count -eq 0) { $svc = @('yo-core', 'yo-computer') }
  [void](Invoke-Compose (@('logs', '--tail', '200') + $follow + $svc))
}

function Get-LatestVersion {
  try {
    $rel = Invoke-RestMethod -UseBasicParsing -Uri $ApiLatest -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 20
    return ([string]$rel.tag_name) -replace '^v', ''
  } catch { return '' }
}

# compose.yaml, the helper, its .cmd shim and the icon, from the release (or YO_APP_SOURCE) into $Dir.
function Get-Assets([string]$Version, [string]$Dir) {
  $map = [ordered]@{ 'compose.yaml' = 'yo-app-compose.yaml'; 'yo-app.ps1' = 'yo-app.ps1'; 'yo-app.cmd' = 'yo-app.cmd'; 'yo.ico' = 'yo.ico' }
  foreach ($name in $map.Keys) {
    $dest = Join-Path $Dir $name
    if ($env:YO_APP_SOURCE) {
      $src = Join-Path $env:YO_APP_SOURCE $map[$name]
      if (-not (Test-Path -LiteralPath $src)) { $src = Join-Path $env:YO_APP_SOURCE $name }
      Copy-Item -LiteralPath $src -Destination $dest -Force
    } else {
      Invoke-WebRequest -UseBasicParsing -Uri "$Releases/v$Version/$($map[$name])" -OutFile $dest -TimeoutSec 120
    }
  }
}

function Install-Assets([string]$Dir) {
  Move-Item -LiteralPath (Join-Path $Dir 'compose.yaml') -Destination (Join-Path $AppHome 'compose.yaml') -Force
  Move-Item -LiteralPath (Join-Path $Dir 'yo.ico') -Destination (Join-Path $AppHome 'yo.ico') -Force
  $bin = Join-Path $AppHome 'bin'
  if (-not (Test-Path -LiteralPath $bin)) { New-Item -ItemType Directory -Path $bin | Out-Null }
  Move-Item -LiteralPath (Join-Path $Dir 'yo-app.cmd') -Destination (Join-Path $bin 'yo-app.cmd') -Force
  # Windows PowerShell read this script whole when it started, so replacing it now is safe.
  Move-Item -LiteralPath (Join-Path $Dir 'yo-app.ps1') -Destination (Join-Path $AppHome 'yo-app.ps1') -Force
}

function Invoke-Update {
  Confirm-Installed
  Confirm-Docker
  $cur = Get-EnvValue 'YO_VERSION'
  $new = $env:YO_APP_VERSION
  if (-not $new) {
    $new = Get-LatestVersion
    if (-not $new) { Fail @("Couldn't ask GitHub for the newest version of Yo. Check this PC's internet connection and try again.") }
  }
  if (-not (Test-Version $new) -and -not $env:YO_APP_SOURCE) { Fail @("'$new' doesn't look like a Yo version (like 0.1.700).") }
  # Without YO_APP_VERSION, only ever move forward.
  $older = $false
  if (-not $env:YO_APP_VERSION -and (Test-Version $cur) -and (Test-Version $new)) {
    try { $older = ([version]($new -replace '[^0-9.].*$', '')) -lt ([version]($cur -replace '[^0-9.].*$', '')) } catch { }
  }
  if ($new -eq $cur -or $older) { Say "Yo is up to date ($cur)."; return }
  $shownCur = if ($cur) { $cur } else { 'an unknown version' }
  Say "Updating Yo from $shownCur to $new..."
  $stage = Join-Path $AppHome '.update'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  try { Get-Assets $new $stage } catch {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Fail @("Couldn't download Yo $new. Check this PC's internet connection and try again. Nothing was changed.")
  }
  # Backups of what this changes, kept until the new version answers.
  $bin = Join-Path $AppHome 'bin'
  $backups = [ordered]@{
    'env.backup' = $EnvFile; 'compose.backup' = (Join-Path $AppHome 'compose.yaml'); 'yo-app.ps1.backup' = (Join-Path $AppHome 'yo-app.ps1')
    'yo-app.cmd.backup' = (Join-Path $bin 'yo-app.cmd'); 'yo.ico.backup' = (Join-Path $AppHome 'yo.ico')
  }
  try {
    # The .env backup holds the secret too: private like .env.
    Write-PrivateFile (Join-Path $stage 'env.backup') ([IO.File]::ReadAllBytes($EnvFile))
    foreach ($b in @($backups.Keys | Where-Object { $_ -ne 'env.backup' })) {
      if (Test-Path -LiteralPath $backups[$b]) { Copy-Item -LiteralPath $backups[$b] -Destination (Join-Path $stage $b) -Force }
    }
  } catch {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Fail @("Couldn't make a backup of Yo's settings in $stage. Nothing was changed.")
  }
  # Write the old contents back (not a move or copy), so .env keeps its private permissions.
  $restoreSettings = {
    [IO.File]::WriteAllBytes($EnvFile, [IO.File]::ReadAllBytes((Join-Path $stage 'env.backup')))
    Copy-Item -LiteralPath (Join-Path $stage 'compose.backup') -Destination (Join-Path $AppHome 'compose.yaml') -Force
  }
  Copy-Item -LiteralPath (Join-Path $stage 'compose.yaml') -Destination (Join-Path $AppHome 'compose.yaml') -Force
  $coreImage = if ($env:YO_CORE_IMAGE) { $env:YO_CORE_IMAGE } else { "${CoreRepo}:$new" }
  $computerImage = if ($env:YO_COMPUTER_IMAGE) { $env:YO_COMPUTER_IMAGE } else { "${ComputerRepo}:$new" }
  Set-EnvValue 'YO_CORE_IMAGE' $coreImage
  Set-EnvValue 'YO_COMPUTER_IMAGE' $computerImage
  Set-EnvValue 'YO_VERSION' $new
  # From here .env decides: Compose would prefer these over it, also when putting the old version back.
  Remove-Item Env:YO_CORE_IMAGE, Env:YO_COMPUTER_IMAGE -ErrorAction SilentlyContinue
  if ($env:YO_APP_SKIP_PULL -ne '1') {
    Say 'Downloading Yo (about 1 GB the first time; later updates are smaller)...'
    if ((Invoke-Compose @('pull')) -ne 0) {
      & $restoreSettings
      Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
      Fail @("Couldn't download Yo $new (no internet, or the release isn't ready yet). Yo $cur keeps running; try again later.")
    }
  }
  Install-Assets $stage
  $shownOld = if ($cur) { $cur } else { 'as it was' }
  if (((Invoke-Up) -eq 0) -and (Wait-HealthyOrNot)) {
    Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
    Say "Yo updated: $(if ($cur) { $cur } else { '?' }) -> $new. Your browser picks it up when you reload the page."
    return
  }
  # The new version didn't start: put the old one back.
  Say ''
  Say "Yo $new didn't start, so this puts Yo $shownOld back..."
  & $restoreSettings
  # The helper, its .cmd (one line, so replacing it while it runs is safe) and the icon.
  foreach ($b in @('yo-app.ps1.backup', 'yo-app.cmd.backup', 'yo.ico.backup')) {
    $from = Join-Path $stage $b
    if (Test-Path -LiteralPath $from) { Copy-Item -LiteralPath $from -Destination $backups[$b] -Force -ErrorAction SilentlyContinue }
  }
  Remove-Item -LiteralPath $stage -Recurse -Force -ErrorAction SilentlyContinue
  if (((Invoke-Up) -eq 0) -and (Wait-HealthyOrNot)) {
    Fail @("The update was rolled back: Yo $shownOld is running again, with all your chats and files.", "Try 'yo-app update' again later. If it keeps failing, send the output of 'yo-app logs' with a bug report.")
  }
  Fail @("The update was rolled back to Yo $shownOld, but that didn't start either (the messages above say why).", 'Try:  yo-app restart', "If it keeps happening, send the output of 'yo-app logs' with a bug report.")
}

function Get-ShortcutName { if ($Project -eq 'yo-app') { return 'Yo' } return "Yo ($Project)" }

function Get-UserPath {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
  try { return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
  finally { $k.Close() }
}

function Set-UserPath([string]$Value) {
  $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)
  try { $k.SetValue('Path', $Value, [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $k.Close() }
  # Setting any user variable through .NET tells Explorer that the environment changed.
  [Environment]::SetEnvironmentVariable('YO_APP_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('YO_APP_REFRESH', $null, 'User')
}

function Remove-FromUserPath([string]$Dir) {
  $norm = $Dir.TrimEnd('\')
  $parts = @((Get-UserPath) -split ';' | Where-Object { $_ -and ($_.TrimEnd('\') -ne $norm) })
  Set-UserPath ($parts -join ';')
}

function Invoke-Uninstall {
  Confirm-Installed
  if (-not (Ask 'Remove Yo from this PC?' $false)) { Say 'Nothing was removed.'; return }
  $delete = Ask "Also delete Yo's data (chats, memories, the computer's files)? This can't be undone." $false
  Confirm-Docker
  $downArgs = @('down', '--remove-orphans')
  if ($delete) { $downArgs = @('down', '--volumes', '--remove-orphans') }
  if ((Invoke-Compose $downArgs) -ne 0) { Fail @("Docker couldn't remove Yo (the messages above say why). Nothing else was removed.") }
  # Only Yo's own published images; a custom or locally built image may be used by something else.
  foreach ($img in @((Get-EnvValue 'YO_CORE_IMAGE'), (Get-EnvValue 'YO_COMPUTER_IMAGE'))) {
    if ($img.StartsWith("${CoreRepo}:") -or $img.StartsWith("${ComputerRepo}:")) {
      $r = Invoke-Capture 'docker' @('image', 'rm', $img)
      if ($r.Code -eq 0) { Say "Removed $img" }
    }
  }
  # Shortcuts that point at this install.
  $name = Get-ShortcutName
  $shell = New-Object -ComObject WScript.Shell
  foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    $lnk = Join-Path $folder "$name.lnk"
    if (Test-Path -LiteralPath $lnk) {
      $s = $shell.CreateShortcut($lnk)
      if ($s.Arguments.IndexOf($AppHome, [StringComparison]::OrdinalIgnoreCase) -ge 0) { Remove-Item -LiteralPath $lnk -Force; Say "Removed the shortcut $lnk" }
    }
  }
  Remove-FromUserPath (Join-Path $AppHome 'bin')
  $volumes = "${Project}_core-data ${Project}_computer-data"
  Set-Location -LiteralPath $env:TEMP
  # Only the files Yo put there (the folder may be one the user chose, with their own files in it).
  foreach ($f in @('compose.yaml', '.env', 'yo-app.ps1', 'yo.ico')) {
    Remove-Item -LiteralPath (Join-Path $AppHome $f) -Force -ErrorAction SilentlyContinue
  }
  Get-ChildItem -LiteralPath $AppHome -Force -Filter 'yo-signin-*.html' -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  foreach ($d in @('.update', '.install')) {
    $p = Join-Path $AppHome $d
    if (Test-Path -LiteralPath $p) { Remove-Item -LiteralPath $p -Recurse -Force -ErrorAction SilentlyContinue }
  }
  # bin\yo-app.cmd is still running (it waits for this script, then exits): it goes a few seconds after this
  # script ends, then bin and the install folder, each only if that left it empty.
  $bin = Join-Path $AppHome 'bin'
  Start-Later 4 ('$c = ' + (ConvertTo-Literal (Join-Path $bin 'yo-app.cmd')) + '; Remove-Item -LiteralPath $c -Force -ErrorAction SilentlyContinue; ' +
    'foreach ($d in @(' + (ConvertTo-Literal $bin) + ', ' + (ConvertTo-Literal $AppHome) + ')) { ' +
    'if ((Test-Path -LiteralPath $d) -and -not (Get-ChildItem -LiteralPath $d -Force)) { Remove-Item -LiteralPath $d -Force -ErrorAction SilentlyContinue } }')
  $others = @(Get-ChildItem -LiteralPath $AppHome -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'bin' })
  if (Test-Path -LiteralPath $bin) { $others += @(Get-ChildItem -LiteralPath $bin -Force | Where-Object { $_.Name -ne 'yo-app.cmd' }) }
  Say ''
  if ($others.Count -gt 0) { Say "Yo is removed from this PC. (Its folder $AppHome has other files in it, so it stays.)" }
  else { Say 'Yo is removed from this PC.' }
  if ($delete) { Say 'Its data is deleted too.' }
  else {
    Say "Your data is kept in Docker (volumes ${Project}_core-data and ${Project}_computer-data): installing Yo again picks it up."
    Say "To delete it later:  docker volume rm $volumes"
  }
}

function Show-Help {
  Say "yo-app: run Yo (PC edition) on this PC. Yo lives at http://127.0.0.1:$Port."
  Say ''
  Say '  yo-app open        start Yo if needed and open it in your browser (signs this browser in)'
  Say '  yo-app signin      a new one-time sign-in link (for another browser, or if you were signed out)'
  Say '  yo-app status      is Docker running, are Yo''s core and computer up, which version'
  Say '  yo-app start       start Yo in the background'
  Say '  yo-app stop        stop Yo (it stays stopped until ''yo-app start'', even after a restart)'
  Say '  yo-app restart     restart Yo''s core and its computer'
  Say '  yo-app update      get the newest version of Yo (your data stays)'
  Say '  yo-app logs [core|computer] [--follow]'
  Say '                     Yo''s recent messages, for bug reports'
  Say '  yo-app version     which version is installed'
  Say '  yo-app uninstall   remove Yo (asks before deleting your data)'
  Say '  yo-app help        this list'
}

$command = if ($CmdArgs.Count -gt 0) { [string]$CmdArgs[0] } else { 'help' }
$rest = @()
if ($CmdArgs.Count -gt 1) { $rest = @($CmdArgs[1..($CmdArgs.Count - 1)]) }
switch ($command) {
  'open' { Invoke-Open }
  { $_ -eq 'signin' -or $_ -eq 'sign-in' } { Invoke-Signin }
  'status' { Invoke-Status }
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { Invoke-Restart }
  'update' { Invoke-Update }
  'logs' { Invoke-Logs $rest }
  { $_ -eq 'version' -or $_ -eq '--version' -or $_ -eq '-v' } { Invoke-Version }
  'uninstall' { Invoke-Uninstall }
  { $_ -eq 'help' -or $_ -eq '--help' -or $_ -eq '-h' } { Show-Help }
  default { Say "Unknown command '$command'."; Show-Help; Hide-Notice; exit 2 }
}
Hide-Notice
exit 0
