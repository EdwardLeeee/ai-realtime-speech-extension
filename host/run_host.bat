@echo off
rem Browser starts this via native messaging (Windows); runs the host with the project .venv Python.
"%~dp0.venv\Scripts\python.exe" -u "%~dp0transcriber_host.py" %*
