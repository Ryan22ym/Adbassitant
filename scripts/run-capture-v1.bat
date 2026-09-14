@echo off
REM 清除 ELECTRON_RUN_AS_NODE 后启动 Electron（否则会以纯 Node 模式运行）
set "ELECTRON_RUN_AS_NODE="
cd /d "%~dp0.."
"%~dp0..\node_modules\electron\dist\electron.exe" "%~dp0capture-v1-pages.cjs"
exit /b %ERRORLEVEL%
