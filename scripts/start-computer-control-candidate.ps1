[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$CodexHome,
    [Parameter(Mandatory = $true)][string]$TokenFile,
    [Parameter(Mandatory = $true)][string]$CodexExecutable,
    [int]$Port = 4440,
    [string]$DataDirectory = (Join-Path $PSScriptRoot '../.artifacts/computer-candidate/data')
)
$ErrorActionPreference = 'Stop'
$candidateRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$candidateData = [IO.Path]::GetFullPath($DataDirectory)
if (-not $candidateData.StartsWith($candidateRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Candidate data must remain inside the candidate checkout'
}
if ($Port -lt 1024 -or $Port -gt 65532) { throw 'Invalid candidate port' }
if (-not (Test-Path -LiteralPath $CodexHome -PathType Container)) { throw 'Create a distinct acceptance Codex home first' }
$env:YEP_DATA_DIR = $candidateData
$env:YEP_PROFILE = 'computer-candidate'
$env:YEP_PROVIDER_HOST_RUNTIME_DIR = Join-Path $candidateData 'provider-host'
$env:CODEX_HOME = (Resolve-Path -LiteralPath $CodexHome).Path
$env:CODEX_SESSIONS_DIR = Join-Path $env:CODEX_HOME 'sessions'
$env:YEP_DESKTOP_CODEX_CLI_PATH = (Resolve-Path -LiteralPath $CodexExecutable).Path
$env:PORT = [string]$Port
$env:HOST = '127.0.0.1'
$env:MAINTENANCE_PORT = '0'
$env:ENABLED_PROVIDERS = 'codex'
$env:CLIENT_DIST_PATH = Join-Path $candidateRoot 'packages/client/dist'
# YA's native ACL probes use Windows PowerShell, not PowerShell 7 modules.
$env:PSModulePath = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/Modules'
$env:AUTH_DISABLED = 'false'
$env:DESKTOP_AUTH_TOKEN = [IO.File]::ReadAllText((Resolve-Path -LiteralPath $TokenFile).Path).Trim()
if ($env:DESKTOP_AUTH_TOKEN.Length -lt 32) { throw 'Provide a distinct candidate authentication token of at least 32 characters' }
# The server consumes/deletes this token before launching provider children.
# No credentials are generated, copied, logged or written by this runner.
Set-Location -LiteralPath $candidateRoot
$candidateTsx = Join-Path $candidateRoot 'node_modules/tsx/dist/loader.mjs'
try { & node --import ([Uri]::new($candidateTsx).AbsoluteUri) --conditions source packages/server/src/index.ts }
finally { Remove-Item Env:DESKTOP_AUTH_TOKEN -ErrorAction SilentlyContinue }
