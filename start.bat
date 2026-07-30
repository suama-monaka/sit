@echo off
setlocal EnableDelayedExpansion
pushd "%~dp0"
set "PORTABLE_NODE=%~dp0apps\node\node.exe"
set "PORTABLE_CHROME=%~dp0apps\chrome\chrome.exe"
set "NODE_EXE="
set "CHROME_EXE="
set "CHROME_SOURCE=system"

for /f "usebackq delims=" %%N in (`powershell.exe -NoProfile -Command "$c=Get-Command node.exe -ErrorAction SilentlyContinue;if($c){try{$v=[version](Get-Item -LiteralPath $c.Source).VersionInfo.ProductVersion;if($v.Major -ge 20){$c.Source}}catch{}}"`) do set "NODE_EXE=%%N"
if not defined NODE_EXE if exist "%PORTABLE_NODE%" set "NODE_EXE=%PORTABLE_NODE%"
if not defined NODE_EXE (
  echo Node.js 20 or newer was not found.
  echo Run environment setup first.
  pause
  popd
  endlocal & exit /b 1
)

set "SERVER_SECRET_FILE="
if not defined SIT_SERVER_SECRET (
  if not defined LOCALAPPDATA (
    echo LocalAppData was not found.
    pause
    popd
    endlocal & exit /b 1
  )
  set "SERVER_SECRET_FILE=%LOCALAPPDATA%\SIT-Dashboard\server-secret.dpapi"
  if not exist "!SERVER_SECRET_FILE!" (
    echo Server secret was not found.
    echo Stop the server and run environment setup to create it and migrate databases.
    pause
    popd
    endlocal & exit /b 1
  )
) else (
  powershell.exe -NoProfile -Command "if($env:SIT_SERVER_SECRET -notmatch '^[a-fA-F0-9]{64}$'){exit 1}"
  if errorlevel 1 (
    echo Server secret verification failed.
    pause
    popd
    endlocal & exit /b 1
  )
)

if defined PUPPETEER_EXECUTABLE_PATH if exist "%PUPPETEER_EXECUTABLE_PATH%" set "CHROME_EXE=%PUPPETEER_EXECUTABLE_PATH%"
if not defined CHROME_EXE for /f "usebackq delims=" %%C in (`powershell.exe -NoProfile -Command "$p=@();$r=@('HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe','HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe');foreach($k in $r){try{$p+=(Get-ItemPropertyValue -LiteralPath $k -Name '(default)' -ErrorAction Stop)}catch{}};$p+=@((Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),(Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),(Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'));foreach($x in $p){if($x -and (Test-Path -LiteralPath $x)){try{$m=[int]((Get-Item -LiteralPath $x).VersionInfo.ProductVersion.Split('.')[0]);if($m -ge 151){$x;break}}catch{}}}"`) do set "CHROME_EXE=%%C"

if not defined CHROME_EXE (
  set "CHROME_SOURCE=portable"
  if not exist "%PORTABLE_CHROME%" (
    echo Chrome 151 or newer was not found.
    echo Run environment setup first.
    pause
    popd
    endlocal & exit /b 1
  )
  if not defined LOCALAPPDATA (
    echo LocalAppData was not found.
    pause
    popd
    endlocal & exit /b 1
  )
  for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "$v=(Get-Item -LiteralPath $env:PORTABLE_CHROME).VersionInfo.ProductVersion;if($v -match '^\d+(\.\d+){3}$'){$v}"`) do set "CHROME_VERSION=%%V"
  if not defined CHROME_VERSION (
    echo Portable Chrome version verification failed.
    pause
    popd
    endlocal & exit /b 1
  )
  set "LOCAL_CHROME_DIR=%LOCALAPPDATA%\SIT-Dashboard\chrome-!CHROME_VERSION!"
  set "LOCAL_CHROME_EXE=!LOCAL_CHROME_DIR!\chrome.exe"
  if not exist "!LOCAL_CHROME_DIR!" mkdir "!LOCAL_CHROME_DIR!"
  robocopy "%~dp0apps\chrome" "!LOCAL_CHROME_DIR!" /E /XO /R:2 /W:1 /NFL /NDL /NJH /NJS /NP >nul

  if errorlevel 8 (
    echo Portable Chrome local copy failed.
    pause
    popd
    endlocal & exit /b 1
  )
  powershell.exe -NoProfile -Command "if(-not (Test-Path -LiteralPath $env:LOCAL_CHROME_EXE)){exit 1};if((Get-Item -LiteralPath $env:LOCAL_CHROME_EXE).VersionInfo.ProductVersion -ne $env:CHROME_VERSION){exit 1}"
  if errorlevel 1 (
    echo Local Chrome version verification failed.
    pause
    popd
    endlocal & exit /b 1
  )
  set "CHROME_EXE=!LOCAL_CHROME_EXE!"
)

"%NODE_EXE%" -e "require('express');require('puppeteer');require('sql.js')" >nul 2>&1
if errorlevel 1 (
  echo Project dependencies were not found.
  echo Run environment setup first.
  pause
  popd
  endlocal & exit /b 1
)

set "PUPPETEER_EXECUTABLE_PATH=%CHROME_EXE%"
echo Node.js: %NODE_EXE%
echo Chrome: %CHROME_EXE%
echo Chrome source: %CHROME_SOURCE%
if defined SIT_SERVER_SECRET (
  "%NODE_EXE%" server.js
  set "SERVER_EXIT=!ERRORLEVEL!"
) else (
  set "SIT_SERVER_SECRET_STDIN=1"
  powershell.exe -NoProfile -Command "Add-Type -AssemblyName System.Security;$e=[Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes('SIT-Dashboard server secret v1'));$p=[System.Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($env:SERVER_SECRET_FILE),$e,[Security.Cryptography.DataProtectionScope]::CurrentUser);-join ($p|ForEach-Object{$_.ToString('x2')})" | "%NODE_EXE%" server.js
  set "SERVER_EXIT=!ERRORLEVEL!"
)
popd
endlocal & exit /b %SERVER_EXIT%
