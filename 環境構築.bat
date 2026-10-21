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
Add-Type -AssemblyName System.Security

$root = [IO.Path]::GetFullPath((Get-Location).Path)
$appsRoot = [IO.Path]::GetFullPath((Join-Path $root 'apps'))
$nodeVersion = '24.18.0'
$chromeVersion = '151.0.7922.47'
$nodeArchiveName = "node-v$nodeVersion-win-x64.zip"
$nodeUrl = "https://nodejs.org/download/release/v$nodeVersion/$nodeArchiveName"
$nodeChecksumsUrl = "https://nodejs.org/download/release/v$nodeVersion/SHASUMS256.txt"
$chromeMetadataUrl = "https://googlechromelabs.github.io/chrome-for-testing/$chromeVersion.json"
$nodeDestination = [IO.Path]::GetFullPath((Join-Path $appsRoot 'node'))
$chromeDestination = [IO.Path]::GetFullPath((Join-Path $appsRoot 'chrome'))
$stageRoot = [IO.Path]::GetFullPath((Join-Path $appsRoot ('.setup-' + [guid]::NewGuid().ToString('N'))))
$serverSecretCreated = $false
if ([string]::IsNullOrWhiteSpace($env:SIT_SERVER_SECRET)) {
    $serverSecretDirectory = Join-Path $root 'SIT-Dashboard'
    $serverSecretPath = Join-Path $serverSecretDirectory 'server-secret.key'
    if (Test-Path -LiteralPath $serverSecretPath -PathType Leaf) {
        $env:SIT_SERVER_SECRET = [IO.File]::ReadAllText($serverSecretPath).Trim()
    } else {
        New-Item -ItemType Directory -Path $serverSecretDirectory -Force | Out-Null
        $serverSecretBytes = $null
        $entropy = $null
        try {
            $entropyProvider = [Security.Cryptography.SHA256]::Create()
            try {
                $entropy = $entropyProvider.ComputeHash(
                    [Text.Encoding]::UTF8.GetBytes('SIT-Dashboard server secret v1')
                )
            } finally {
                $entropyProvider.Dispose()
            }
            $legacyCandidates = @(
                (Join-Path $serverSecretDirectory 'server-secret.dpapi')
            )
            if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
                $legacyCandidates += Join-Path $env:LOCALAPPDATA 'SIT-Dashboard\server-secret.dpapi'
            }
            foreach ($legacyPath in @($legacyCandidates | Select-Object -Unique)) {
                if (-not (Test-Path -LiteralPath $legacyPath -PathType Leaf)) {
                    continue
                }
                try {
                    $candidate = [System.Security.Cryptography.ProtectedData]::Unprotect(
                        [IO.File]::ReadAllBytes($legacyPath),
                        $entropy,
                        [Security.Cryptography.DataProtectionScope]::CurrentUser
                    )
                    if ($candidate.Length -eq 32) {
                        $serverSecretBytes = $candidate
                        Write-Host "Imported the legacy server secret into $serverSecretPath"
                        break
                    }
                    [Array]::Clear($candidate, 0, $candidate.Length)
                } catch {
                    Write-Warning "Legacy server secret could not be read on this PC: $legacyPath"
                }
            }
            if (-not $serverSecretBytes) {
                $serverSecretBytes = New-Object byte[] 32
                $randomGenerator = [Security.Cryptography.RandomNumberGenerator]::Create()
                try {
                    $randomGenerator.GetBytes($serverSecretBytes)
                } finally {
                    $randomGenerator.Dispose()
                }
                $serverSecretCreated = $true
                Write-Host "Created a portable server secret at $serverSecretPath"
            }
            $env:SIT_SERVER_SECRET = -join ($serverSecretBytes | ForEach-Object { $_.ToString('x2') })
            [IO.File]::WriteAllText(
                $serverSecretPath,
                $env:SIT_SERVER_SECRET,
                [Text.UTF8Encoding]::new($false)
            )
        } finally {
            if ($serverSecretBytes) {
                [Array]::Clear($serverSecretBytes, 0, $serverSecretBytes.Length)
            }
            if ($entropy) {
                [Array]::Clear($entropy, 0, $entropy.Length)
            }
        }
    }
}
if ($env:SIT_SERVER_SECRET -notmatch '^[a-fA-F0-9]{64}$') {
    throw 'Server secret verification failed.'
}

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
        $chromeDownloadUri = [Uri]$chromeDownload.url
        $expectedChromePath = "/chrome-for-testing-public/$chromeVersion/win64/chrome-win64.zip"
        if (
            $chromeDownloadUri.Scheme -ne 'https' -or
            $chromeDownloadUri.Host -ne 'storage.googleapis.com' -or
            $chromeDownloadUri.AbsolutePath -ne $expectedChromePath -or
            $chromeDownloadUri.Query -or
            $chromeDownloadUri.Fragment -or
            $chromeDownloadUri.UserInfo
        ) {
            throw 'Chrome download URL is not an approved Google storage URL.'
        }
        $chromeArchive = Join-Path $stageRoot 'chrome-win64.zip'
        Invoke-WebRequest -UseBasicParsing -Uri $chromeDownloadUri.AbsoluteUri -OutFile $chromeArchive
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
    Write-Host 'Running npm install...'
    & $portableNpm install --omit=dev --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) {
        throw 'npm install failed.'
    }
    $dependencyCheck = @'
