' Startet it-alarm-mute.ps1 im Hintergrund (versteckt).
' Wird automatisch bei jedem Windows-Login ausgefuehrt (Startup-Ordner).
Set shell = CreateObject("WScript.Shell")
scriptDir = Replace(WScript.ScriptFullName, WScript.ScriptName, "")
shell.Run "powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "it-alarm-mute.ps1""", 0, False
