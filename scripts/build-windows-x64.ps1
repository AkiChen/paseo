[CmdletBinding()]
param(
  [ValidatePattern('^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$')]
  [string]$Version,
  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "This script only builds the Windows desktop client."
}

$repoRoot = Split-Path $PSScriptRoot -Parent
$desktopRoot = Join-Path $repoRoot "packages\desktop"
$appRoot = Join-Path $repoRoot "packages\app"
$packageJson = Get-Content -LiteralPath (Join-Path $repoRoot "package.json") -Raw |
  ConvertFrom-Json
$baseVersion = [string]$packageJson.version

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$nodeDirectory = Split-Path $nodeCommand.Source -Parent
$npmCommand = Join-Path $nodeDirectory "npm.cmd"
$npxCommand = Join-Path $nodeDirectory "npx.cmd"

if (-not (Test-Path -LiteralPath $npmCommand) -or -not (Test-Path -LiteralPath $npxCommand)) {
  throw "npm.cmd and npx.cmd must be installed beside node.exe."
}

# npm prepends and rewrites PATH for nested lifecycle scripts. Pinning the real
# Node installation first prevents later child processes from losing node.exe.
$env:PATH = "$nodeDirectory;$env:PATH"

if (-not $OutputRoot) {
  $repoParent = Split-Path $repoRoot -Parent
  if ((Split-Path $repoParent -Leaf) -eq "work") {
    $OutputRoot = Join-Path (Split-Path $repoParent -Parent) "outputs"
  } else {
    $OutputRoot = Join-Path $repoRoot "outputs"
  }
}
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
[void](New-Item -ItemType Directory -Path $OutputRoot -Force)

if (-not $Version) {
  $escapedBaseVersion = [regex]::Escape($baseVersion)
  $directoryPattern = "^Paseo-v$escapedBaseVersion-custom\.(\d+)-windows-x64$"
  $highestBuild = 0
  foreach ($directory in Get-ChildItem -LiteralPath $OutputRoot -Directory) {
    if ($directory.Name -match $directoryPattern) {
      $highestBuild = [Math]::Max($highestBuild, [int]$Matches[1])
    }
  }
  $Version = "$baseVersion-custom.$($highestBuild + 1)"
}

$outputDirectory = Join-Path $OutputRoot "Paseo-v$Version-windows-x64"
if (Test-Path -LiteralPath $outputDirectory) {
  throw "Build output already exists: $outputDirectory"
}

$stagingRoot = Join-Path ([IO.Path]::GetTempPath()) "paseo-windows-x64-$([guid]::NewGuid().ToString('N'))"

function Invoke-BuildStep {
  param(
    [Parameter(Mandatory)] [string]$Label,
    [Parameter(Mandatory)] [string]$WorkingDirectory,
    [Parameter(Mandatory)] [string]$Command,
    [Parameter(Mandatory)] [string[]]$Arguments
  )

  Write-Host "`n==> $Label" -ForegroundColor Cyan
  Push-Location $WorkingDirectory
  try {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
      throw "$Label failed with exit code $LASTEXITCODE."
    }
  } finally {
    Pop-Location
  }
}

try {
  Invoke-BuildStep `
    -Label "Build application dependencies" `
    -WorkingDirectory $repoRoot `
    -Command $npmCommand `
    -Arguments @("run", "build:app-deps:clean")

  $env:PASEO_WEB_PLATFORM = "electron"
  $env:EXPO_PUBLIC_PASEO_VERSION = $Version
  Invoke-BuildStep `
    -Label "Export Electron renderer" `
    -WorkingDirectory $appRoot `
    -Command $npxCommand `
    -Arguments @("expo", "export", "--platform", "web")

  Invoke-BuildStep `
    -Label "Build bundled server and CLI" `
    -WorkingDirectory $repoRoot `
    -Command $npmCommand `
    -Arguments @("run", "build:server:clean")

  Invoke-BuildStep `
    -Label "Build Electron main process" `
    -WorkingDirectory $desktopRoot `
    -Command $npmCommand `
    -Arguments @("run", "build:main")

  Invoke-BuildStep `
    -Label "Package Windows x64 directory" `
    -WorkingDirectory $desktopRoot `
    -Command $npxCommand `
    -Arguments @(
      "electron-builder",
      "--config", "electron-builder.yml",
      "--win",
      "--x64",
      "--dir",
      "--config.directories.output=$stagingRoot",
      "--config.extraMetadata.version=$Version"
    )

  $unpackedDirectory = Join-Path $stagingRoot "win-unpacked"
  $executable = Join-Path $unpackedDirectory "Paseo.exe"
  $rendererIndex = Join-Path $unpackedDirectory "resources\app-dist\index.html"
  if (-not (Test-Path -LiteralPath $executable) -or -not (Test-Path -LiteralPath $rendererIndex)) {
    throw "The packaged directory is incomplete."
  }

  Copy-Item -LiteralPath $unpackedDirectory -Destination $outputDirectory -Recurse

  $commit = (& git -C $repoRoot rev-parse HEAD).Trim()
  $dirty = [bool](& git -C $repoRoot status --porcelain)
  $buildInfo = [ordered]@{
    version = $Version
    target = "windows-x64-directory"
    commit = $commit
    dirty = $dirty
    builtAt = [DateTimeOffset]::Now.ToString("o")
  }
  $buildInfo | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $outputDirectory "build-info.json") -Encoding utf8

  Write-Host "`nBuild complete: $outputDirectory" -ForegroundColor Green
  Write-Host "Run: $(Join-Path $outputDirectory 'Paseo.exe')" -ForegroundColor Green
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
