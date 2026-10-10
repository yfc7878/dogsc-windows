@echo off
chcp 65001 >nul
title DogSC

rem Always work from the folder this file lives in, so it can be launched from
rem anywhere (including a shortcut on the desktop).
cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo.
  echo   首次运行需要先安装依赖，正在执行 npm install ...
  echo.
  call npm install
  if errorlevel 1 goto failed
)

echo.
echo   正在启动 DogSC ...
echo.

rem Prefer the packaged build if it exists, otherwise run from source.
if exist "dist\win-unpacked\DogSC.exe" (
  start "" "dist\win-unpacked\DogSC.exe"
  exit /b 0
)

call npx electron .
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo   启动失败。如果提示显卡或渲染相关错误，请改用软件渲染模式：
echo.
echo       npm start -- --disable-gpu
echo.
pause
