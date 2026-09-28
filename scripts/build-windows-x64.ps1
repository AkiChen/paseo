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

  # Expo inlines EXPO_PUBLIC_* values during the Babel transform, and the inlined
  # value is not part of Metro's cache key. A warm cache keeps the first value it
  # saw, which is how the custom.4 and custom.5 directories shipped a renderer
  # that still reported 0.8.0-custom.3. LOCAL_DAEMON and the dev build label are
  # inlined the same way, so a stale cache can also bake an old daemon endpoint
  # into a release build. --clear costs one cold transform per build.
  Invoke-BuildStep `
    -Label "Export Electron renderer" `
    -WorkingDirectory $appRoot `
    -Command $npxCommand `
    -Arguments @("expo", "export", "--platform", "web", "--clear")

  # The renderer reports this version in the UI, so a version that never reached
  # the bundle is a silent failure worth stopping for.
  $rendererBundleDirectory = Join-Path $appRoot "dist\_expo\static\js\web"
  $rendererBundles = @(Get-ChildItem -LiteralPath $rendererBundleDirectory -Filter "index-*.js")
  $bundleReportsVersion = $false
  foreach ($rendererBundle in $rendererBundles) {
    if ([IO.File]::ReadAllText($rendererBundle.FullName).Contains($Version)) {
      $bundleReportsVersion = $true
      break
    }
  }
  if (-not $bundleReportsVersion) {
    throw "The exported renderer does not report version $Version."
  }

  Invoke-BuildStep `
    -Label "Build bundled server and CLI" `
    -WorkingDirectory $repoRoot `
    -Command $npmCommand `
    -Arguments @("run", "build:server:clean")

  # tsc keeps the output of files that no longer exist, and electron-builder packs
  # whatever is in dist: a renamed or removed source file leaves its compiled copy
  # in the asar. A fresh checkout never hits this, a repeated local build does.
  $desktopDist = Join-Path $desktopRoot "dist"
  if (Test-Path -LiteralPath $desktopDist) {
    Remove-Item -LiteralPath $desktopDist -Recurse -Force
  }
  # The build info has to go with it. Left behind, tsc considers the deleted
  # output current, writes nothing, and electron-builder fails with a missing
  # entry file ten minutes later.
  $desktopBuildInfo = Join-Path $desktopRoot "tsconfig.tsbuildinfo"
  if (Test-Path -LiteralPath $desktopBuildInfo) {
    Remove-Item -LiteralPath $desktopBuildInfo -Force
  }

  Invoke-BuildStep `
    -Label "Build Electron main process" `
    -WorkingDirectory $desktopRoot `
    -Command $npmCommand `
    -Arguments @("run", "build:main")

  $desktopEntry = Join-Path $desktopDist "main.js"
  if (-not (Test-Path -LiteralPath $desktopEntry)) {
    throw "The Electron main process build produced no dist/main.js."
  }

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

  # Copy-Item fails once the packaged tree plus the output path passes MAX_PATH:
# the renderer carries assets under `assets/__node_modules/@react-navigation/...`
# whose depth is fixed, so a long build-number pushes the copy over the limit and
# the whole build dies at the last step. robocopy handles long paths itself.
  & robocopy $unpackedDirectory $outputDirectory /E /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) {
    throw "Failed to copy the packaged directory (robocopy exit code $LASTEXITCODE)."
  }

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
