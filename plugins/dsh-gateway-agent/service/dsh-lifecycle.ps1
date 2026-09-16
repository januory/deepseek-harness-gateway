# dsh-gateway-agent --Windows dsh lifecycle helper.
#
# The Windows defaults in the plugin settings card call this script, because
# expressing "find the dsh process and stop it" as a cmd one-liner is unreliable
# and --if written as `taskkill /im dsh.exe` --dangerous: on a machine that runs
# dsh from a checkout (`node ... bin.ts web`) there is no dsh.exe, and a
# name-based kill could hit the supervisor's own node process.
#
# Which process counts as dsh, in order of reliability:
#   1. whoever LISTENS on the configured port (works for every install style:
#      `dsh web`, `pnpm dsh web`, `node ...\bin.ts web`);
#   2. otherwise a command-line match on `\bdsh\b`.
# Either way the supervisor's own process and this helper are excluded, so `stop`
# can never take the supervisor down (on Windows `process.title` does not change the
# command line, so the supervisor is matched by its `dsh-gateway-agent\src\daemon.js`
# path instead of a title marker).
#
# Usage (called by the supervisor; also fine by hand):
#   powershell -NoProfile -File dsh-lifecycle.ps1 status   [PORT]
#   powershell -NoProfile -File dsh-lifecycle.ps1 stop     [PORT]
#   powershell -NoProfile -File dsh-lifecycle.ps1 start    [PORT]
#
# Exit codes: status ->0 when dsh is running, 1 when it is not.
#             stop   ->0 always (idempotent).
#             start  ->0 when a start was issued.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'stop', 'start')]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$Port = '3080',

  # Match string for the dsh process command line. Deliberately narrow: the
  # literal `dsh web` (also `dsh.exe web` / `dsh.cmd web`), NOT a bare `\bdsh\b`.
  # A bare word match also hits every unrelated command line that merely
  # CONTAINS a `.dsh` path (`C:\Users\x\.dsh\...`, `dsh-remote-workspaces`,
  # `dsh-context`), and a `stop` issued while dsh is already down would kill
  # those instead of doing nothing. This scan is only the fallback for when the
  # port probe below cannot see the listener.
  [string]$Pattern = '\bdsh(?:\.exe|\.cmd)?[" ]+web\b',

  # Any command line containing one of these is never touched: the supervisor
  # itself and this helper. Two more markers are appended below; these two are the
  # ones you can extend from the outside.
  [string[]]$Exclude = @('dsh-gateway-supervisor', 'dsh-lifecycle')
)

$ErrorActionPreference = 'Stop'

# Keep every MESSAGE in this file ASCII. The supervisor captures this script's
# stdout through a pipe and decodes it as UTF-8, while Windows PowerShell 5.1
# writes it in the console code page (gb2312 on a Chinese install), so non-ASCII
# diagnostics reach the portal as mojibake - and [Console]::OutputEncoding does
# not change that for a redirected pipe (measured). Comments are fine, which is
# also why this file is saved as UTF-8 WITH a BOM: a BOM-less non-ASCII script is
# read as ANSI and can fail to parse at all (measured: exit 1, no output).

# Never touch these, whatever else matches. `process.title` does NOT change the
# Windows command line, so the supervisor shows up as `node <plugin>\dsh-gateway-agent
# \src\daemon.js` --which the default `\bdsh\b` pattern happily matches ("dsh" is a
# whole word before the dash). Without the two appended markers `stop` kills the
# supervisor instead of dsh, while dsh keeps running.
$Exclude = @($Exclude) + @('dsh-gateway-agent', 'daemon\.js')

function Test-Excluded([string]$CommandLine) {
  if (-not $CommandLine) { return $false }
  foreach ($needle in $Exclude) {
    if ($needle -and $CommandLine -match $needle) { return $true }
  }
  return $false
}

