@echo off
rem 以 --memory-probe 启动已安装的 ADB 桌面助手。
rem 探针每 30s 采一次：主进程工作集/堆、渲染进程、GPU、logcat 缓冲行数，
rem 写运行日志（设置页「打开日志文件夹」）与 %APPDATA%\adb-assistant\memory-probe.jsonl。
rem 只在手动带参数启动时生效；正常双击图标不采样、零开销。
rem
rem 注意：在带 ELECTRON_RUN_AS_NODE=1 的终端里直接调 exe，Electron 会被当成 node
rem （无参静默退出、带参数报 bad option），所以这里先把它清掉。
setlocal
set "ELECTRON_RUN_AS_NODE="
set "EXE=%LOCALAPPDATA%\Programs\ADBAssistant\ADB桌面助手.exe"
if not exist "%EXE%" (
  echo [x] 没找到已安装的程序：%EXE%
  echo     先跑 scripts\install-local.py 装一次，或改这里的路径。
  pause
  exit /b 1
)
start "" "%EXE%" --memory-probe
echo [ok] 已启动（内存探针开启），采样写入：
echo      %APPDATA%\adb-assistant\memory-probe.jsonl
