$lines = Get-Content "d:\claude\pi-ex\novel\.pi\world-graph-v3\events.jsonl"
$props = @()
$sources = @()
foreach ($line in $lines) {
    $matches = [regex]::Matches($line, '"property":"([^"]+)"')
    foreach ($m in $matches) { $props += $m.Groups[1].Value }
    $matches = [regex]::Matches($line, '"source":"([^"]+)"')
    foreach ($m in $matches) { $sources += $m.Groups[1].Value }
}
Write-Host "=== property 值（去重）==="
$props | Sort-Object -Unique
Write-Host ""
Write-Host "=== source 值（去重）==="
$sources | Sort-Object -Unique
