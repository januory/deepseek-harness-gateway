# dsh-gateway-agent — register the dsh LIFECYCLE SUPERVISOR as a Windows
# scheduled task (the closest thing to a user-scope service without a native
# service wrapper).
#
# What this supervises is the SUPERVISOR (daemon.js), not dsh itself: the
# supervisor is what starts/stops/restarts dsh when the gateway portal asks.
# Do not also register dsh as a task/service — pick ONE owner.
#
# Usage (from an elevated PowerShell prompt):
#   .\install-supervisor-task.ps1
#   .\install-supervisor-task.ps1 -DshHome 'D:\dsh-home'
#   .\install-supervisor-task.ps1 -Uninstall
#
# The task runs at logon and restarts on failure. dsh's own crash policy is the
# supervisor's auto-revive setting (off by default).

[CmdletBinding()]
param(
  [string]$DshHome = (Join-Path $env:USERPROFILE '.dsh'),
  [string]$TaskName = 'dsh-gateway-supervisor',
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

if ($Uninstall) {
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

# 2. Register the task: run node daemon.js at logon, restart on failure.
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$entry`"" -WorkingDirectory $env:USERPROFILE
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# 3. Give the task DSH_HOME via the user environment so the supervisor finds the
#    config written by the dsh settings card even after a reboot.
[Environment]::SetEnvironmentVariable('DSH_HOME', $DshHome, 'User')

Start-ScheduledTask -TaskName $TaskName
Write-Host "Registered and started '$TaskName'. Check it with: Get-ScheduledTask '$TaskName' | Get-ScheduledTaskInfo"
