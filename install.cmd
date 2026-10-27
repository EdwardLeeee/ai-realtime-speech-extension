@echo off
rem Double-click installer for Windows: installs uv if missing, then runs install.ps1 (see README).
setlocal
cd /d "%~dp0"
where uv >/dev/null 2>nul
if errorlevel 1 (
  echo uv not found, installing uv first...
  where winget >/dev/null 2>nul
  if not errorlevel 1 winget install --id=astral-sh.uv -e --accept-source-agreements --accept-package-agreements
  set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%USERPROFILE%\.local\bin;%PATH%"
)
where uv >/dev/null 2>nul
if errorlevel 1 powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://astral.sh/uv/install.ps1 | iex"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
set code=%errorlevel%
rem Keep the window open when started by double-click (not when run from a terminal or CI).
echo %cmdcmdline% | findstr /i /c:"%~nx0" >/dev/null && pause
exit /b %code%
