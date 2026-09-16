# dsh-gateway-agent --register the dsh LIFECYCLE SUPERVISOR as a Windows
# scheduled task (the closest thing to a user-scope service without a native
# service wrapper).
#
# What this supervises is the SUPERVISOR (daemon.js), not dsh itself: the
# supervisor is what starts/stops/restarts dsh when the gateway portal asks.
# Do not also register dsh as a task/service --pick ONE owner.
#
# Usage (from an elevated PowerShell prompt):
#   .\install-supervisor-task.ps1                 # install (default)
#   .\install-supervisor-task.ps1 install
#   .\install-supervisor-task.ps1 uninstall
#   .\install-supervisor-task.ps1 status
#   .\install-supervisor-task.ps1 install -DshHome 'D:\dsh-home'
#
# Only `install` (or `status`) touches anything; a bare word is an ACTION, never a
# path --passing a path positionally is rejected instead of silently becoming
# DSH_HOME (that typo used to re-register the task with DSH_HOME=status/uninstall
# and overwrite the user environment variable with it).
#
# The task runs at logon and restarts on failure, and it deliberately does NOT show
# A one-minute repetition watchdog also re-runs the task, so a supervisor that
# dies is back within a minute (restart-on-failure alone does not fire for a
# killed action process).
# a console window: it is registered as a non-interactive (S4U) task, falling back
# to an interactive task whose launcher hides its own window. Re-run this script
# after updating the plugin to pick up changes; `uninstall` first stops the old task
# (and any leftover supervisor process) so two supervisors cannot fight over the
# same machine.
#
# Restarting the SUPERVISOR also brings dsh back up (bootstrap checks the liveness
# probe); a dsh that crashes while the supervisor stays up is reported as `exited`
# and needs an explicit Start from the portal.

[CmdletBinding(PositionalBinding = $false)]
param(
  [Parameter(Position = 0)]
  [ValidateSet('install', 'uninstall', 'status')]
  [string]$Action = 'install',

  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$TaskName = 'dsh-gateway-supervisor',

  # Kept for backwards compatibility: `-Uninstall` == `uninstall`.
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

# Keep every MESSAGE in this file ASCII. The supervisor captures this script's
# stdout through a pipe and decodes it as UTF-8, while Windows PowerShell 5.1
# writes it in the console code page (gb2312 on a Chinese install), so non-ASCII
# diagnostics reach the portal as mojibake - and [Console]::OutputEncoding does
# not change that for a redirected pipe (measured). Comments are fine, which is
# also why this file is saved as UTF-8 WITH a BOM: a BOM-less non-ASCII script is
# read as ANSI and can fail to parse at all (measured: exit 1, no output).

if ($Uninstall) { $Action = 'uninstall' }

# A DSH_HOME that is not a path is always a typo (see the header): refuse it instead
# of writing a bogus value into the user environment.
if ($Action -eq 'install' -and ($DshHome -notmatch '[\\/]' -or -not (Test-Path -LiteralPath $DshHome))) {
  throw "DSH_HOME does not look like a directory: '$DshHome'. Pass it explicitly as -DshHome <path> (a bare word is an ACTION: install | uninstall | status)."
}

if ($Action -eq 'status') {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) {
    $info = $task | Get-ScheduledTaskInfo
    Write-Host "task      : $TaskName [$($task.State)] last=$($info.LastRunTime) result=$($info.LastTaskResult)"
    if ($info.LastTaskResult -eq 2147946720) {
      # 0x800710E0 = "the operator or administrator has refused the request": the
      # one-minute watchdog fired while the task was already running and the new
      # instance was refused (MultipleInstances=IgnoreNew). Healthy, not an error.
      Write-Host '            (0x800710E0 = watchdog tick ignored, the supervisor was already running)'
    }
  } else {
    Write-Host "task      : $TaskName not registered"
  }
  $procs = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh-gateway-agent.*daemon\.js' })
  if ($procs.Count -gt 0) {
    Write-Host "supervisor: running (pid $((($procs | ForEach-Object { $_.ProcessId }) -join ', ')))"
  } else {
    Write-Host 'supervisor: not running'
  }
  Write-Host "DSH_HOME  : $([Environment]::GetEnvironmentVariable('DSH_HOME', 'User')) (user environment)"
  return
}

if ($Action -eq 'uninstall') {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'."
  } else {
    Write-Host "No scheduled task named '$TaskName'."
  }
  return
}

# 1. Locate the supervisor entry that ships with the plugin.
$entry = $null
try {
  $entry = (node -e "console.log(require.resolve('@januory/dsh-gateway-agent/src/daemon.js'))") 2>$null
} catch {
  $entry = $null
}
if (-not $entry -or -not (Test-Path $entry)) {
  # Fall back to an explicit path so the script still works for a link:/local install.
  $fallback = Join-Path $PSScriptRoot '..\src\daemon.js'
  if (Test-Path $fallback) {
    $entry = (Resolve-Path $fallback).Path
  } else {
    throw "Cannot find daemon.js. Install the plugin first (dsh plugin --profile web add @januory/dsh-gateway-agent), or pass a path."
  }
}

$node = (Get-Command node).Source
Write-Host "Supervisor entry : $entry"
Write-Host "Node             : $node"
Write-Host "DSH_HOME         : $DshHome"

