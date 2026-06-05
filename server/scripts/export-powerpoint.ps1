param(
  [Parameter(Mandatory=$true)][string]$PptxPath,
  [Parameter(Mandatory=$true)][string]$Formats
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$OutputEncoding = [System.Text.UTF8Encoding]::new()
$pptxItem = Get-Item -LiteralPath $PptxPath
$outDir = Join-Path $pptxItem.DirectoryName "exports"
New-Item -ItemType Directory -Path $outDir -Force | Out-Null

$app = New-Object -ComObject PowerPoint.Application
$presentation = $null
$result = @{ pptx = $pptxItem.FullName; pdf = $null; png = @() }

try {
  $presentation = $app.Presentations.Open($pptxItem.FullName, $true, $false, $false)
  $formatList = $Formats.Split(",") | ForEach-Object { $_.Trim().ToLowerInvariant() }

  if ($formatList -contains "pdf") {
    $pdfPath = Join-Path $outDir ($pptxItem.BaseName + ".pdf")
    $presentation.SaveAs($pdfPath, 32)
    $result.pdf = $pdfPath
  }

  if ($formatList -contains "png") {
    $pngDir = Join-Path $outDir "png"
    New-Item -ItemType Directory -Path $pngDir -Force | Out-Null
    $presentation.SaveAs($pngDir, 18)
    $result.png = @(Get-ChildItem -LiteralPath $pngDir -Filter "*.PNG" | Sort-Object @{ Expression = { [int](($_.BaseName -replace '\D+', '') -replace '^$', '0') } }, Name | ForEach-Object { $_.FullName })
  }
}
finally {
  if ($presentation -ne $null) { $presentation.Close() }
  $app.Quit()
}

$result | ConvertTo-Json -Depth 4 -Compress
