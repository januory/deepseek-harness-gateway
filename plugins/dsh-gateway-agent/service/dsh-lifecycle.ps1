# dsh-gateway-agent — Windows dsh lifecycle helper.
#
# The Windows defaults in the plugin settings card call this script, because
# expressing "find the dsh process and stop it" as a cmd one-liner is unreliable
# and — if written as `taskkill /im dsh.exe` — dangerous: on a machine that runs
# dsh from a checkout (`node ... bin.ts web`) there is no dsh.exe, and a
# name-based kill could hit the supervisor's own node process.
#
# Every operation matches dsh by COMMAND LINE and always excludes a command line
# carrying the supervisor marker, so the supervisor can never kill itself.
#
# Usage (called by the supervisor; also fine by hand):
#   powershell -NoProfile -File dsh-lifecycle.ps1 status   [PORT]
#   powershell -NoProfile -File dsh-lifecycle.ps1 stop     [PORT]
#   powershell -NoProfile -File dsh-lifecycle.ps1 start    [PORT]
#
# Exit codes: status → 0 when dsh is running, 1 when it is not.
#             stop   → 0 always (idempotent).
#             start  → 0 when a start was issued.

[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('status', 'stop', 'start')]
  [string]$Action,

  [Parameter(Position = 1)]
  [string]$Port = '3080',

  # Match string for the dsh process command line. The leading \b keeps this
  # from hitting unrelated processes whose arguments merely CONTAIN "dsh"
  # (e.g. PresentMonService's "NamedSharedMem"); a dsh command line always has
  # "dsh" as a whole word (`dsh web`, `...dsh.exe`, `pnpm ... dsh web`).
  [string]$Pattern = '\bdsh\b',

  # Any command line containing one of these is never touched: the supervisor
  # itself (`--dsh-gateway-supervisor`) and this helper (its own path contains
  # "dsh", so without the second marker `stop` would kill its own shell).
  [string[]]$Exclude = @('dsh-gateway-supervisor', 'dsh-lifecycle')
)

$ErrorActionPreference = 'Stop'

function Get-DshProcess {
  Get-CimInstance Win32_Process |
    Where-Object {
      if (-not $_.CommandLine) { return $false }
      if ($_.CommandLine -notmatch $Pattern) { return $false }
      foreach ($needle in $Exclude) {
        if ($needle -and $_.CommandLine -match $needle) { return $false }
      }
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
    foreach ($p in $procs) {
      Write-Host "dsh: stopping pid=$($p.ProcessId)"
      try {
        # Graceful first: dsh flushes sessions on a normal termination.
        $proc = Get-Process -Id $p.ProcessId -ErrorAction SilentlyContinue
        if ($proc) { $proc.CloseMainWindow() | Out-Null }
      } catch {
        # No window / already gone: fall through to the forceful path.
      }
    }
    # Give graceful exits a moment, then force whatever is left.
    $deadline = (Get-Date).AddSeconds(8)
    while ((Get-Date) -lt $deadline -and @(Get-DshProcess).Count -gt 0) {
      Start-Sleep -Milliseconds 300
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
    Write-Host "dsh: starting (dsh web --port $Port)"
    # `start` detaches so the supervisor is not the parent of dsh.
    Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "start `"dsh`" /b dsh web --port $Port" -WindowStyle Hidden
    exit 0
  }
}
