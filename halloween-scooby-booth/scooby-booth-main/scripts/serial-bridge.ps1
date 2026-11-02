# Serial bridge between the Node server and the Arduino Mega (see lib/mega.js).
# Uses Windows PowerShell's built-in serial port, so the app needs no extra installs.
#   stdout: "OPEN COM5" once connected, then "< LINE" for every line the Mega sends; "NOPORT" / "ERROR ..." on failure
#   stdin:  each line is sent to the Mega as-is
param([string]$Port = '', [int]$Baud = 115200)
$ErrorActionPreference = 'Stop'

if (-not $Port) {
  # Official Arduino boards (VID 2341) first, then common clone USB chips (CH340 1A86, FTDI 0403, CP210x 10C4)
  $found = @(Get-CimInstance Win32_PnPEntity -Filter "Name LIKE '%(COM%'" |
    Where-Object { $_.PNPDeviceID -match 'VID_(2341|1A86|0403|10C4)' -or $_.Name -match 'Arduino|Mega' } |
    Sort-Object { if ($_.PNPDeviceID -match 'VID_2341' -or $_.Name -match 'Arduino|Mega') { 0 } else { 1 } })
  if (-not $found.Count) { [Console]::Out.WriteLine('NOPORT'); exit 2 }
  $Port = [regex]::Match($found[0].Name, '\((COM\d+)\)').Groups[1].Value
}

$sp = New-Object System.IO.Ports.SerialPort $Port, $Baud, 'None', 8, 'One'
$sp.NewLine = "`n"
$sp.Encoding = [Text.Encoding]::ASCII
$sp.DtrEnable = $true   # like pyserial: opening the port restarts the Mega, which then sends READY
try { $sp.Open() } catch { [Console]::Out.WriteLine("ERROR $Port $($_.Exception.Message)"); exit 3 }
[Console]::Out.WriteLine("OPEN $Port")

$stdin = New-Object IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$buf = ''
try {
  while ($true) {
    if ($pending.IsCompleted) {
      $line = $pending.Result
      if ($null -eq $line) { break }   # the server closed our input: quit
      $sp.Write("$line`n")
      $pending = $stdin.ReadLineAsync()
      continue
    }
    if ($sp.BytesToRead) { $buf += $sp.ReadExisting() }
    while (($i = $buf.IndexOf("`n")) -ge 0) {
      $line = $buf.Substring(0, $i).Trim()
      $buf = $buf.Substring($i + 1)
      if ($line) { [Console]::Out.WriteLine("< $line") }
    }
    Start-Sleep -Milliseconds 10
  }
} catch {
  [Console]::Out.WriteLine("ERROR $Port $($_.Exception.Message)")
  exit 4
} finally {
  if ($sp.IsOpen) { $sp.Close() }
}