# 1b. Stop a previous instance before re-registering: an old windowed task would keep
#     running and fight the new one for the same machine identity. The process match is
#     deliberately narrow (this plugin's daemon.js), so nothing else node-based is hit.
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh-gateway-agent.*daemon\.js' } |
  ForEach-Object {
    Write-Host "Stopping a leftover supervisor (pid $($_.ProcessId))"
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }

# 2. Register the task: run node daemon.js at logon, restart on failure.
#
# Window behaviour: an interactive task (LogonType Interactive) runs the action in
# the user's desktop session, so `node daemon.js` gets a console window --annoying,
# and closing that window stops the supervisor. So prefer a non-interactive logon
# (S4U = "run whether the user is logged on or not", no stored password): no window
# at all, and the Task Scheduler still owns the process. Registering S4U can be
# refused without admin rights, hence the hidden-window fallback below.
# NOTE: never name a local variable `$action` --PowerShell variable names are
# case-insensitive, so it would overwrite the validated `-Action` parameter and blow
# up with "MSFT_TaskExecAction is not a valid value for Action".
$taskAction = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $env:USERPROFILE
# TWO triggers, both needed:
#   - AtLogOn brings the guardian up when the user logs on;
#   - a one-minute repeating trigger is the actual watchman. It must be its OWN
#     -Once trigger: attaching a Repetition to the AtLogOn trigger looks right but
#     is never armed (that trigger has an empty StartBoundary, NextRunTime stays
#     empty and a killed supervisor is never restarted - measured, still down
#     after 212s). With MultipleInstances=IgnoreNew a live supervisor is left
#     alone, so this is only a restart for a dead one.
#   RestartCount/-RestartInterval alone do NOT cover it either: a killed action
#   reports 0xFFFFFFFF and Task Scheduler does not treat that as a failure.
#   3650 days == "indefinitely" without the [TimeSpan]::MaxValue serialization trap.
$logonTrigger = New-ScheduledTaskTrigger -AtLogOn
$watchdogTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$triggers = @($logonTrigger, $watchdogTrigger)
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden -MultipleInstances IgnoreNew

# The Task Scheduler principal must be a name it can RESOLVE. "$env:USERDOMAIN\
# $env:USERNAME" is not reliable: on a network logon (SSH, runas /netonly) or a
# workgroup machine USERDOMAIN can be "WORKGROUP", which maps to no account, and
# registration then fails with "No mapping between account names and security IDs
# was done" - and so does the interactive fallback, aborting the whole install
# (measured here: USERDOMAIN=WORKGROUP while whoami says january\administrator).
# Take the first form that really maps.
function Resolve-TaskUser {
  $candidates = @(
    [Security.Principal.WindowsIdentity]::GetCurrent().Name,
    "$env:COMPUTERNAME\$env:USERNAME",
    "$env:USERDOMAIN\$env:USERNAME",
    $env:USERNAME
  )
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    try {
      $null = (New-Object System.Security.Principal.NTAccount($candidate)).Translate([Security.Principal.SecurityIdentifier])
      return $candidate
    } catch { }
  }
  throw "cannot resolve the current user for the task principal (tried: $($candidates -join ', '))"
}
$taskUser = Resolve-TaskUser
Write-Host "Task principal   : $taskUser"

$registered = $false
try {
  $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType S4U -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $taskAction -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
  $registered = $true
  Write-Host 'Registered as a non-interactive task (no console window).'
} catch {
  Write-Host "S4U logon not permitted ($($_.Exception.Message)); falling back to a hidden window."
}

if (-not $registered) {
  # Same task, but launched through PowerShell with its window hidden: no visible
  # console, and PowerShell stays the parent so stopping the task still stops node.
  $hiddenAction = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -WindowStyle Hidden -Command `"& '$node' '$entry'`"" `
    -WorkingDirectory $env:USERPROFILE
  try {
    $principal = New-ScheduledTaskPrincipal -UserId $taskUser -LogonType Interactive -RunLevel Limited
    Register-ScheduledTask -TaskName $TaskName -Action $hiddenAction -Trigger $triggers -Settings $settings -Principal $principal -Force | Out-Null
    Write-Host 'Registered as an interactive task with a hidden window.'
  } catch {
    throw "cannot register '$TaskName' for '$taskUser' (S4U was refused and the interactive fallback failed too): $($_.Exception.Message)"
  }
}

# 3. Give the task DSH_HOME via the user environment so the supervisor finds the
#    config written by the dsh settings card even after a reboot.
[Environment]::SetEnvironmentVariable('DSH_HOME', $DshHome, 'User')

Start-ScheduledTask -TaskName $TaskName

# Registering is not proof: confirm the process is actually alive. Before this
# check the script happily reported success for a supervisor that had already
# been killed by the lifecycle helper.
Start-Sleep -Seconds 3
$alive = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -and $_.CommandLine -match 'dsh-gateway-agent.*daemon\.js' })
if ($alive.Count -gt 0) {
  Write-Host "Registered and started '$TaskName' (supervisor pid $((($alive | ForEach-Object { $_.ProcessId }) -join ', ')))."
} else {
  Write-Host "Registered '$TaskName', but the supervisor is NOT running - check $DshHome\dsh-gateway-agent\daemon-state.json and: Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo"
}
