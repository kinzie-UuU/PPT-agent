param(
  [string]$Source = (Join-Path (Split-Path $PSScriptRoot -Parent) "local-ai\comfyui-workflows"),
  [string]$Target = (Join-Path ("F:\PPT{0}{1}" -f [char]0x5de5, [char]0x5177) "ZImageLocal\ComfyUI_windows_portable\ComfyUI\user\default\workflows\ppt-design-tool")
)

$ErrorActionPreference = "Stop"

if (!(Test-Path -LiteralPath $Source)) {
  throw "Workflow source not found: $Source"
}

New-Item -ItemType Directory -Force -Path $Target | Out-Null

Get-ChildItem -LiteralPath $Source -File -Filter "*.json" | ForEach-Object {
  Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Target $_.Name) -Force
}

Write-Host "Installed PPT Design Tool ComfyUI workflows to:"
Write-Host $Target
