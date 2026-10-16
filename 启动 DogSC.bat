@echo off
rem 「启动 DogSC」——转发到同目录的主脚本 DogSC.bat。
rem 启动逻辑只维护主脚本一份，本文件等价于一个软链接。
call "%~dp0DogSC.bat" %*
