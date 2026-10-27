@echo off
rem Double-click uninstaller for Windows: runs uninstall.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1"
set code=%errorlevel%
echo %cmdcmdline% | findstr /i /c:"%~nx0" >/dev/null && pause
exit /b %code%
