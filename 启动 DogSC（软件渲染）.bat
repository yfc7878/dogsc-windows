@echo off
rem 「启动 DogSC（软件渲染）」——转发到同目录的主脚本 DogSC.bat，
rem 只是额外设置 DOGSC_SOFTWARE_RENDER=1，让应用改用软件渲染。
rem 显卡驱动异常、启动一闪即退、日志提到 GPU 进程时使用本脚本。
set DOGSC_SOFTWARE_RENDER=1
call "%~dp0DogSC.bat" %*
