param(
  [int]$Port = 4180,
  [switch]$Restart,
  [switch]$NoBrowser
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = "C:\Program Files\nodejs\node.exe"
$url = "http://localhost:$Port/"
$dataDir = Join-Path $root "data"

if (!(Test-Path $node)) {
  $node = (Get-Command node -ErrorAction Stop).Source
}

New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

function Get-Health {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 2
  } catch {
    return $null
  }
}

function Get-Listener {
  try {
    return Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction Stop | Select-Object -First 1
  } catch {
    return $null
  }
}

function Get-ProcessLabel([int]$PidValue) {
  try {
    $process = Get-Process -Id $PidValue -ErrorAction Stop
    return "$($process.ProcessName) ($PidValue)"
  } catch {
    return "PID $PidValue"
  }
}

function Read-LogTail($Path) {
  if (!(Test-Path $Path)) { return "" }
  return (Get-Content $Path -Tail 40 -ErrorAction SilentlyContinue) -join "`n"
}

function Start-ServerProcess {
  $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
  $outLog = Join-Path $dataDir "server-$stamp.out.log"
  $errLog = Join-Path $dataDir "server-$stamp.err.log"
  Set-Content -Path $outLog -Value "Started by scripts\start-local.ps1 at $(Get-Date -Format s)" -Encoding UTF8
  Set-Content -Path $errLog -Value "" -Encoding UTF8
  $previousPort = $env:PORT
  $env:PORT = [string]$Port
  $process = Start-Process -FilePath $node -ArgumentList "server/index.js" -WorkingDirectory $root -WindowStyle Hidden -PassThru
  if ($null -eq $previousPort) {
    Remove-Item Env:\PORT -ErrorAction SilentlyContinue
  } else {
    $env:PORT = $previousPort
  }
  return [PSCustomObject]@{
    Pid = $process.Id
    OutLog = $outLog
    ErrLog = $errLog
  }
}

$health = Get-Health
$started = $false
$servicePid = $health.pid
$startup = $null

if ($Restart -and $health -and $health.pid) {
  Stop-Process -Id ([int]$health.pid) -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 900
  $health = $null
  $servicePid = $null
}

if (-not $health) {
  $listener = Get-Listener
  if ($listener) {
    $owner = Get-ProcessLabel ([int]$listener.OwningProcess)
    throw "Port $Port is already used by $owner, but /api/health did not respond. Close that process or use -Port."
  }

  $startup = Start-ServerProcess
  $servicePid = $startup.Pid
  $started = $true

  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $health = Get-Health
    if ($health) { break }
  }
}

if (-not $health) {
  $errTail = if ($startup) { Read-LogTail $startup.ErrLog } else { "" }
  $outTail = if ($startup) { Read-LogTail $startup.OutLog } else { "" }
  $reason = @(
    "PPT Design Tool did not become ready on $url.",
    $(if ($startup) { "stdout: $($startup.OutLog)" }),
    $(if ($startup) { "stderr: $($startup.ErrLog)" }),
    $(if ($errTail) { "stderr tail:`n$errTail" }),
    $(if ($outTail) { "stdout tail:`n$outTail" })
  ) -join "`n"
  throw $reason
}

if (-not $NoBrowser) {
  Start-Process $url | Out-Null
}

[PSCustomObject]@{
  ok = $true
  started = $started
  pid = $servicePid
  servicePid = $health.pid
  url = $url
  version = $health.version
  uptime = $health.uptime
  hasApiKey = $health.hasApiKey
  model = $health.model
  stdout = if ($startup) { $startup.OutLog } else { $null }
  stderr = if ($startup) { $startup.ErrLog } else { $null }
} | ConvertTo-Json -Compress
