@echo off
setlocal
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
del /Q "%DST%it-alarm-mute.vbs" "%DST%it-alarm-mute.ps1" >nul 2>&1
taskkill /im powershell.exe /f >nul 2>&1
echo.
echo  IT-Alarm-Mute deinstalliert und beendet.
echo.
pause
