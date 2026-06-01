param(
  [string]$Root = ("F:\PPT{0}{1}\ZImageLocal" -f [char]0x5de5, [char]0x5177),
  [int]$Port = 8188,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$portableRoot = Join-Path $Root "ComfyUI_windows_portable"
$launcher = Join-Path $portableRoot "run_nvidia_gpu.bat"
$cacheRoot = Join-Path $Root "cache"
$hfHome = Join-Path $cacheRoot "huggingface"
$torchHome = Join-Path $cacheRoot "torch"
$transformersCache = Join-Path $hfHome "transformers"

if (!(Test-Path $launcher)) {
  throw "ComfyUI portable launcher not found: $launcher"
}

New-Item -ItemType Directory -Force -Path $hfHome, $torchHome, $transformersCache | Out-Null

function Get-ComfyStats {
  try {
    return Invoke-RestMethod -Uri "http://127.0.0.1:$Port/system_stats" -TimeoutSec 2
  } catch {
    return $null
  }
}

$existing = Get-ComfyStats
if ($Restart -and $existing) {
  $listeners = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  foreach ($listener in $listeners) {
    Stop-Process -Id ([int]$listener.OwningProcess) -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
  $existing = $null
}

if (-not $existing) {
  $env:HF_HOME = $hfHome
  $env:HUGGINGFACE_HUB_CACHE = Join-Path $hfHome "hub"
  $env:TRANSFORMERS_CACHE = $transformersCache
  $env:TORCH_HOME = $torchHome
  $env:COMFYUI_OUTPUT_DIRECTORY = Join-Path $portableRoot "ComfyUI\output"

  Start-Process -FilePath $launcher -WorkingDirectory $portableRoot -WindowStyle Hidden | Out-Null

  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    $existing = Get-ComfyStats
    if ($existing) { break }
  }
}

if (-not $existing) {
  throw "ComfyUI did not become ready on http://127.0.0.1:$Port/"
}

[PSCustomObject]@{
  ok = $true
  url = "http://127.0.0.1:$Port/"
  root = $Root
  launcher = $launcher
  hfHome = $hfHome
  torchHome = $torchHome
  transformersCache = $transformersCache
  system = $existing.system
  devices = $existing.devices
} | ConvertTo-Json -Depth 6 -Compress
