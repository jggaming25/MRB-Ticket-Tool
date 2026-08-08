@echo off
setlocal
set "SRC=%~dp0"
set "DST=%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup"
copy /Y "%SRC%it-alarm-mute.ps1" "%DST%" >nul
copy /Y "%SRC%it-alarm-mute.vbs" "%DST%" >nul
echo.
echo  IT-Alarm-Mute installiert.
echo  Das Skript startet ab jetzt automatisch bei jedem Windows-Login im Hintergrund
echo  und schaltet waehrend eines IT-Alarms alle anderen Sounds stumm
echo  (der TicketSystem-Tab darf weiterhin die Sirene spielen).
echo.
echo  Beenden/Deinstallieren: uninstall-it-alarm-mute.bat ausfuehren.
echo.
pause
