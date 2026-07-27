@echo off
pushd "%~dp0"
node server.js
set "SERVER_EXIT=%ERRORLEVEL%"
popd
exit /b %SERVER_EXIT%