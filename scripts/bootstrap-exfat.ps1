param(
  [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [string]$BackupRoot,
  [switch]$SkipBackup,
  [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)

  $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
  Write-Host "[$timestamp] $Message"
}

function Get-RepoFileSystem {
  param([string]$Path)

  $qualifier = Split-Path -Path $Path -Qualifier
  if (-not $qualifier) {
    throw "Unable to determine drive for path: $Path"
  }

  $driveLetter = $qualifier.TrimEnd(":")
  $volume = Get-Volume -DriveLetter $driveLetter -ErrorAction Stop
  return $volume.FileSystem
}

function Backup-ExistingNodeModules {
  param(
    [string]$TargetPath,
    [string]$ResolvedBackupRoot
  )

  if (-not (Test-Path -LiteralPath $TargetPath)) {
    return $null
  }

  New-Item -ItemType Directory -Force -Path $ResolvedBackupRoot | Out-Null
  $backupName = "node_modules-{0}" -f (Get-Date -Format "yyyyMMdd-HHmmss")
  $backupPath = Join-Path $ResolvedBackupRoot $backupName
  Move-Item -LiteralPath $TargetPath -Destination $backupPath
  return $backupPath
}

function Get-WorkspacePackages {
  param([string]$ResolvedRepoRoot)

  $map = @{}
  $packageDirs = Get-ChildItem -LiteralPath (Join-Path $ResolvedRepoRoot "packages") -Directory
  foreach ($dir in $packageDirs) {
    $packageJson = Join-Path $dir.FullName "package.json"
    if (-not (Test-Path -LiteralPath $packageJson)) {
      continue
    }

    $manifest = Get-Content -Raw $packageJson | ConvertFrom-Json -AsHashtable
    if (-not $manifest.name) {
      continue
    }

    $map[$manifest.name] = $dir.FullName
  }

  return $map
}

function Get-NodeModulesPackagePath {
  param(
    [string]$NodeModulesRoot,
    [string]$PackageName
  )

  if ($PackageName.StartsWith("@")) {
    $parts = $PackageName.Split("/", 2)
    if ($parts.Count -ne 2) {
      throw "Invalid scoped package name: $PackageName"
    }

    return Join-Path (Join-Path $NodeModulesRoot $parts[0]) $parts[1]
  }

  return Join-Path $NodeModulesRoot $PackageName
}

function Copy-WorkspacePackage {
  param(
    [string]$SourcePath,
    [string]$DestinationPath
  )

  if (Test-Path -LiteralPath $DestinationPath) {
    Remove-Item -LiteralPath $DestinationPath -Recurse -Force
  }

  New-Item -ItemType Directory -Force -Path $DestinationPath | Out-Null

  $sourceItems = Get-ChildItem -LiteralPath $SourcePath -Force |
    Where-Object { $_.Name -ne "node_modules" }

  foreach ($item in $sourceItems) {
    Copy-Item -LiteralPath $item.FullName -Destination $DestinationPath -Recurse -Force
  }
}

function Sync-WorkspacePackageCopies {
  param([string]$ResolvedRepoRoot)

  $workspacePackages = Get-WorkspacePackages -ResolvedRepoRoot $ResolvedRepoRoot
  $packageDirs = Get-ChildItem -LiteralPath (Join-Path $ResolvedRepoRoot "packages") -Directory
  $sections = @("dependencies", "devDependencies", "optionalDependencies", "peerDependencies")

  foreach ($dir in $packageDirs) {
    $packageJson = Join-Path $dir.FullName "package.json"
    if (-not (Test-Path -LiteralPath $packageJson)) {
      continue
    }

    $manifest = Get-Content -Raw $packageJson | ConvertFrom-Json -AsHashtable
    $workspaceDeps = New-Object System.Collections.Generic.HashSet[string]

    foreach ($section in $sections) {
      if (-not $manifest.ContainsKey($section) -or -not $manifest[$section]) {
        continue
      }

      foreach ($depName in $manifest[$section].Keys) {
        $depSpec = $manifest[$section][$depName]
        if (
          $depSpec -is [string] -and
          $depSpec.StartsWith("workspace:") -and
          $workspacePackages.ContainsKey($depName)
        ) {
          $null = $workspaceDeps.Add($depName)
        }
      }
    }

    if ($workspaceDeps.Count -eq 0) {
      continue
    }

    $nodeModulesRoot = Join-Path $dir.FullName "node_modules"
    New-Item -ItemType Directory -Force -Path $nodeModulesRoot | Out-Null

    foreach ($depName in $workspaceDeps) {
      $destination = Get-NodeModulesPackagePath -NodeModulesRoot $nodeModulesRoot -PackageName $depName
      Write-Step "实体化 workspace 包 $depName -> $destination"
      Copy-WorkspacePackage -SourcePath $workspacePackages[$depName] -DestinationPath $destination
    }
  }
}

function Run-PnpmInstall {
  param(
    [string]$ResolvedRepoRoot,
    [string]$FileSystem
  )

  if ($FileSystem -eq "NTFS") {
    Write-Step "检测到 NTFS，执行标准 pnpm install"
    & pnpm install
    if ($LASTEXITCODE -ne 0) {
      throw "pnpm install failed with exit code $LASTEXITCODE"
    }
    return
  }

  Write-Step "检测到 $FileSystem，执行 exFAT 兼容安装"
  & pnpm install --config.node-linker=hoisted --config.package-import-method=copy --config.inject-workspace-packages=true
  $exitCode = $LASTEXITCODE

  if ($exitCode -ne 0) {
    Write-Step "兼容安装返回 $exitCode，继续补齐 workspace 包实体目录"
  }
}

function Run-CoreBuilds {
  Write-Step "构建 shared"
  & pnpm --filter shared build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm --filter shared build failed with exit code $LASTEXITCODE"
  }

  Write-Step "构建 client"
  & pnpm --filter client build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm --filter client build failed with exit code $LASTEXITCODE"
  }

  Write-Step "构建 server"
  & pnpm --filter server build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm --filter server build failed with exit code $LASTEXITCODE"
  }

  Write-Step "构建 relay"
  & pnpm --filter relay build
  if ($LASTEXITCODE -ne 0) {
    throw "pnpm --filter relay build failed with exit code $LASTEXITCODE"
  }
}

$resolvedRepoRoot = (Resolve-Path $RepoRoot).Path
$resolvedBackupRoot = if ($BackupRoot) {
  $BackupRoot
} else {
  Join-Path (Split-Path $resolvedRepoRoot -Parent) "_install-backups\yepanywhere"
}

Write-Step "RepoRoot: $resolvedRepoRoot"
$fileSystem = Get-RepoFileSystem -Path $resolvedRepoRoot
Write-Step "文件系统: $fileSystem"

$nodeModulesPath = Join-Path $resolvedRepoRoot "node_modules"
if (-not $SkipBackup) {
  $backupPath = Backup-ExistingNodeModules -TargetPath $nodeModulesPath -ResolvedBackupRoot $resolvedBackupRoot
  if ($backupPath) {
    Write-Step "已备份现有 node_modules -> $backupPath"
  } else {
    Write-Step "当前无 node_modules，无需备份"
  }
}

Run-PnpmInstall -ResolvedRepoRoot $resolvedRepoRoot -FileSystem $fileSystem
Sync-WorkspacePackageCopies -ResolvedRepoRoot $resolvedRepoRoot

if (-not $SkipBuild) {
  Run-CoreBuilds
}

Write-Step "bootstrap 完成"
