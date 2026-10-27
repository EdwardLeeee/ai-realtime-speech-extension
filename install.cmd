@echo off
rem Double-click installer for Windows (when not using Setup.exe): runs install.ps1, which also installs uv if missing.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%errorlevel%
rem Keep the window open when started by double-click (not when run from a terminal or CI).
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && pause
exit /b %code%
