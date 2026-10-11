@echo off
rem ============================================================
rem  DogSC-Windows launcher
rem  Double-click to start the app. To open a project directly:
rem    DogSC.bat "D:\path\to\something.dogscproject"
rem ============================================================
chcp 65001 >nul
cd /d "%~dp0"
rem Some terminals export ELECTRON_RUN_AS_NODE=1, which turns the
rem Electron binary into a plain Node process; clear it so the app
rem window can actually open.
set ELECTRON_RUN_AS_NODE=
"%~dp0node_modules\.bin\electron.cmd" . %*
echo.
echo [DogSC] app exited.
if errorlevel 1 (
  echo [DogSC] exited with an error. Press any key to close this window.
  pause >nul
)
