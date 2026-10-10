@echo off
chcp 65001 >nul
title DogSC（软件渲染）

rem Use this launcher when the normal one flashes and closes immediately, or
rem when the log mentions the GPU process. It disables hardware acceleration so
rem recording and editing still work on machines with a broken or absent
rem graphics driver — slower, but functional.

cd /d "%~dp0"

if not exist "node_modules\electron" (
  echo.
  echo   首次运行需要先安装依赖，正在执行 npm install ...
  echo.
  call npm install
  if errorlevel 1 goto failed
)

echo.
echo   正在以软件渲染模式启动 DogSC ...
echo.

if exist "dist\win-unpacked\DogSC.exe" (
  set DOGSC_SOFTWARE_RENDER=1
  start "" "dist\win-unpacked\DogSC.exe"
  exit /b 0
)

set DOGSC_SOFTWARE_RENDER=1
call npx electron .
if errorlevel 1 goto failed
exit /b 0

:failed
echo.
echo   启动失败，请把上面的错误信息反馈给开发者。
echo.
pause
