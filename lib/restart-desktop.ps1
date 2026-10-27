# dsh-restart-button - restart helper for the Windows desktop app.
#
# Started by detach.cjs, which outlives the host that asked for the restart.
# Everything it needs arrives as JSON in $env:DSH_RESTART_SPEC:
#
#   mainPid        Electron main process (parent of the host)
#   hostPid        the host that asked for the restart
#   exe            application executable to start again
#   port           port the host listens on (0 = do not wait for it)
#   statusFile     where progress is reported; the host polls this
#   logFile        append-only log
#   startDelayMs   pause after "verified", so the page's answer lands first
#
# Sequence, and why each step exists:
#
#   1. verify   main runs exe, and host is main's child. If this is not the pair
#               we think it is, abort before touching anything.
#   2. freeze   NtSuspendProcess on the shell, so it never sees the host leave:
#               no crash dialog, no crash report, no "the app closed" toast.
#   3. wait     the host disconnects on its own after reading "ready" - that is
#               its graceful quit, and it flushes sessions on the way out.
#   4. end      the frozen shell, then any Chromium children that outlived it.
#   5. start    exe again with the arguments it was originally given. A pid is
#               not a window, so confirm it is still alive a few seconds later.
#
# This file is ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less
# scripts in the ANSI code page, and a stray non-ASCII byte becomes mojibake.

$ErrorActionPreference = 'Stop'
# Cmdlets report progress by writing records to the progress stream, which a
# redirected stderr turns into a CLIXML blob in the log. Nobody reads it.
$ProgressPreference = 'SilentlyContinue'

$spec = $env:DSH_RESTART_SPEC | ConvertFrom-Json

# Nothing of this helper's own wiring may reach the relaunched application.
# ELECTRON_RUN_AS_NODE especially: inherited, the app starts as a bare node and
# exits before drawing a window.
foreach ($name in @('DSH_RESTART_SPEC', 'DSH_RESTART_SCRIPT', 'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE', 'ELECTRON_ENABLE_LOGGING', 'NODE_OPTIONS')) {
  Remove-Item -LiteralPath ('Env:' + $name) -ErrorAction SilentlyContinue
}

$MainPid = [int]$spec.mainPid
$HostPid = [int]$spec.hostPid
$Exe = [string]$spec.exe
$Port = [int]$spec.port
$StatusFile = [string]$spec.statusFile
$LogFile = [string]$spec.logFile
$StartDelayMs = if ($null -ne $spec.startDelayMs) { [int]$spec.startDelayMs } else { 700 }
$HostExitTimeoutSec = 20
$Utf8 = New-Object System.Text.UTF8Encoding($false)

function Write-Log([string]$Message) {
  try {
    if ([string]::IsNullOrWhiteSpace($LogFile)) { return }
    $dir = [System.IO.Path]::GetDirectoryName($LogFile)
    if ($dir -and -not (Test-Path -LiteralPath $dir)) { [void][System.IO.Directory]::CreateDirectory($dir) }
    $line = '[{0}] [helper {1}] {2}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss.fff'), $PID, $Message
    [System.IO.File]::AppendAllText($LogFile, $line + [Environment]::NewLine, $Utf8)
  } catch {}
}

function Set-Status([string]$Value) {
  Write-Log ('status: ' + $Value)
  try {
    if ([string]::IsNullOrWhiteSpace($StatusFile)) { return }
    $tmp = '{0}.{1}.tmp' -f $StatusFile, $PID
    [System.IO.File]::WriteAllText($tmp, $Value, $Utf8)
    Move-Item -LiteralPath $tmp -Destination $StatusFile -Force
  } catch {
    Write-Log ('could not write status: ' + $_.Exception.Message)
  }
}

function Get-ProcInfo([int]$Id) {
  return Get-CimInstance -ClassName Win32_Process -Filter ('ProcessId = {0}' -f $Id) -ErrorAction SilentlyContinue
}

function Get-ArgumentTail([string]$CommandLine) {
  if ([string]::IsNullOrWhiteSpace($CommandLine)) { return '' }
  $s = $CommandLine.TrimStart()
  if ($s.StartsWith('"')) {
    $end = $s.IndexOf('"', 1)
    if ($end -lt 0) { return '' }
    return $s.Substring($end + 1).Trim()
  }
  $space = $s.IndexOf(' ')
  if ($space -lt 0) { return '' }
  return $s.Substring($space + 1).Trim()
}

