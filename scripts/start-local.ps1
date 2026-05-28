param(
  [int]$Port = 4180
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$node = "C:\Program Files\nodejs\node.exe"

if (!(Test-Path $node)) {
  $node = (Get-Command node -ErrorAction Stop).Source
}

$listener = netstat -ano | Select-String ":$Port\s+.*LISTENING" | Select-Object -First 1
if ($listener) {
  $pidText = ($listener.ToString().Trim() -split "\s+")[-1]
  if ($pidText -match "^\d+$") {
    Stop-Process -Id ([int]$pidText) -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 500
  }
}

$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = $node
$psi.Arguments = "server/index.js"
$psi.WorkingDirectory = $root
$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
$psi.UseShellExecute = $true
$process = [System.Diagnostics.Process]::Start($psi)

Start-Sleep -Seconds 2
$health = Invoke-WebRequest -Uri "http://localhost:$Port/api/health" -UseBasicParsing -TimeoutSec 8

[PSCustomObject]@{
  pid = $process.Id
  url = "http://localhost:$Port/"
  health = $health.Content
} | ConvertTo-Json -Compress
