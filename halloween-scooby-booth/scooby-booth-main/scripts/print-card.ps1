# Prints one image onto a card through the Windows printer driver (e.g. the SwiftColor SCC4000D).
# The image is scaled to fit the card's printable area without distortion and centered.
#   powershell -File print-card.ps1 -Image comic.jpg [-Printer "SCC4000D"] [-Fill] [-OutFile test.pdf] [-Copies 5]
# -Printer  defaults to the Windows default printer
# -Fill     covers the whole card (crops a little) instead of fitting inside it (thin white bands)
# -OutFile  print to a file instead (for testing with "Microsoft Print to PDF")
param(
  [Parameter(Mandatory = $true)][string]$Image,
  [string]$Printer = '',
  [switch]$Fill,
  [string]$OutFile = '',
  # Part of the driver's paper size name to use, e.g. "3.5 X 5.5" (the 700x1100 card); empty = driver default
  [string]$Paper = '',
  # Rotate the image 180 degrees (for a card back that comes out upside down after flipping the card)
  [switch]$Rotate180,
  # How many cards to print, sent as one job with one page per card
  [ValidateRange(1, 100)][int]$Copies = 1
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$img = [System.Drawing.Image]::FromFile((Resolve-Path $Image).Path)
if ($Rotate180) { $img.RotateFlip([System.Drawing.RotateFlipType]::Rotate180FlipNone) }
try {
  $doc = New-Object System.Drawing.Printing.PrintDocument
  $doc.DocumentName = 'Scooby Booth Card'
  if ($Printer) { $doc.PrinterSettings.PrinterName = $Printer }
  if (-not $doc.PrinterSettings.IsValid) { throw "Printer not found: '$($doc.PrinterSettings.PrinterName)'" }
  if ($OutFile) {
    $doc.PrinterSettings.PrintToFile = $true
    $doc.PrinterSettings.PrintFileName = [System.IO.Path]::GetFullPath($OutFile)
  }
  if ($Paper) {
    $size = $doc.PrinterSettings.PaperSizes | Where-Object { $_.PaperName -like "*$Paper*" } | Select-Object -First 1
    if (-not $size) { throw "Paper size '$Paper' not found on $($doc.PrinterSettings.PrinterName)" }
    $doc.DefaultPageSettings.PaperSize = $size
  }
  # Portrait card, edge to edge; no "Printing..." dialog
  $doc.DefaultPageSettings.Landscape = $false
  $doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
  $doc.OriginAtMargins = $false
  $doc.PrintController = New-Object System.Drawing.Printing.StandardPrintController

  $script:printed = 0
  $doc.add_PrintPage({
    param($sender, $e)
    $e.Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    # PageBounds is in hundredths of an inch; offset by the hard margin so (0,0) is the paper edge
    $page = $e.PageBounds
    $hx = $e.PageSettings.HardMarginX; $hy = $e.PageSettings.HardMarginY
    $scaleW = $page.Width / $img.Width; $scaleH = $page.Height / $img.Height
    $scale = if ($Fill) { [Math]::Max($scaleW, $scaleH) } else { [Math]::Min($scaleW, $scaleH) }
    $w = $img.Width * $scale; $h = $img.Height * $scale
    $x = ($page.Width - $w) / 2 - $hx; $y = ($page.Height - $h) / 2 - $hy
    $e.Graphics.DrawImage($img, [single]$x, [single]$y, [single]$w, [single]$h)
    $script:printed++
    $e.HasMorePages = $script:printed -lt $Copies
  })
  $doc.Print()
  $cards = if ($Copies -gt 1) { "$Copies cards to " } else { 'to ' }
  Write-Output "Sent $cards$($doc.PrinterSettings.PrinterName) ($($doc.DefaultPageSettings.PaperSize.PaperName))"
} finally {
  $img.Dispose()
}