require('express');
require('puppeteer');
require('sql.js');
'@
    $dependencyCheck | & $portableNode -
    if ($LASTEXITCODE -ne 0) {
        throw 'Project dependency verification failed.'
    }
    $adminConfigPath = Join-Path $root 'config\admin-public-key.bin'
    if (-not (Test-Path -LiteralPath $adminConfigPath -PathType Leaf)) {
        Write-Host 'Administrator public configuration is not initialized.'
        $firstSecureKey = Read-Host 'Administrator decryption key' -AsSecureString
        $secondSecureKey = Read-Host 'Enter the administrator decryption key again' -AsSecureString
        try {
            $firstCredential = [Net.NetworkCredential]::new('', $firstSecureKey)
            $secondCredential = [Net.NetworkCredential]::new('', $secondSecureKey)
            if ($firstCredential.Password.Length -lt 12 -or $firstCredential.Password -cne $secondCredential.Password) {
                throw 'Administrator key confirmation failed.'
            }
            $env:SIT_ADMIN_DECRYPTION_KEY = $firstCredential.Password
            try {
                $adminConfigInitializer = @'
const path = require('path');
const {
    ADMIN_KEY_ENV,
    writeAdminPublicConfig
} = require('./logic/dual-key-cache-store');
writeAdminPublicConfig(
    path.join(process.cwd(), 'config', 'admin-public-key.bin'),
    process.env[ADMIN_KEY_ENV]
);
'@
                $adminConfigInitializer | & $portableNode -
                if ($LASTEXITCODE -ne 0) {
                    throw 'Administrator public configuration initialization failed.'
                }
                Write-Host 'Administrator public configuration was created.'
            } finally {
                Remove-Item Env:SIT_ADMIN_DECRYPTION_KEY -ErrorAction SilentlyContinue
            }
        } finally {
            $firstCredential = $null
            $secondCredential = $null
            $firstSecureKey.Dispose()
            $secondSecureKey.Dispose()
        }
    }
    $databaseFiles = @(
        Get-ChildItem -LiteralPath (Join-Path $root 'cache') -Filter '*.db' -File -ErrorAction SilentlyContinue |
            Where-Object { $_.BaseName -cmatch '^[A-Z0-9_-]{1,64}$' }
    )
    $migrationRequired = $serverSecretCreated -and $databaseFiles.Count -gt 0
    foreach ($databaseFile in $databaseFiles) {
        $stream = [IO.File]::Open(
            $databaseFile.FullName,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        try {
            if ($stream.ReadByte() -ne 3) {
                $migrationRequired = $true
            }
        } finally {
            $stream.Dispose()
        }
    }
    if ($migrationRequired) {
        Write-Host 'Encrypted database migration is required.'
        $migrationSecureKey = Read-Host 'Administrator decryption key' -AsSecureString
        try {
            $migrationCredential = [Net.NetworkCredential]::new('', $migrationSecureKey)
            $env:SIT_ADMIN_DECRYPTION_KEY = $migrationCredential.Password
            & $portableNode 'Admin\migrate-encryption.js'
            if ($LASTEXITCODE -ne 0) {
                throw 'Encrypted database migration failed.'
            }
        } finally {
            Remove-Item Env:SIT_ADMIN_DECRYPTION_KEY -ErrorAction SilentlyContinue
            $migrationCredential = $null
            $migrationSecureKey.Dispose()
        }
    }
    if ($serverSecretCreated) {
        $loginAuditPath = Join-Path $root 'cache\data.db'
        if (Test-Path -LiteralPath $loginAuditPath -PathType Leaf) {
            $loginAuditBackup = Join-Path $root (
                'cache\data.server-secret-replaced-' +
                [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' +
                [guid]::NewGuid().ToString('N') + '.bak'
            )
            Move-Item -LiteralPath $loginAuditPath -Destination $loginAuditBackup
            Write-Warning "The old login audit database was archived at $loginAuditBackup"
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
    Remove-Item Env:SIT_ADMIN_DECRYPTION_KEY -ErrorAction SilentlyContinue
    Remove-Item Env:SIT_SERVER_SECRET -ErrorAction SilentlyContinue
    Remove-Item Env:PUPPETEER_SKIP_DOWNLOAD -ErrorAction SilentlyContinue
    Assert-InApps $stageRoot
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
