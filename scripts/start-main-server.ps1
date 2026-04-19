param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$Port = 3400,
  [string]$BindHost = "0.0.0.0",
  [string]$NodePath = "C:\Users\Administrator\tools\node-v22.22.0-win-x64\node.exe",
  [string]$DataDir = "C:\Users\Administrator\.yep-anywhere",
  [string]$ClaudeConfigDir = "C:\Users\Administrator\.claude",
  [string]$ClaudeProjectsDir = "C:\Users\Administrator\.claude\projects",
  [string]$CodexHome = "C:\Users\Administrator\.codex",
  [string]$CodexSessionsDir = "C:\Users\Administrator\.codex\sessions",
  [string]$GeminiSessionsDir = "C:\Users\Administrator\.gemini\tmp",
  [string]$AllowedHosts = "100.83.110.112,desktop-pd2lhe1.tail5b09a.ts.net",
  [string]$HttpsProxy = "",
  [string]$HttpProxy = ""
)

$ErrorActionPreference = "Stop"

function Stop-ListenerIfPresent {
  param([int]$TargetPort)

  $listenerPids = @(
    Get-NetTCPConnection -LocalPort $TargetPort -ErrorAction SilentlyContinue |
      Where-Object { $_.State -eq "Listen" } |
      Select-Object -ExpandProperty OwningProcess -Unique
  )

  foreach ($procId in $listenerPids) {
    if ($procId) {
      Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
  }
}

function Get-DefaultProxy {
  try {
    $internetSettings = Get-ItemProperty `
      'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' `
      -ErrorAction Stop
    if ($internetSettings.ProxyEnable -eq 1 -and $internetSettings.ProxyServer) {
      $proxyValue = [string]$internetSettings.ProxyServer
      if ($proxyValue -match '=') {
        $firstProxy = ($proxyValue -split ';' | Select-Object -First 1)
        if ($firstProxy -match '^[^=]+=') {
          return ($firstProxy -replace '^[^=]+=', '')
        }
      }
      return $proxyValue
    }
  } catch {
    # Ignore proxy autodiscovery errors and fall back to direct access.
  }

  return $null
}

$resolvedRepoRoot = (Resolve-Path $RepoRoot).Path
$serverEntry = Join-Path $resolvedRepoRoot "packages/server/dist/index.js"
$clientDist = Join-Path $resolvedRepoRoot "packages/client/dist"
$logDir = Join-Path $resolvedRepoRoot "output"
$stdoutLog = Join-Path $logDir "main-server-stdout.log"
$stderrLog = Join-Path $logDir "main-server-stderr.log"

if (-not (Test-Path $NodePath)) {
  throw "Node executable not found: $NodePath"
}

if (-not (Test-Path $serverEntry)) {
  throw "Server build not found: $serverEntry"
}

if (-not (Test-Path $clientDist)) {
  throw "Client build not found: $clientDist"
}

New-Item -ItemType Directory -Force -Path $logDir | Out-Null

Stop-ListenerIfPresent -TargetPort $Port
Stop-ListenerIfPresent -TargetPort ($Port + 1)

Start-Sleep -Seconds 1

$env:PORT = "$Port"
$env:HOST = $BindHost
$env:CLI_HOST_OVERRIDE = "true"
$env:SERVE_FRONTEND = "true"
$env:NODE_ENV = "production"
$env:LOG_TO_FILE = "true"
$env:LOG_LEVEL = "info"
$env:SESSION_INDEX_LOG_PERF = "true"
$env:ALLOWED_HOSTS = $AllowedHosts
$env:YEP_ANYWHERE_DATA_DIR = $DataDir
$env:CLAUDE_CONFIG_DIR = $ClaudeConfigDir
$env:CLAUDE_PROJECTS_DIR = $ClaudeProjectsDir
$env:CODEX_HOME = $CodexHome
$env:CODEX_SESSIONS_DIR = $CodexSessionsDir
$env:GEMINI_SESSIONS_DIR = $GeminiSessionsDir

$resolvedProxy = if ($HttpsProxy) {
  $HttpsProxy
} else {
  Get-DefaultProxy
}

if ($resolvedProxy) {
  $proxyUrl = if ($resolvedProxy -match '^https?://') {
    $resolvedProxy
  } else {
    "http://$resolvedProxy"
  }
  $env:HTTPS_PROXY = $proxyUrl
  $env:HTTP_PROXY = if ($HttpProxy) { $HttpProxy } else { $proxyUrl }
} else {
  Remove-Item Env:HTTPS_PROXY -ErrorAction SilentlyContinue
  Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue
}

Start-Process `
  -FilePath $NodePath `
  -ArgumentList $serverEntry `
  -WorkingDirectory $resolvedRepoRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $stdoutLog `
  -RedirectStandardError $stderrLog | Out-Null
