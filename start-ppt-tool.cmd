@echo off
cd /d "%~dp0"
echo Starting PPT Design Tool...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-local.ps1"
if errorlevel 1 (
  echo.
  echo Startup failed. Check the message above.
)
pause
