@echo off
setlocal
set "SETUP=C:\Users\yangming\AppData\Local\Temp\adb-setup.exe"
set "TARGET=C:\Users\yangming\AppData\Local\Programs\ADBAssistant"
if exist "%TARGET%" rd /s /q "%TARGET%"
"%SETUP%" /S /D=%TARGET%
echo [install] rc=%ERRORLEVEL%
if exist "%TARGET%" (echo [install] DIR-OK) else (echo [install] DIR-MISSING)
endlocal
