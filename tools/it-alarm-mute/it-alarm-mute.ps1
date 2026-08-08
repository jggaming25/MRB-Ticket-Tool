<#
  it-alarm-mute.ps1
  =================
  Schaltet während eines aktiven IT-Alarms alle Audio-Ausgaben auf dem PC
  stumm - mit einer Ausnahme: Der Browser-Tab, der das TicketSystem (MRB)
  anzeigt, darf weiterhin die Sirene spielen (erkannt am Seitentitel).

  Funktionsweise:
    - Pollt alle X Sekunden den oeffentlichen Status (GET /api/status).
    - Sobald "lockdown.enabled" = true  -> alle Audio-Sessions stummschalten,
      ausser denen mit dem Namen des TicketSystems im Seitentitel.
    - Sobald "lockdown.enabled" = false -> alle Sessions wieder einschalten.

  Keine Zusatztools noetig (reines PowerShell + Windows Core Audio API).

  Aufruf:
    powershell -NoProfile -ExecutionPolicy Bypass -File .\it-alarm-mute.ps1
    powershell -NoProfile -ExecutionPolicy Bypass -File .\it-alarm-mute.ps1 -DryRun
    powershell -NoProfile -ExecutionPolicy Bypass -File .\it-alarm-mute.ps1 -DryRun -SimulateLocked
#>
param(
  [string]$Url      = "https://ticketsystem-mrb.onrender.com/api/status",
  [string]$Keep     = "TicketSystem MRB",
  [int]$IntervalSec = 3,
  [switch]$DryRun,
  [switch]$SimulateLocked
)

$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# Windows Core Audio API - COM-Logik in C# (verlaesslich per Add-Type)
# ---------------------------------------------------------------------------
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public static class AudioMute
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string pwstrId, out IMMDevice ppDevice);
        int RegisterEndpointNotificationCallback(IntPtr pClient);
        int UnregisterEndpointNotificationCallback(IntPtr pClient);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        int Activate(Guid iid, int clsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
        int OpenPropertyStore(int access, IntPtr ppProperties);
        int GetId([MarshalAs(UnmanagedType.LPWStr)] out string ppstrId);
        int GetState(out int pdwState);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
        int GetAudioSessionControl(IntPtr AudioSessionGuid, uint SessionFlags, out IntPtr SessionControl);
        int GetSimpleAudioVolume(IntPtr AudioSessionGuid, uint SessionFlags, out IntPtr AudioVolume);
        int GetSessionEnumerator(out IAudioSessionEnumerator SessionEnum);
        int RegisterSessionNotification(IntPtr SessionNotif);
        int UnregisterSessionNotification(IntPtr SessionNotif);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionEnumerator
    {
        int GetCount(out int Count);
        int GetSession(int SessionIndex, out IAudioSessionControl Session);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionControl
    {
        int GetState(out int State);
        int GetDisplayName(out IntPtr Name);
        int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string Value, IntPtr EventContext);
        int GetIconPath(out IntPtr Path);
        int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string Value, IntPtr EventContext);
        int GetGroupingParam(out Guid GroupingParam);
        int SetGroupingParam(IntPtr Override, IntPtr EventContext);
        int RegisterAudioSessionNotification(IntPtr Notify);
        int UnregisterAudioSessionNotification(IntPtr Notify);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface ISimpleAudioVolume
    {
        int SetMasterVolume(float fLevel, IntPtr EventContext);
        int GetMasterVolume(out float pfLevel);
        int SetMute(int bMute, IntPtr EventContext);
        int GetMute(out int pbMute);
    }

    private static readonly Guid SimpleAudioVolumeIid = new Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8");
    private static readonly Guid SessionManager2Iid = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
    private const int CLSCTX_ALL = 23;

    public class SessionInfo
    {
        public string Name;
        public uint Pid;
        public IntPtr VolumePtr;
    }

    public static List<SessionInfo> GetSessions()
    {
        var list = new List<SessionInfo>();
        var enumerator = (IMMDeviceEnumerator)(object)new MMDeviceEnumerator();
        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(0, 1, out device);
        if (hr != 0 || device == null) throw new COMException("GetDefaultAudioEndpoint: 0x" + hr.ToString("X8"));

        object mgrObj;
        hr = device.Activate(SessionManager2Iid, CLSCTX_ALL, IntPtr.Zero, out mgrObj);
        if (hr != 0 || mgrObj == null) throw new COMException("Activate IAudioSessionManager2: 0x" + hr.ToString("X8"));
        var mgr = (IAudioSessionManager2)mgrObj;

        IAudioSessionEnumerator sesEnum;
        hr = mgr.GetSessionEnumerator(out sesEnum);
        if (hr != 0 || sesEnum == null) throw new COMException("GetSessionEnumerator: 0x" + hr.ToString("X8"));

        int count;
        sesEnum.GetCount(out count);
        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctrl;
            if (sesEnum.GetSession(i, out ctrl) != 0 || ctrl == null) continue;
            var info = new SessionInfo();
            try
            {
                IntPtr namePtr;
                ctrl.GetDisplayName(out namePtr);
                if (namePtr != IntPtr.Zero)
                {
                    info.Name = Marshal.PtrToStringUni(namePtr) ?? "";
                    Marshal.FreeCoTaskMem(namePtr);
                }
            }
            catch { }

            IntPtr volPtr = IntPtr.Zero;
            IntPtr ctrlPtr = Marshal.GetIUnknownForObject(ctrl);
            try
            {
                Guid iid = SimpleAudioVolumeIid;
                int qhr = Marshal.QueryInterface(ctrlPtr, ref iid, out volPtr);
                if (qhr != 0) volPtr = IntPtr.Zero;
            }
            finally
            {
                Marshal.Release(ctrlPtr);
            }
            info.VolumePtr = volPtr;
            list.Add(info);
        }
        return list;
    }

    public static void SetMute(SessionInfo s, bool mute)
    {
        if (s.VolumePtr == IntPtr.Zero) return;
        var vol = (ISimpleAudioVolume)Marshal.GetObjectForIUnknown(s.VolumePtr);
        vol.SetMute(mute ? 1 : 0, IntPtr.Zero);
    }

    public static void Release(SessionInfo s)
    {
        if (s.VolumePtr != IntPtr.Zero) Marshal.Release(s.VolumePtr);
    }
}
'@

