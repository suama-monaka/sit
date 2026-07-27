@echo off
setlocal
pushd "%~dp0"
set "SIT_SETUP_FILE=%~f0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$content = [IO.File]::ReadAllText($env:SIT_SETUP_FILE); $marker = ':' + 'SIT_POWERSHELL'; $index = $content.LastIndexOf($marker); if ($index -lt 0) { throw 'Setup payload was not found.' }; Invoke-Expression $content.Substring($index + $marker.Length)"
set "SETUP_EXIT=%ERRORLEVEL%"
set "SIT_SETUP_FILE="
echo.
if "%SETUP_EXIT%"=="0" (
  echo Portable apps setup completed successfully.
) else (
  echo Portable apps setup failed.
)
pause
popd
endlocal & exit /b %SETUP_EXIT%
:SIT_POWERSHELL
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = [IO.Path]::GetFullPath((Get-Location).Path)
$appsRoot = [IO.Path]::GetFullPath((Join-Path $root 'apps'))
$nodeVersion = '24.18.0'
$chromeVersion = '147.0.7727.56'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/download/release/v$nodeVersion/$nodeArchiveName"
$nodeChecksumsUrl = "https://nodejs.org/download/release/v$nodeVersion/SHASUMS256.txt"
$chromeMetadataUrl = "https://googlechromelabs.github.io/chrome-for-testing/$chromeVersion.json"
$nodeDestination = [IO.Path]::GetFullPath((Join-Path $appsRoot 'node'))
$chromeDestination = [IO.Path]::GetFullPath((Join-Path $appsRoot 'chrome'))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $appsRoot ('.setup-' + [guid]::NewGuid().ToString('N'))))

