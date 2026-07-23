$ErrorActionPreference = "Continue"
Set-Location D:\claude\pi-ex\narrative-engine
$ep = $env:EPUB_PATH
node --import tsx scripts/import-novel-v3.ts --epub $ep *> import-v3-full.log
"EXIT=$LASTEXITCODE"
Get-Content import-v3-full.log -Tail 80