function Get-AudioSessions {
  try {
    return [AudioMute]::GetSessions()
  } catch {
    throw $_
  }
}

function Set-SessionMute {
  param([Parameter(Mandatory)]$Session, [bool]$Mute)
  [AudioMute]::SetMute($Session, $Mute)
}

function Get-LockdownEnabled {
  param([string]$Uri)
  try {
    $r = Invoke-RestMethod -Uri $Uri -TimeoutSec 8 -Headers @{ 'Cache-Control' = 'no-cache' }
    return ($r.lockdown.enabled -eq $true)
  } catch {
    return $false
  }
}

# ---------------------------------------------------------------------------
# Hauptschleife
# ---------------------------------------------------------------------------
Write-Host "IT-Alarm-Mute laeuft. Url: $Url | Behalte: '$Keep' | Interval: ${IntervalSec}s | DryRun: $DryRun | SimulateLocked: $SimulateLocked"
Write-Host "Druecke Strg+C zum Beenden. Waehrend des Alarms werden alle anderen Sounds stummgeschaltet."

$wasLocked = $false
while ($true) {
  $locked = if ($SimulateLocked) { $true } else { Get-LockdownEnabled -Uri $Url }

  if ($locked) {
    if (-not $wasLocked) {
      try {
        $sessions = Get-AudioSessions
        Write-Host "[$(Get-Date -Format HH:mm:ss)] IT-Alarm AKTIV - mute alle Sessions (behalte: '$Keep')"
        foreach ($s in $sessions) {
          $pat = "*" + $Keep + "*"
          $isKeep = $s.Name -like $pat
          if ($isKeep) {
            Write-Host "  BEHALTE   : $($s.Name)"
          } else {
            Write-Host "  MUTE      : $($s.Name)"
            if (-not $DryRun) { Set-SessionMute $s $true }
          }
          [AudioMute]::Release($s)
        }
        if ($sessions.Count -eq 0) { Write-Host "  (keine aktiven Audio-Sessions gefunden)" }
      } catch {
        Write-Host "  Warnung: $($_.Exception.Message)"
      }
      $wasLocked = $true
    }
  } else {
    if ($wasLocked) {
      try {
        $sessions = Get-AudioSessions
        Write-Host "[$(Get-Date -Format HH:mm:ss)] IT-Alarm BEENDET - alle Sessions wieder entsperrt."
        foreach ($s in $sessions) {
          if (-not $DryRun) { Set-SessionMute $s $false }
          [AudioMute]::Release($s)
        }
      } catch {
        Write-Host "  Warnung: $($_.Exception.Message)"
      }
      $wasLocked = $false
    }
  }

  Start-Sleep -Seconds $IntervalSec
}
