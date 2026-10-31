# Installs Yo (PC edition) on Windows 10 22H2 / Windows 11. In PowerShell:
#   irm https://github.com/JuniorSua/yo-app/releases/latest/download/install.ps1 | iex
#
# Checks this PC (64-bit, Windows version, memory, processor, disk, Docker), offers to install Docker Desktop with
# winget, downloads Yo's compose.yaml, the yo-app helper and the icon from the release this script came with into
# %LOCALAPPDATA%\Yo, writes a private .env, downloads the images, adds the yo-app command (bin\yo-app.cmd on the
# user PATH) and "Yo" shortcuts (Start menu and desktop), starts Yo and opens it in the browser with a one-time
# sign-in link. Running it again repairs or updates Yo and keeps its data, secret and sign-ins.
#
# Windows PowerShell 5.1 compatible and ASCII only (irm | iex and PowerShell 5.1 read files as ANSI). Everything
# runs inside one function: no `exit` (it would close the user's window under iex), nothing left in their session
# except that function and, for the current window, the yo-app command on PATH.
# The release workflow bakes its version into $BakedVersion below. Overrides (tests, advanced):
#   YO_APP_HOME  YO_APP_PORT  YO_APP_PROJECT  YO_APP_VERSION  YO_APP_SOURCE (a folder with the assets instead of
#   downloading them)  YO_APP_RELEASES  YO_CORE_IMAGE  YO_COMPUTER_IMAGE  YO_APP_SKIP_PULL=1  YO_APP_NO_BROWSER=1
#   YO_APP_YES=1  YO_APP_NO_SHORTCUTS=1        (pc/README.md)