function Test-SamePath([string]$A, [string]$B) {
  if ([string]::IsNullOrWhiteSpace($A) -or [string]::IsNullOrWhiteSpace($B)) { return $false }
  try {
    return [string]::Equals(
      [System.IO.Path]::GetFullPath($A),
      [System.IO.Path]::GetFullPath($B),
      [System.StringComparison]::OrdinalIgnoreCase)
  } catch {
    return $false
  }
}

function Test-PortListening([int]$P) {
  # The listener table answers immediately; a loopback connect probe to a closed
  # port takes about two seconds on Windows before it is refused.
  try {
    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | Where-Object { $_.Port -eq $P }).Count -gt 0
  } catch {
    return $false
  }
}

function Wait-Gone([int]$Id, [int]$TimeoutMs) {
  $proc = Get-Process -Id $Id -ErrorAction SilentlyContinue
  if ($null -eq $proc) { return $true }
  try { return $proc.WaitForExit($TimeoutMs) } catch { return ($null -eq (Get-Process -Id $Id -ErrorAction SilentlyContinue)) }
}

# ------------------------------------------------------------------- 1. verify
$children = @()
$relaunchArgs = ''
try {
  Write-Log ('start: main={0} host={1} exe="{2}" port={3}' -f $MainPid, $HostPid, $Exe, $Port)
  if ($MainPid -eq $HostPid) { throw 'main and host are the same process; refusing' }
  $main = Get-ProcInfo $MainPid
  if ($null -eq $main) { throw ('main process {0} is not running' -f $MainPid) }
  if (-not (Test-SamePath $main.ExecutablePath $Exe)) {
    throw ('process {0} runs "{1}", not "{2}"' -f $MainPid, $main.ExecutablePath, $Exe)
  }
  $hostInfo = Get-ProcInfo $HostPid
  if ($null -eq $hostInfo) { throw ('host process {0} is not running' -f $HostPid) }
  if ([int]$hostInfo.ParentProcessId -ne $MainPid) {
    throw ('host {0} has parent {1}, not {2}' -f $HostPid, $hostInfo.ParentProcessId, $MainPid)
  }
  $relaunchArgs = Get-ArgumentTail ([string]$main.CommandLine)
  $children = @(Get-CimInstance -ClassName Win32_Process -Filter ('ParentProcessId = {0}' -f $MainPid) -ErrorAction SilentlyContinue |
    Where-Object { [int]$_.ProcessId -ne $HostPid -and (Test-SamePath $_.ExecutablePath $Exe) } |
    ForEach-Object { [int]$_.ProcessId })
  Write-Log ('verified: arguments [{0}], shell children [{1}]' -f $relaunchArgs, ($children -join ','))

  Add-Type -Namespace DshRestartButton -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool CloseHandle(IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtSuspendProcess(IntPtr handle);
[DllImport("ntdll.dll")] public static extern int NtResumeProcess(IntPtr handle);
'@
} catch {
  $reason = $_.Exception.Message
  Write-Log ('abort before any change: ' + $reason)
  Set-Status ('failed: ' + $reason)
  exit 2
}

Set-Status 'verified'

# ------------------------------------------------------- 2.-5. freeze and relaunch
$suspended = $false
try {
  Start-Sleep -Milliseconds $StartDelayMs

  $handle = [DshRestartButton.Native]::OpenProcess(0x0800, $false, $MainPid) # PROCESS_SUSPEND_RESUME
  if ($handle -ne [IntPtr]::Zero) {
    $rc = [DshRestartButton.Native]::NtSuspendProcess($handle)
    [void][DshRestartButton.Native]::CloseHandle($handle)
    $suspended = ($rc -eq 0)
    Write-Log ('NtSuspendProcess({0}) -> 0x{1:X8}' -f $MainPid, $rc)
  } else {
    Write-Log ('OpenProcess({0}) failed with Win32 error {1}' -f $MainPid, [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
  }
  if ($suspended) { Set-Status 'ready suspended' } else { Set-Status 'ready unsuspended' }

  # 3. the host disconnects by itself after reading "ready"; that is its own
  #    orderly shutdown, not a kill.
  if (Wait-Gone $HostPid ($HostExitTimeoutSec * 1000)) {
    Write-Log 'host exited on its own'
  } else {
    Write-Log ('host still running after {0}s; terminating it' -f $HostExitTimeoutSec)
    Stop-Process -Id $HostPid -Force -ErrorAction SilentlyContinue
    [void](Wait-Gone $HostPid 5000)
  }

  # 4. the frozen shell, then whichever Chromium children are still around
  Stop-Process -Id $MainPid -Force -ErrorAction SilentlyContinue
  if (Wait-Gone $MainPid 10000) { Write-Log 'shell exited' } else { Write-Log 'shell did not exit within 10s' }
  foreach ($childPid in $children) {
    if (-not (Wait-Gone $childPid 4000)) {
      $leftover = Get-Process -Id $childPid -ErrorAction SilentlyContinue
      if ($null -ne $leftover -and (Test-SamePath $leftover.Path $Exe)) {
        Write-Log ('terminating leftover shell child {0}' -f $childPid)
        Stop-Process -Id $childPid -Force -ErrorAction SilentlyContinue
      }
    }
  }

  # 5. wait for the port to be released, then start the app again
  if ($Port -gt 0) {
    $deadline = (Get-Date).AddSeconds(20)
    while ((Test-PortListening $Port) -and ((Get-Date) -lt $deadline)) { Start-Sleep -Milliseconds 250 }
    if (Test-PortListening $Port) { Write-Log ('port {0} is still in use; starting anyway' -f $Port) } else { Write-Log ('port {0} is free' -f $Port) }
  }

  # Note the absence of -WindowStyle: hiding this start would hide the app's own
  # main window (that is the trap that cost a whole session once).
  $startArgs = @{ FilePath = $Exe; WorkingDirectory = [System.IO.Path]::GetDirectoryName($Exe); PassThru = $true }
  if (-not [string]::IsNullOrWhiteSpace($relaunchArgs)) { $startArgs.ArgumentList = $relaunchArgs }
  $started = $null
  for ($attempt = 1; $attempt -le 2; $attempt++) {
    $started = Start-Process @startArgs
    Write-Log ('started "{0}" as pid {1} (attempt {2})' -f $Exe, $started.Id, $attempt)
    Start-Sleep -Seconds 3
    if (-not $started.HasExited) { break }
    Write-Log ('pid {0} exited early with code {1}' -f $started.Id, $started.ExitCode)
    # Exit code 0 is a deliberate hand-off (a launcher stub, or the single
    # instance lock forwarding to a copy that is already up); only retry failures.
    if ($started.ExitCode -eq 0) { break }
    Start-Sleep -Seconds 2
  }

  # A pid is not a window: an app that dies during startup is visible for a
  # moment first, so wait a little and look again.
  Start-Sleep -Seconds 4
  if ($started.HasExited) {
    Set-Status ('failed: the app started and exited again (code {0})' -f $started.ExitCode)
    exit 3
  }

  # Started from a background process, Windows may open the window behind the
  # editor the user was looking at. Best effort only: a failure here is a
  # cosmetic loss, not a failed restart.
  try {
    $shell = New-Object -ComObject WScript.Shell
    [void]$shell.AppActivate($started.Id)
  } catch {
    Write-Log ('could not bring the window forward: ' + $_.Exception.Message)
  }

  Set-Status ('started pid {0}' -f $started.Id)
  Write-Log 'restart complete'
} catch {
  Write-Log ('restart failed: ' + $_.Exception.Message)
  Set-Status ('failed: ' + $_.Exception.Message)
  # Never leave the shell frozen: if it still exists, let it run again.
  try {
    if ($suspended) {
      $h = [DshRestartButton.Native]::OpenProcess(0x0800, $false, $MainPid)
      if ($h -ne [IntPtr]::Zero) {
        [void][DshRestartButton.Native]::NtResumeProcess($h)
        [void][DshRestartButton.Native]::CloseHandle($h)
      }
    }
  } catch {}
  exit 3
}

exit 0