function Assert-InApps([string]$target) {
    $resolved = [IO.Path]::GetFullPath($target)
    if (-not $resolved.StartsWith($appsRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Unsafe apps path: $resolved"
    }
}

function Install-Directory([string]$source, [string]$destination) {
    Assert-InApps $source
    Assert-InApps $destination
    $backup = "$destination.backup-$([guid]::NewGuid().ToString('N'))"
    Assert-InApps $backup
    if (Test-Path -LiteralPath $destination) {
        Move-Item -LiteralPath $destination -Destination $backup
    }
    try {
        Move-Item -LiteralPath $source -Destination $destination
        if (Test-Path -LiteralPath $backup) {
            Remove-Item -LiteralPath $backup -Recurse -Force
        }
    } catch {
        if (Test-Path -LiteralPath $destination) {
            Remove-Item -LiteralPath $destination -Recurse -Force
        }
        if (Test-Path -LiteralPath $backup) {
            Move-Item -LiteralPath $backup -Destination $destination
        }
        throw
    }
}

New-Item -ItemType Directory -Path $appsRoot -Force | Out-Null
New-Item -ItemType Directory -Path $stageRoot | Out-Null

try {
    $installedNode = Join-Path $nodeDestination 'node.exe'
    $nodeReady = $false
    if (Test-Path -LiteralPath $installedNode -PathType Leaf) {
        $detectedNodeVersion = (& $installedNode --version 2>$null)
        $nodeReady = $detectedNodeVersion -eq "v$nodeVersion"
    }

    if ($nodeReady) {
        Write-Host "Node.js v$nodeVersion is already ready."
    } else {
        Write-Host "Downloading Node.js v$nodeVersion..."
        $nodeArchive = Join-Path $stageRoot $nodeArchiveName
        $checksumsPath = Join-Path $stageRoot 'SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri $nodeUrl -OutFile $nodeArchive
        Invoke-WebRequest -UseBasicParsing -Uri $nodeChecksumsUrl -OutFile $checksumsPath
        $checksumLine = Get-Content -LiteralPath $checksumsPath | Where-Object {
            $_ -match ("^[a-fA-F0-9]{64}\s+" + [regex]::Escape($nodeArchiveName) + "$")
        } | Select-Object -First 1
        if (-not $checksumLine) {
            throw 'Node.js checksum entry was not found.'
        }
        $expectedHash = ($checksumLine -split '\s+')[0].ToUpperInvariant()
        $actualHash = (Get-FileHash -LiteralPath $nodeArchive -Algorithm SHA256).Hash.ToUpperInvariant()
        if ($actualHash -ne $expectedHash) {
            throw 'Node.js archive checksum verification failed.'
        }
        $nodeExtract = Join-Path $stageRoot 'node-extract'
        Expand-Archive -LiteralPath $nodeArchive -DestinationPath $nodeExtract
        $nodeSource = Join-Path $nodeExtract "node-v$nodeVersion-win-x64"
        if (-not (Test-Path -LiteralPath (Join-Path $nodeSource 'node.exe') -PathType Leaf)) {
            throw 'Extracted Node.js executable was not found.'
        }
        Install-Directory $nodeSource $nodeDestination
        Write-Host 'Node.js download and verification completed.'
    }

    $installedChrome = Join-Path $chromeDestination 'chrome.exe'
    $chromeReady = $false
    if (Test-Path -LiteralPath $installedChrome -PathType Leaf) {
        $detectedChromeVersion = (Get-Item -LiteralPath $installedChrome).VersionInfo.ProductVersion
        $chromeReady = $detectedChromeVersion -eq $chromeVersion
    }

    if ($chromeReady) {
        Write-Host "Chrome for Testing $chromeVersion is already ready."
    } else {
        Write-Host "Downloading Chrome for Testing $chromeVersion..."
        $metadata = Invoke-RestMethod -Uri $chromeMetadataUrl
        if ($metadata.version -ne $chromeVersion) {
            throw 'Chrome metadata version mismatch.'
        }
        $chromeDownload = @($metadata.downloads.chrome | Where-Object { $_.platform -eq 'win64' }) | Select-Object -First 1
        if (-not $chromeDownload -or -not $chromeDownload.url) {
            throw 'Chrome win64 download URL was not found.'
        }
        $chromeArchive = Join-Path $stageRoot 'chrome-win64.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $chromeDownload.url -OutFile $chromeArchive
        $chromeExtract = Join-Path $stageRoot 'chrome-extract'
        Expand-Archive -LiteralPath $chromeArchive -DestinationPath $chromeExtract
        $chromeSource = Join-Path $chromeExtract 'chrome-win64'
        $chromeExecutable = Join-Path $chromeSource 'chrome.exe'
        if (-not (Test-Path -LiteralPath $chromeExecutable -PathType Leaf)) {
            throw 'Extracted Chrome executable was not found.'
        }
        $downloadedChromeVersion = (Get-Item -LiteralPath $chromeExecutable).VersionInfo.ProductVersion
        if ($downloadedChromeVersion -ne $chromeVersion) {
            throw 'Downloaded Chrome version verification failed.'
        }
        Install-Directory $chromeSource $chromeDestination
        Write-Host 'Chrome download and version verification completed.'
    }

    $portableNode = Join-Path $nodeDestination 'node.exe'
    $portableNpm = Join-Path $nodeDestination 'npm.cmd'
    $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
    $dependencyCheck = @'
require('express');
require('puppeteer');
require('sql.js');
'@
    $dependencyCheck | & $portableNode -
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'Downloading project dependencies...'
        & $portableNpm ci --omit=dev
        if ($LASTEXITCODE -ne 0) {
            throw 'Project dependency download failed.'
        }
        $dependencyCheck | & $portableNode -
        if ($LASTEXITCODE -ne 0) {
            throw 'Project dependency verification failed.'
        }
    }

    $finalNodeVersion = (& $portableNode --version)
    $finalChromeVersion = (Get-Item -LiteralPath (Join-Path $chromeDestination 'chrome.exe')).VersionInfo.ProductVersion
    if ($finalNodeVersion -ne "v$nodeVersion" -or $finalChromeVersion -ne $chromeVersion) {
        throw 'Portable apps final verification failed.'
    }
    Write-Host "Node.js: $finalNodeVersion"
    Write-Host "Chrome: $finalChromeVersion"
} finally {
    Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
    Assert-InApps $stageRoot
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
