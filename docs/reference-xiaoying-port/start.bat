@echo off
rem Launch DogSC (Windows) from source. First run installs the Electron runtime.
cd /d "%~dp0"
if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing dependencies, this only happens once...
  set "ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/"
  call npm install --registry=https://registry.npmmirror.com
  if errorlevel 1 (
    echo.
    echo Install failed. Check the network and run this file again.
    pause
    exit /b 1
  )
)
start "" "node_modules\electron\dist\electron.exe" .