# The process LISTENING on the configured port is dsh --whatever launched it
# (`dsh web`, `pnpm dsh web`, `node ...\bin.ts web`). That is the reliable signal on
# Windows: a checkout install has no "dsh" word in its command line at all.
function Get-DshByPort {
  try {
    $conn = Get-NetTCPConnection -LocalPort ([int]$Port) -State Listen -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if (-not $conn) { return $null }
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId=$($conn.OwningProcess)" -ErrorAction SilentlyContinue
    if ($proc -and -not (Test-Excluded $proc.CommandLine)) { return $proc }
  } catch {
    # Get-NetTCPConnection unavailable (old Windows) --the command-line scan below still runs.
  }
  return $null
}

function Get-DshProcess {
  $byPort = Get-DshByPort
  if ($byPort) { return @($byPort) }
  Get-CimInstance Win32_Process |
    Where-Object {
      if (-not $_.CommandLine) { return $false }
      if ($_.CommandLine -notmatch $Pattern) { return $false }
      if (Test-Excluded $_.CommandLine) { return $false }
      return $true
    }
}

switch ($Action) {
  'status' {
    $found = @(Get-DshProcess)
    if ($found.Count -gt 0) {
      Write-Host "dsh: running (pid $(($found | ForEach-Object { $_.ProcessId }) -join ', '))"
      exit 0
    }
    Write-Host 'dsh: not running'
    exit 1
  }

  'stop' {
    $procs = @(Get-DshProcess)
    if ($procs.Count -eq 0) {
      Write-Host 'dsh: not running'
      exit 0
    }
    $askedNicely = $false
    foreach ($p in $procs) {
      Write-Host "dsh: stopping pid=$($p.ProcessId)"
      try {
        # Graceful first: dsh flushes sessions on a normal termination. A hidden or
        # console process has no main window, so there is nothing to ask nicely --        # skip straight to the forceful path instead of waiting 8s for nothing.
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc -and $proc.MainWindowHandle -ne 0) {
          $proc.CloseMainWindow() | Out-Null
          $askedNicely = $true
        }
      } catch {
        # Already gone: fall through to the forceful path.
      }
    }
    if ($askedNicely) {
      # Give graceful exits a moment, then force whatever is left.
      $deadline = (Get-Date).AddSeconds(8)
      while ((Get-Date) -lt $deadline -and @(Get-DshProcess).Count -gt 0) {
        Start-Sleep -Milliseconds 300
      }
    }
    foreach ($p in @(Get-DshProcess)) {
      Write-Host "dsh: force-stopping pid=$($p.ProcessId)"
      Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
    }
    exit 0
  }

  'start' {
    if (@(Get-DshProcess).Count -gt 0) {
      Write-Host 'dsh: already running'
      exit 0
    }
    if (-not (Get-Command dsh -ErrorAction SilentlyContinue)) {
      Write-Host 'dsh: the "dsh" command is not on PATH - give the start script (scripts.start) your own command, or put dsh on PATH'
      Write-Host 'dsh: for a checkout install use scripts.start = node --import tsx/esm apps/cli/src/bin.ts web --no-open --port {port} with child.cwd = the checkout root'
      exit 1
    }
    Write-Host "dsh: starting (dsh web --port $Port)"
    # Start dsh OUTSIDE this process tree, through the WMI service. Windows Task
    # Scheduler runs a task's action inside a job object and kills that whole tree
    # when the task stops (or when the action process exits), so a dsh created as an
    # ordinary child - `start`, Start-Process, spawn() - is killed together with the
    # supervisor. That breaks the supervisor's one promise: stopping supervision
    # must never stop dsh. Win32_Process.Create puts the new process outside the
    # job (verified on Windows 10/11, and in an S4U task session). cmd is the
    # launcher so a .cmd/.ps1 `dsh` shim on PATH still resolves.
    $created = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
      CommandLine      = "cmd /c dsh web --port $Port"
      CurrentDirectory = (Get-Location).Path
    }
    if ($created.ReturnValue -ne 0) {
      Write-Host "dsh: could not start it (Win32_Process.Create returned $($created.ReturnValue))"
      exit 1
    }
    exit 0
  }
}
