$url = "https://dcncwu4omjpp.feishu.cn/wiki/RDAtwA2WviFEmHkJbItccKFEnec"
$outDir = "D:\claude\pi-ex\narrative-engine\docs\legacy\feishu-raw"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

$sections = @(
    @{ id = "doxcnHamPD44DhThAGPUFI2flYe"; name = "01-overview" },
    @{ id = "doxcnHekTWUekK1ahFxkTLKmgmd"; name = "02-architecture" },
    @{ id = "doxcn7q1ZMeuZllxNXdFixklT8e"; name = "03-key-decisions" },
    @{ id = "doxcnQPniI2SwC0fEo89dOVOxYy"; name = "04-diffusion-strategy" },
    @{ id = "doxcndHaUrP66G57zBHDq1x3YXe"; name = "05-world-context-definition" },
    @{ id = "doxcn2GTecKQCb03JdBMOOoMIjf"; name = "06-world-context-node-graph" },
    @{ id = "doxcnUUkn5xs1OBYsFx1DKdoJVf"; name = "07-retrieval-update-flow" },
    @{ id = "doxcnVLDMcQyncyVtUlbfnfHo4g"; name = "08-ecs-entity-model" },
    @{ id = "doxcnxlPyrKyUQ2ODCRExdgkBNh"; name = "09-four-layer-blueprint" },
    @{ id = "doxcnt6yKlIhoF5QGipQ3KowB6b"; name = "10-core-loop-final" },
    @{ id = "doxcnSoEMqu3NLXSgcjjOkeUqJX"; name = "11-executor-extra-context" },
    @{ id = "doxcnIbaZAeQ3O7PY0sHAXgCJFb"; name = "12-context-influence-on-events" },
    @{ id = "doxcncM1AtemWJzbyI7jK3UAEDa"; name = "13-info-gap-foreshadowing" },
    @{ id = "doxcnUTlgWVllYmWYtzXT6AQ9Xb"; name = "14-character-arc-cumulative" },
    @{ id = "doxcnLmWddFCg3cZ0Wsrbv2AFse"; name = "15-executor-upgrade" },
    @{ id = "doxcnwmU2cFNDOZ35ii2GISm1vd"; name = "16-event-granularity" },
    @{ id = "doxcntFh0JgczP1Pp6IXehZzt4f"; name = "17-hermes-extension" },
    @{ id = "doxcncH7LjphpA5ksFpETsrOKyb"; name = "18-standalone-pi-agent" },
    @{ id = "doxcnpIdELif6rqnFOwAiDCTRPf"; name = "19-pi-extension-analysis" },
    @{ id = "doxcnq1U9WMpfPleXkTVG9v9XBT"; name = "20-pi-deep-research" },
    @{ id = "doxcnwRd2H0yMpzlE8ly6VvFHpf"; name = "21-semantic-understanding-layer" },
    @{ id = "doxcnuzhKCZjVDrsE82tb4p37mf"; name = "22-intent-classification" },
    @{ id = "doxcnA42bfXjBIMi9A8EIZCOQvf"; name = "23-renderer-revision" },
    @{ id = "doxcnwCKfv6AYaBQUvU5jURgglf"; name = "24-context-compression-by-recency" },
    @{ id = "doxcnPbLxxjWmdbomzIzV95nQbb"; name = "25-character-node-structure" },
    @{ id = "doxcnv5ruQAYl6TD3HzbY9FbuPb"; name = "26-rule-engine-emaonovel" },
    @{ id = "doxcndSE672BnY4i26wK4OxteLb"; name = "27-product-positioning" },
    @{ id = "doxcn758XB27jh7iteSs1GtLuOf"; name = "28-world-context-layering" },
    @{ id = "doxcnJ6V7prZYnTKatZrdVOKvUh"; name = "29-context-compression-by-layer" },
    @{ id = "doxcnUJDhcdiEmnMZ3D4G8snZMd"; name = "30-mcp-direction" },
    @{ id = "doxcnIj767QRUg94PnU5cU9ecjh"; name = "31-tavern-card-migration" }
)

foreach ($s in $sections) {
    $outFile = Join-Path $outDir "$($s.name).xml"
    Write-Host "Fetching $($s.name) ..."
    $result = & lark-cli docs +fetch --doc $url --scope section --start-block-id $s.id 2>&1
    $result | Out-File -FilePath $outFile -Encoding utf8
    $size = (Get-Item $outFile).Length
    Write-Host "  -> $($s.name).xml ($size bytes)"
}

Write-Host "`nDone. Files saved to: $outDir"
Get-ChildItem $outDir | Format-Table Name, Length
