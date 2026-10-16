@echo off
setlocal
chcp 65001 >nul
title DogSC

rem ============================================================
rem  DogSC-Windows 启动脚本（主脚本）
rem
rem  双击即可启动；也可以带项目路径参数直接打开项目：
rem      DogSC.bat "D:\path\to\something.dogscproject"
rem
rem  同目录的另外两个脚本只是转发到这里，启动逻辑只维护这一份：
rem      「启动 DogSC.bat」             普通启动
rem      「启动 DogSC（软件渲染）.bat」  显卡驱动异常时使用
rem
rem  启动方式选择：
rem    依赖已装好（node_modules 存在）就从源码启动，永远是最新代码；
rem    否则若有打包版（dist 目录）就启动打包版；
rem    都没有就先自动安装依赖再启动。
rem  环境变量：DOGSC_USE_PACKAGED=1 强制启动打包版；
rem    DOGSC_SOFTWARE_RENDER=1 用软件渲染；DOGSC_NOSTART=1 只自检不启动。
rem ============================================================

rem ---- 找到项目根目录 ----
set "ROOT=%~dp0"
if exist "%ROOT%package.json" goto root-ok
for /f "usebackq delims=" %%T in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "$t = (Get-Item -LiteralPath '%~f0').Target; if ($t) { [Console]::Write($t) }"`) do set "REAL=%%T"
if defined REAL for %%D in ("%REAL%") do set "ROOT=%%~dpD"
if exist "%ROOT%package.json" goto root-ok
echo   找不到项目文件（package.json），无法启动。
echo   请把本脚本放回项目根目录后重试。
echo   当前查找的位置：%ROOT%
echo.
pause
exit /b 1

:root-ok
cd /d "%ROOT%"
rem 某些终端或 IDE 会设置 ELECTRON_RUN_AS_NODE=1，它会把 Electron
rem 变成普通 Node 进程而开不出窗口，这里清掉。
set ELECTRON_RUN_AS_NODE=

rem ---- 选择启动方式 ----
if /i "%DOGSC_USE_PACKAGED%"=="1" goto packaged
if exist "%ROOT%node_modules\electron" goto source
if exist "%ROOT%dist\win-unpacked\DogSC.exe" goto packaged
goto install

:install
echo   首次运行：正在安装依赖（npm install），需要联网，约 1-2 分钟 ...
call npm install
if not errorlevel 1 goto source
echo.
echo   依赖安装失败：请检查网络后重试；若尚未安装 Node.js，请先安装 Node 18 以上版本。
pause
exit /b 1

:packaged
if exist "%ROOT%dist\win-unpacked\DogSC.exe" goto packaged-run
echo   未找到打包版：%ROOT%dist\win-unpacked\DogSC.exe
echo   请先执行：npm run dist
pause
exit /b 1

:packaged-run
echo   正在启动 DogSC（打包版）...
if defined DOGSC_NOSTART goto selfcheck
start "" "%ROOT%dist\win-unpacked\DogSC.exe" %*
exit /b 0

:source
echo   正在从源码启动 DogSC ...
if defined DOGSC_NOSTART goto selfcheck
call "%ROOT%node_modules\.bin\electron.cmd" . %*
if not errorlevel 1 goto done
echo.
echo   启动失败。如果错误信息里提到显卡（GPU），或窗口一闪即退，
echo   请改用同目录的「启动 DogSC（软件渲染）.bat」重试。
pause
exit /b 1

:selfcheck
echo   [DOGSC_NOSTART] 脚本解析自检通过（未真正启动应用）。
exit /b 0

:done
exit /b 0
