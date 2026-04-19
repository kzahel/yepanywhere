param(
  [int]$Port = 3400,
  [string]$TaskName = "YepAnywhere-MainServer"
)

$ErrorActionPreference = "Stop"

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$logDir = Join-Path $repoRoot "output"
$logFile = Join-Path $logDir "ensure-yepanywhere.log"

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Write-EnsureLog {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Add-Content -Path $logFile -Value "[$timestamp] $Message"
}

function Ensure-Port {
  param(
    [int]$TargetPort,
    [string]$ScheduledTaskName
  )

  $listener = Get-NetTCPConnection -LocalPort $TargetPort -ErrorAction SilentlyContinue |
    Where-Object { $_.State -eq "Listen" } |
    Select-Object -First 1

  if ($listener) {
    Write-EnsureLog "port $TargetPort already listening (pid=$($listener.OwningProcess))"
    return
  }

  Write-EnsureLog "port $TargetPort is down, starting task $ScheduledTaskName"
  Start-ScheduledTask -TaskName $ScheduledTaskName
}

try {
  $tailscale = Get-Service Tailscale -ErrorAction SilentlyContinue
  if ($tailscale -and $tailscale.Status -ne "Running") {
    Start-Service Tailscale
    Write-EnsureLog "started Tailscale service"
  }

  Ensure-Port -TargetPort $Port -ScheduledTaskName $TaskName
} catch {
  Write-EnsureLog "watchdog error: $($_.Exception.Message)"
  throw
}