function Install-YoApp {
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }

  $BakedVersion = '__YO_VERSION__'
  $Repo = 'JuniorSua/yo-app'
  $Releases = if ($env:YO_APP_RELEASES) { $env:YO_APP_RELEASES } else { "https://github.com/$Repo/releases/download" }
  $ApiLatest = "https://api.github.com/repos/$Repo/releases/latest"
  $CoreRepo = 'ghcr.io/juniorsua/yo-core'
  $ComputerRepo = 'ghcr.io/juniorsua/yo-computer'
  $InstallCmd = "irm https://github.com/$Repo/releases/latest/download/install.ps1 | iex"
  $PowerShellExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

  # ---------------------------------------------------------------- small helpers
  function Say([string]$Text = '') { Write-Host $Text }
  function Pass([string]$Text) { Write-Host "  OK     $Text" }
  function Note([string]$Text) { Write-Host "  NOTE   $Text" }
  function Block([string]$Text) { Write-Host "  STOP   $Text"; $state.Blocked = $true }
  # Stops the installer with a plain message (caught at the bottom of this file).
  function Stop-Install([string[]]$Lines) { throw ('YO: ' + ($Lines -join "`r`n")) }
  function Ask([string]$Question, [bool]$DefaultYes = $true) {
    $hint = if ($DefaultYes) { '[Y/n]' } else { '[y/N]' }
    if ($env:YO_APP_YES -eq '1') { Say "$Question $hint yes"; return $true }
    $interactive = $true
    try { if ([Console]::IsInputRedirected) { $interactive = $false } } catch { }
    if (-not $interactive) { return $DefaultYes }
    $ans = Read-Host "$Question $hint"
    if ($ans -match '^\s*[Yy]') { return $true }
    if ($ans -match '^\s*[Nn]') { return $false }
    return $DefaultYes
  }
  function Test-Version([string]$V) { return ($V -match '^[0-9]+\.[0-9]+\.[0-9]+([.+-][0-9A-Za-z.+-]*)?$') }
  # Native commands write progress to stderr; with 'Stop', PowerShell 5.1 would turn that into errors.
  function Invoke-Capture([string]$Exe, [string[]]$ArgList) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $out = & $Exe @ArgList 2>&1 | ForEach-Object { "$_" }; $code = $LASTEXITCODE }
    catch { $out = @("$_"); $code = 1 }
    finally { $ErrorActionPreference = $prev }
    return [pscustomobject]@{ Code = $code; Out = (@($out) -join "`n") }
  }
  function Invoke-Shown([string]$Exe, [string[]]$ArgList) {
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $Exe @ArgList 2>&1 | ForEach-Object { Write-Host "$_" }; $code = $LASTEXITCODE }
    catch { Write-Host "$_"; $code = 1 }
    finally { $ErrorActionPreference = $prev }
    return $code
  }
  function Get-DockerDesktopExe {
    $p = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
    if (Test-Path -LiteralPath $p) { return $p }
    return $null
  }
  function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = (@($env:Path, $machine, $user) | Where-Object { $_ }) -join ';'
  }
  function Find-DockerCli {
    if (Get-Command docker -ErrorAction SilentlyContinue) { return $true }
    $bin = Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'
    if (Test-Path -LiteralPath (Join-Path $bin 'docker.exe')) { $env:Path = "$bin;$env:Path"; return $true }
    return $false
  }
  function Test-DockerRunning { return ((Invoke-Capture 'docker' @('info', '--format', '{{.ServerVersion}}')).Code -eq 0) }
  function Wait-Docker([int]$Seconds) {
    $start = Get-Date
    $next = 30
    Write-Host -NoNewline 'Waiting for Docker...'
    while (((Get-Date) - $start).TotalSeconds -lt $Seconds) {
      if (Test-DockerRunning) { Write-Host ' done.'; return $true }
      Start-Sleep -Seconds 5
      $elapsed = [int]((Get-Date) - $start).TotalSeconds
      if ($elapsed -ge $next) { Write-Host -NoNewline (' {0} min' -f [math]::Floor($elapsed / 60)); $next += 30 }
      else { Write-Host -NoNewline '.' }
    }
    Write-Host ''
    return $false
  }
  function Test-PortFree([int]$P) {
    $client = New-Object Net.Sockets.TcpClient
    try {
      $iar = $client.BeginConnect('127.0.0.1', $P, $null, $null)
      if ($iar.AsyncWaitHandle.WaitOne(300) -and $client.Connected) { return $false }
    } catch { } finally { $client.Close() }
    $listener = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $P)
    try { $listener.Start(); $listener.Stop(); return $true } catch { return $false }
  }
  function New-RandomHex {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    $rng.Dispose()
    return (($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
  }
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
    foreach ($line in [IO.File]::ReadAllLines($EnvFile)) {
      if ($line.StartsWith("$Key=")) {
        if (-not $done) { $lines.Add("$Key=$Value"); $done = $true }
      } else { $lines.Add($line) }
    }
    if (-not $done) { $lines.Add("$Key=$Value") }
    [IO.File]::WriteAllText($EnvFile, (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding($false)))
  }
  # Only the current user can read the file (it holds the secret between Yo's core and its computer).
  function Protect-File([string]$Path) {
    try {
      $acl = New-Object System.Security.AccessControl.FileSecurity
      $acl.SetAccessRuleProtection($true, $false)
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
      $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($me, 'FullControl', 'Allow')
      $acl.AddAccessRule($rule)
      [IO.File]::SetAccessControl($Path, $acl)
      return $true
    } catch { return $false }
  }
  function Get-UserPath {
    $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
    try { return [string]$k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames) }
    finally { $k.Close() }
  }
  function Add-ToUserPath([string]$Dir) {
    $norm = $Dir.TrimEnd('\')
    $current = Get-UserPath
    $parts = @($current -split ';' | Where-Object { $_ })
    if (-not ($parts | Where-Object { $_.TrimEnd('\') -eq $norm })) {
      $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
      try { $k.SetValue('Path', ((@($parts) + $Dir) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString) } finally { $k.Close() }
      # Setting any user variable through .NET tells Explorer the environment changed (new windows see it).
      [Environment]::SetEnvironmentVariable('YO_APP_REFRESH', '1', 'User')
      [Environment]::SetEnvironmentVariable('YO_APP_REFRESH', $null, 'User')
    }
    if (-not (@($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -eq $norm })) { $env:Path = "$env:Path;$Dir" }
  }
  function Get-IanaTimeZone {
    $map = @{
      'Dateline Standard Time' = 'Etc/GMT+12'; 'UTC-11' = 'Etc/GMT+11'; 'Aleutian Standard Time' = 'America/Adak'
      'Hawaiian Standard Time' = 'Pacific/Honolulu'; 'Marquesas Standard Time' = 'Pacific/Marquesas'
      'Alaskan Standard Time' = 'America/Anchorage'; 'UTC-09' = 'Etc/GMT+9'; 'UTC-08' = 'Etc/GMT+8'
      'Pacific Standard Time (Mexico)' = 'America/Tijuana'; 'Pacific Standard Time' = 'America/Los_Angeles'
      'US Mountain Standard Time' = 'America/Phoenix'; 'Mountain Standard Time (Mexico)' = 'America/Mazatlan'
      'Mountain Standard Time' = 'America/Denver'; 'Yukon Standard Time' = 'America/Whitehorse'
      'Central America Standard Time' = 'America/Guatemala'; 'Central Standard Time' = 'America/Chicago'
      'Easter Island Standard Time' = 'Pacific/Easter'; 'Central Standard Time (Mexico)' = 'America/Mexico_City'
      'Canada Central Standard Time' = 'America/Regina'; 'SA Pacific Standard Time' = 'America/Bogota'
      'Eastern Standard Time (Mexico)' = 'America/Cancun'; 'Eastern Standard Time' = 'America/New_York'
      'Haiti Standard Time' = 'America/Port-au-Prince'; 'Cuba Standard Time' = 'America/Havana'
      'US Eastern Standard Time' = 'America/Indiana/Indianapolis'; 'Turks And Caicos Standard Time' = 'America/Grand_Turk'
      'Paraguay Standard Time' = 'America/Asuncion'; 'Atlantic Standard Time' = 'America/Halifax'
      'Venezuela Standard Time' = 'America/Caracas'; 'Central Brazilian Standard Time' = 'America/Cuiaba'
      'SA Western Standard Time' = 'America/La_Paz'; 'Pacific SA Standard Time' = 'America/Santiago'
      'Newfoundland Standard Time' = 'America/St_Johns'; 'Tocantins Standard Time' = 'America/Araguaina'
      'E. South America Standard Time' = 'America/Sao_Paulo'; 'SA Eastern Standard Time' = 'America/Cayenne'
      'Argentina Standard Time' = 'America/Argentina/Buenos_Aires'; 'Greenland Standard Time' = 'America/Nuuk'
      'Montevideo Standard Time' = 'America/Montevideo'; 'Magallanes Standard Time' = 'America/Punta_Arenas'
      'Saint Pierre Standard Time' = 'America/Miquelon'; 'Bahia Standard Time' = 'America/Bahia'
      'UTC-02' = 'Etc/GMT+2'; 'Azores Standard Time' = 'Atlantic/Azores'; 'Cape Verde Standard Time' = 'Atlantic/Cape_Verde'
      'UTC' = 'Etc/UTC'; 'GMT Standard Time' = 'Europe/London'; 'Greenwich Standard Time' = 'Atlantic/Reykjavik'
      'Sao Tome Standard Time' = 'Africa/Sao_Tome'; 'Morocco Standard Time' = 'Africa/Casablanca'
      'W. Europe Standard Time' = 'Europe/Berlin'; 'Central Europe Standard Time' = 'Europe/Budapest'
      'Romance Standard Time' = 'Europe/Paris'; 'Central European Standard Time' = 'Europe/Warsaw'
      'W. Central Africa Standard Time' = 'Africa/Lagos'; 'Jordan Standard Time' = 'Asia/Amman'
      'GTB Standard Time' = 'Europe/Bucharest'; 'Middle East Standard Time' = 'Asia/Beirut'
      'Egypt Standard Time' = 'Africa/Cairo'; 'E. Europe Standard Time' = 'Europe/Chisinau'
      'Syria Standard Time' = 'Asia/Damascus'; 'West Bank Standard Time' = 'Asia/Hebron'
      'South Africa Standard Time' = 'Africa/Johannesburg'; 'FLE Standard Time' = 'Europe/Kiev'
      'Israel Standard Time' = 'Asia/Jerusalem'; 'South Sudan Standard Time' = 'Africa/Juba'
      'Kaliningrad Standard Time' = 'Europe/Kaliningrad'; 'Sudan Standard Time' = 'Africa/Khartoum'
      'Libya Standard Time' = 'Africa/Tripoli'; 'Namibia Standard Time' = 'Africa/Windhoek'
      'Arabic Standard Time' = 'Asia/Baghdad'; 'Turkey Standard Time' = 'Europe/Istanbul'
      'Arab Standard Time' = 'Asia/Riyadh'; 'Belarus Standard Time' = 'Europe/Minsk'
      'Russian Standard Time' = 'Europe/Moscow'; 'E. Africa Standard Time' = 'Africa/Nairobi'
      'Volgograd Standard Time' = 'Europe/Volgograd'; 'Iran Standard Time' = 'Asia/Tehran'
      'Arabian Standard Time' = 'Asia/Dubai'; 'Astrakhan Standard Time' = 'Europe/Astrakhan'
      'Azerbaijan Standard Time' = 'Asia/Baku'; 'Russia Time Zone 3' = 'Europe/Samara'
      'Mauritius Standard Time' = 'Indian/Mauritius'; 'Saratov Standard Time' = 'Europe/Saratov'
      'Georgian Standard Time' = 'Asia/Tbilisi'; 'Caucasus Standard Time' = 'Asia/Yerevan'
      'Afghanistan Standard Time' = 'Asia/Kabul'; 'West Asia Standard Time' = 'Asia/Tashkent'
      'Ekaterinburg Standard Time' = 'Asia/Yekaterinburg'; 'Pakistan Standard Time' = 'Asia/Karachi'
      'Qyzylorda Standard Time' = 'Asia/Qyzylorda'; 'India Standard Time' = 'Asia/Kolkata'
      'Sri Lanka Standard Time' = 'Asia/Colombo'; 'Nepal Standard Time' = 'Asia/Kathmandu'
      'Central Asia Standard Time' = 'Asia/Almaty'; 'Bangladesh Standard Time' = 'Asia/Dhaka'
      'Omsk Standard Time' = 'Asia/Omsk'; 'Myanmar Standard Time' = 'Asia/Yangon'
      'SE Asia Standard Time' = 'Asia/Bangkok'; 'Altai Standard Time' = 'Asia/Barnaul'
      'W. Mongolia Standard Time' = 'Asia/Hovd'; 'North Asia Standard Time' = 'Asia/Krasnoyarsk'
      'N. Central Asia Standard Time' = 'Asia/Novosibirsk'; 'Tomsk Standard Time' = 'Asia/Tomsk'
      'China Standard Time' = 'Asia/Shanghai'; 'North Asia East Standard Time' = 'Asia/Irkutsk'
      'Singapore Standard Time' = 'Asia/Singapore'; 'W. Australia Standard Time' = 'Australia/Perth'
      'Taipei Standard Time' = 'Asia/Taipei'; 'Ulaanbaatar Standard Time' = 'Asia/Ulaanbaatar'
      'Aus Central W. Standard Time' = 'Australia/Eucla'; 'Transbaikal Standard Time' = 'Asia/Chita'
      'Tokyo Standard Time' = 'Asia/Tokyo'; 'North Korea Standard Time' = 'Asia/Pyongyang'
      'Korea Standard Time' = 'Asia/Seoul'; 'Yakutsk Standard Time' = 'Asia/Yakutsk'
      'Cen. Australia Standard Time' = 'Australia/Adelaide'; 'AUS Central Standard Time' = 'Australia/Darwin'
      'E. Australia Standard Time' = 'Australia/Brisbane'; 'AUS Eastern Standard Time' = 'Australia/Sydney'
      'West Pacific Standard Time' = 'Pacific/Port_Moresby'; 'Tasmania Standard Time' = 'Australia/Hobart'
      'Vladivostok Standard Time' = 'Asia/Vladivostok'; 'Lord Howe Standard Time' = 'Australia/Lord_Howe'
      'Bougainville Standard Time' = 'Pacific/Bougainville'; 'Russia Time Zone 10' = 'Asia/Srednekolymsk'
      'Magadan Standard Time' = 'Asia/Magadan'; 'Norfolk Standard Time' = 'Pacific/Norfolk'
      'Sakhalin Standard Time' = 'Asia/Sakhalin'; 'Central Pacific Standard Time' = 'Pacific/Guadalcanal'
      'Russia Time Zone 11' = 'Asia/Kamchatka'; 'New Zealand Standard Time' = 'Pacific/Auckland'
      'UTC+12' = 'Etc/GMT-12'; 'Fiji Standard Time' = 'Pacific/Fiji'; 'Chatham Islands Standard Time' = 'Pacific/Chatham'
      'UTC+13' = 'Etc/GMT-13'; 'Tonga Standard Time' = 'Pacific/Tongatapu'; 'Samoa Standard Time' = 'Pacific/Apia'
      'Line Islands Standard Time' = 'Pacific/Kiritimati'
    }
    $id = ''
    try { $id = [TimeZoneInfo]::Local.Id } catch { }
    if ($id -and $map.ContainsKey($id)) { return [pscustomobject]@{ Id = $id; Iana = $map[$id] } }
    return [pscustomobject]@{ Id = $id; Iana = '' }
  }

  # ---------------------------------------------------------------- where and what
  $state = @{ Blocked = $false }
  $AppHome = if ($env:YO_APP_HOME) { $env:YO_APP_HOME } else { Join-Path $env:LOCALAPPDATA 'Yo' }
  $EnvFile = Join-Path $AppHome '.env'
  $existing = Test-Path -LiteralPath $EnvFile

  Say ''
  Say 'Yo for Windows: installing Yo (PC edition)'
  Say '==========================================='
  if ($existing) { Say "Yo is already installed in $AppHome. This repairs or updates it; your chats, files and sign-ins stay." }

  $Version = $env:YO_APP_VERSION
  if (-not $Version -and (Test-Version $BakedVersion)) { $Version = $BakedVersion }
  if (-not $Version -and $env:YO_APP_SOURCE) { $Version = 'dev' }
  if (-not $Version) {
    try {
      $rel = Invoke-RestMethod -UseBasicParsing -Uri $ApiLatest -Headers @{ Accept = 'application/vnd.github+json' } -TimeoutSec 20
      $Version = ([string]$rel.tag_name) -replace '^v', ''
    } catch { }
    if (-not $Version) { Stop-Install @("Couldn't ask GitHub for the newest version of Yo. Check this PC's internet connection and run the installer again.") }
    if (-not (Test-Version $Version)) {
      Stop-Install @("GitHub's answer about the newest version of Yo doesn't look like a version number, so nothing was installed.", "Try again in a few minutes; if it keeps happening, report it at https://github.com/$Repo/issues")
    }
  }
  # The version goes into download addresses and image names: the same check as 'yo-app update'.
  if (-not (Test-Version $Version) -and -not $env:YO_APP_SOURCE) { Stop-Install @("'$Version' doesn't look like a Yo version (like 0.1.700).") }
  Say "Version: $Version"

  # ---------------------------------------------------------------- this PC
  Say ''
  Say 'Checking this PC:'
  $dockerAlready = (Find-DockerCli) -and (Test-DockerRunning)
  $arch = $env:PROCESSOR_ARCHITEW6432
  if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
  if (-not [Environment]::Is64BitOperatingSystem) { Block 'Yo needs 64-bit Windows; this is 32-bit Windows.' }
  elseif ($arch -eq 'AMD64') { Pass '64-bit processor (Intel/AMD)' }
  elseif ($arch -eq 'ARM64') { Pass '64-bit processor (ARM)' }
  else { Block "Yo needs a 64-bit Intel/AMD or ARM processor; this one is '$arch'." }

  $os = Get-CimInstance Win32_OperatingSystem
  $build = [int]$os.BuildNumber
  $caption = ([string]$os.Caption) -replace '^Microsoft\s+', ''
  if ($build -ge 22000) { Pass "$caption (build $build)" }
  elseif ($build -ge 19045) { Pass "$caption 22H2 (build $build)" }
  elseif ($dockerAlready) { Note "$caption (build $build) is older than Windows 10 22H2, but Docker already runs here, so Yo can too." }
  else { Block "Docker Desktop needs Windows 10 version 22H2 or Windows 11; this PC has $caption (build $build). Update Windows (Settings > Windows Update), then run this again." }

  $cs = Get-CimInstance Win32_ComputerSystem
  $memGB = [math]::Round(([double]$cs.TotalPhysicalMemory) / 1GB, 0)
  $memoryLimit = '4500m'
  # A "16 GB" PC reports a little less than 16 GB.
  if ([double]$cs.TotalPhysicalMemory -lt 7GB) { Block "Yo needs at least 8 GB of memory (RAM); this PC has about $memGB GB." }
  elseif ([double]$cs.TotalPhysicalMemory -lt 14.5GB) {
    Note "Memory: about $memGB GB. Yo works, but 16 GB is recommended; its computer gets 3 GB instead of 4.5 GB."
    $memoryLimit = '3g'
  } else { Pass "Memory: about $memGB GB" }

  $cores = [int]$cs.NumberOfLogicalProcessors
  if ($cores -lt 1) { $cores = [Environment]::ProcessorCount }
  if ($cores -lt 2) { Block "Yo needs at least 2 processor cores; this PC has $cores." }
  elseif ($cores -lt 4) { Note "Processor: $cores cores. Yo works, but 4 or more are recommended (it may feel slow while it works)." }
  else { Pass "Processor: $cores cores" }

  if (-not $dockerAlready) {
    try {
      $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
      if (-not $cs.HypervisorPresent -and $cpu.VirtualizationFirmwareEnabled -eq $false) {
        Note "Virtualization looks switched off in this PC's firmware (BIOS/UEFI). Docker Desktop needs it: if Docker says so, turn on 'Intel VT-x' or 'AMD-V/SVM' in the BIOS settings."
      }
    } catch { }
  }
  if ($state.Blocked) { Stop-Install @("Yo can't be installed on this PC yet: see the STOP lines above.") }

  # ---------------------------------------------------------------- Docker
  if (-not (Find-DockerCli)) {
    $desktop = Get-DockerDesktopExe
    if (-not $desktop) {
      Say ''
      Say 'Yo runs in Docker Desktop, a free app (for personal use and small businesses) that runs Linux'
      Say "containers on Windows. It isn't installed yet."
      if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
        Stop-Install @('Install Docker Desktop from https://www.docker.com/products/docker-desktop/ , open it once, then run the same command again:', "  $InstallCmd")
      }
      if (-not (Ask 'Install Docker Desktop now? Windows asks for permission (about 600 MB).' $true)) {
        Stop-Install @('Install Docker Desktop (https://www.docker.com/products/docker-desktop/), then run the same command again:', "  $InstallCmd")
      }
      [void](Invoke-Shown 'winget' @('install', '-e', '--id', 'Docker.DockerDesktop', '--accept-package-agreements', '--accept-source-agreements'))
      Update-SessionPath
      if (-not (Get-DockerDesktopExe)) {
        Stop-Install @("Docker Desktop didn't install (the messages above say why).", "Install it from https://www.docker.com/products/docker-desktop/ , then run the same command again:", "  $InstallCmd")
      }
      Say ''
      Say 'Docker Desktop is installed. If Windows asks you to restart (or to sign out and back in), do that, then run'
      Say "the same command again; it continues where it stopped:  $InstallCmd"
    }
    if (-not (Find-DockerCli)) { Update-SessionPath; [void](Find-DockerCli) }
  }
  if (-not (Test-DockerRunning)) {
    $desktop = Get-DockerDesktopExe
    if (-not $desktop) {
      Stop-Install @("Docker isn't running. Start it, wait until it's running, then run the same command again:", "  $InstallCmd")
    }
    Say ''
    Say 'Starting Docker Desktop. The first time:'
    Say '  - it shows its terms: click Accept (you can skip signing in to Docker);'
    Say "  - if it says WSL needs an update, follow what it says;"
    Say '  - if it asks to restart Windows, restart, then run the same command again.'
    Start-Process -FilePath $desktop | Out-Null
    if (-not (Wait-Docker 600)) {
      Stop-Install @("Docker Desktop didn't finish starting within 10 minutes.", "Open Docker Desktop from the Start menu, wait until it says the engine is running, then run the same command again:", "  $InstallCmd")
    }
  }
  Pass ('Docker ' + (Invoke-Capture 'docker' @('info', '--format', '{{.ServerVersion}}')).Out.Trim() + ' is running')
  if ((Invoke-Capture 'docker' @('info', '--format', '{{.OSType}}')).Out.Trim() -ne 'linux') {
    Stop-Install @('Docker Desktop is set to Windows containers. Right-click its whale icon (bottom right) > Switch to Linux containers, then run the same command again.')
  }
  $cv = (Invoke-Capture 'docker' @('compose', 'version', '--short')).Out.Trim() -replace '^v', ''
  $major = 0
  if ($cv -match '^([0-9]+)\.') { $major = [int]$matches[1] }
  if ($major -ge 2) { Pass "Docker Compose $cv" }
  else { Block "Yo needs Docker Compose version 2 or newer (the 'docker compose' command). Update Docker Desktop." }

  # Docker Desktop keeps its data under %LOCALAPPDATA%\Docker by default.
  try {
    $drive = New-Object IO.DriveInfo([IO.Path]::GetPathRoot($env:LOCALAPPDATA))
    $freeGB = [math]::Round($drive.AvailableFreeSpace / 1GB, 0)
    if ($drive.AvailableFreeSpace -lt 15GB) {
      if ($existing) { Note "Free disk space on $($drive.Name): about $freeGB GB. Yo is already installed, so this goes on, but keep 15 GB free." }
      else { Block "Yo needs about 15 GB of free disk space on $($drive.Name) (where Docker keeps its data); there are about $freeGB GB." }
    } else { Pass "Free disk space on $($drive.Name): about $freeGB GB" }
  } catch { Note "Couldn't check free disk space. Yo needs about 15 GB." }
  if ($state.Blocked) { Stop-Install @("Yo can't be installed on this PC yet: see the STOP lines above.", 'Fix them, then run the same command again.') }

  # ---------------------------------------------------------------- Yo's files
  Say ''
  Say "Getting Yo $Version..."
  if (-not (Test-Path -LiteralPath $AppHome)) { New-Item -ItemType Directory -Path $AppHome | Out-Null }
  $stage = Join-Path $AppHome '.install'
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Path $stage | Out-Null
  $assets = [ordered]@{ 'compose.yaml' = 'yo-app-compose.yaml'; 'yo-app.ps1' = 'yo-app.ps1'; 'yo-app.cmd' = 'yo-app.cmd'; 'yo.ico' = 'yo.ico' }
  foreach ($name in $assets.Keys) {
    $dest = Join-Path $stage $name
    try {
      if ($env:YO_APP_SOURCE) {
        $src = Join-Path $env:YO_APP_SOURCE $assets[$name]
        if (-not (Test-Path -LiteralPath $src)) { $src = Join-Path $env:YO_APP_SOURCE $name }
        Copy-Item -LiteralPath $src -Destination $dest -Force
      } else {
        Invoke-WebRequest -UseBasicParsing -Uri "$Releases/v$Version/$($assets[$name])" -OutFile $dest -TimeoutSec 120
      }
    } catch {
      Stop-Install @("Couldn't get Yo's file $($assets[$name]): $($_.Exception.Message)", "Check this PC's internet connection and run the installer again.")
    }
  }
  $binDir = Join-Path $AppHome 'bin'
  if (-not (Test-Path -LiteralPath $binDir)) { New-Item -ItemType Directory -Path $binDir | Out-Null }
  Move-Item -LiteralPath (Join-Path $stage 'compose.yaml') -Destination (Join-Path $AppHome 'compose.yaml') -Force
  Move-Item -LiteralPath (Join-Path $stage 'yo-app.ps1') -Destination (Join-Path $AppHome 'yo-app.ps1') -Force
  Move-Item -LiteralPath (Join-Path $stage 'yo.ico') -Destination (Join-Path $AppHome 'yo.ico') -Force
  Move-Item -LiteralPath (Join-Path $stage 'yo-app.cmd') -Destination (Join-Path $binDir 'yo-app.cmd') -Force
  Remove-Item -LiteralPath $stage -Recurse -Force
  Pass "Files in $AppHome"

  # ---------------------------------------------------------------- settings
  $project = $env:YO_APP_PROJECT
  if (-not $project) { $project = Get-EnvValue 'YO_APP_PROJECT' }
  if (-not $project) { $project = 'yo-app' }
  if ($project -cnotmatch '^[a-z0-9][a-z0-9_-]*$') { Stop-Install @('YO_APP_PROJECT must be lowercase letters, digits, - or _.') }
  $composeArgs = @('compose', '--project-name', $project, '-f', 'compose.yaml', '--env-file', '.env')

  $token = Get-EnvValue 'YO_AGENTD_TOKEN'
  if ($token -notmatch '^[0-9a-f]{64}$') { $token = New-RandomHex }

  # The port: the one Yo already has (if it's running there or the port is still free), else 7777 or the next
  # free one up to 7799.
  $current = Get-EnvValue 'YO_PORT'
  $want = $env:YO_APP_PORT
  if (-not $want) { $want = $current }
  if (-not $want) { $want = '7777' }
  if ($want -notmatch '^[0-9]+$') { Stop-Install @('YO_APP_PORT must be a number.') }
  $oursRunning = $false
  if ($existing) {
    Push-Location -LiteralPath $AppHome
    try { $r = Invoke-Capture 'docker' ($composeArgs + @('ps', '-q', '--status', 'running', 'yo-core')) } finally { Pop-Location }
    $oursRunning = ($r.Code -eq 0 -and $r.Out -match '[0-9a-f]{12}')
  }
  $port = ''
  if ($oursRunning -and $want -eq $current) { $port = $want }
  else {
    $last = [math]::Max(7799, [int]$want)
    for ($p = [int]$want; $p -le $last; $p++) { if (Test-PortFree $p) { $port = [string]$p; break } }
    if (-not $port) {
      if ([int]$want -eq $last) { Stop-Install @("Port $want is in use by another program on this PC, so Yo has nowhere to listen.", 'Close that program (or choose another port with YO_APP_PORT), then run the installer again.') }
      Stop-Install @("Ports $want to $last are all in use on this PC, so Yo has nowhere to listen.", 'Close a program that uses one of them, then run the installer again.')
    }
    if ($port -ne $want) { Note "Port $want is used by another program, so Yo uses port $port." }
  }

  $tz = Get-IanaTimeZone
  $tzName = $tz.Iana
  if (-not $tzName) {
    $tzName = 'UTC'
    Note "Couldn't match this PC's time zone ('$($tz.Id)'), so Yo uses UTC. Change YO_TZ in $EnvFile (like Europe/Lisbon), then: yo-app restart"
  }

  $newFile = -not (Test-Path -LiteralPath $EnvFile)
  if ($newFile) {
    $header = "# Yo (PC edition) settings, written by the installer. Keep this file private: YO_AGENTD_TOKEN is the`n# secret between Yo's core and its computer.`n"
    [IO.File]::WriteAllText($EnvFile, $header, (New-Object Text.UTF8Encoding($false)))
    if (-not (Protect-File $EnvFile)) { Note "Couldn't limit $EnvFile to your user only; it's in your own profile folder, so other users can't open it by default." }
  }
  $coreImage = if ($env:YO_CORE_IMAGE) { $env:YO_CORE_IMAGE } else { "${CoreRepo}:$Version" }
  $computerImage = if ($env:YO_COMPUTER_IMAGE) { $env:YO_COMPUTER_IMAGE } else { "${ComputerRepo}:$Version" }
  Set-EnvValue 'YO_AGENTD_TOKEN' $token
  Set-EnvValue 'YO_APP_PROJECT' $project
  Set-EnvValue 'YO_PORT' $port
  Set-EnvValue 'YO_TZ' $tzName
  Set-EnvValue 'YO_COMPUTER_MEMORY' $memoryLimit
  Set-EnvValue 'YO_CORE_IMAGE' $coreImage
  Set-EnvValue 'YO_COMPUTER_IMAGE' $computerImage
  Set-EnvValue 'YO_VERSION' $Version
  Pass "Settings in $EnvFile (private): port $port, time zone $tzName, computer memory $memoryLimit"

  # ---------------------------------------------------------------- the yo-app command and the shortcuts
  Add-ToUserPath $binDir
  Pass "The yo-app command ($binDir is on your PATH)"
  $shortcutName = if ($project -eq 'yo-app') { 'Yo' } else { "Yo ($project)" }
  if ($env:YO_APP_NO_SHORTCUTS -ne '1') {
    try {
      $shell = New-Object -ComObject WScript.Shell
      $helper = Join-Path $AppHome 'yo-app.ps1'
      $made = @()
      foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        if (-not $folder -or -not (Test-Path -LiteralPath $folder)) { continue }
        $lnk = $shell.CreateShortcut((Join-Path $folder "$shortcutName.lnk"))
        $lnk.TargetPath = $PowerShellExe
        $lnk.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$helper`" open --gui"
        $lnk.WorkingDirectory = $AppHome
        $lnk.IconLocation = (Join-Path $AppHome 'yo.ico') + ',0'
        $lnk.Description = 'Open Yo in your browser'
        $lnk.WindowStyle = 7
        $lnk.Save()
        $made += $folder
      }
      Pass "Shortcuts named '$shortcutName' in the Start menu and on the desktop"
    } catch { Note "Couldn't create the Yo shortcuts ($($_.Exception.Message)). Use 'yo-app open' instead." }
  }

  # ---------------------------------------------------------------- images and start
  if ($env:YO_APP_SKIP_PULL -ne '1') {
    Say ''
    Say 'Downloading Yo (about 1 GB the first time; this can take a few minutes)...'
    Push-Location -LiteralPath $AppHome
    try { $code = Invoke-Shown 'docker' ($composeArgs + @('pull')) } finally { Pop-Location }
    if ($code -ne 0) {
      Stop-Install @("Couldn't download Yo's images.", "Check this PC's internet connection and run the installer again. (If this is a brand-new release, its", 'images may not be public yet: wait a few minutes and try again.)')
    }
  }
  Say ''
  $helperArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $AppHome 'yo-app.ps1'))
  $code = Invoke-Shown $PowerShellExe ($helperArgs + @('start'))
  if ($code -ne 0) { Stop-Install @("Yo is installed but didn't start (the messages above say why).", 'Try again with:  yo-app open') }

  Say ''
  Say 'Yo is installed.'
  Say ''
  Say "  Yo lives in:   $AppHome (your chats and files are in Docker volumes ${project}_core-data and ${project}_computer-data)"
  Say "  Open Yo:       '$shortcutName' in the Start menu or on your desktop, or type: yo-app open"
  Say '  Yo keeps running in the background with Docker Desktop, also with the browser closed, and starts again'
  Say '  when Docker Desktop starts (Docker Desktop > Settings > General > Start when you sign in).'
  Say ''
  Say '  yo-app open        open Yo in your browser and sign it in'
  Say '  yo-app signin      a one-time sign-in link for another browser'
  Say '  yo-app status      is Yo running?'
  Say '  yo-app stop | start | restart'
  Say '  yo-app update      get the newest Yo'
  Say "  yo-app logs        Yo's recent messages, for bug reports"
  Say '  yo-app uninstall   remove Yo'
  Say '  yo-app help        everything else'
  Say '  (In PowerShell or Command Prompt. Windows that were already open before this install need reopening.)'
  $code = Invoke-Shown $PowerShellExe ($helperArgs + @('signin'))
  if ($code -ne 0) { Stop-Install @("Yo is running, but the sign-in link failed. Try:  yo-app signin") }
  return $true
}

$yoInstalled = $false
try { $yoInstalled = Install-YoApp } catch {
  $msg = [string]$_.Exception.Message
  Write-Host ''
  if ($msg.StartsWith('YO: ')) { Write-Host $msg.Substring(4) }
  else {
    Write-Host "Something unexpected went wrong while installing Yo: $msg"
    Write-Host ($_.InvocationInfo.PositionMessage)
    Write-Host 'Run the same command again; if it happens again, report it at https://github.com/JuniorSua/yo-app/issues'
  }
}
# Run as a file (not through iex): report failure in the exit code. Under iex, `exit` would close the window.
if ($PSCommandPath -and -not $yoInstalled) { exit 1 }
