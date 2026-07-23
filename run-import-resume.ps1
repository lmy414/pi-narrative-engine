$ErrorActionPreference = "Continue"
Set-Location D:\claude\pi-ex\narrative-engine
# 用环境变量传中文 EPUB 路径，规避 PS5 调用 native exe 时命令行参数被 GBK 编码破坏的问题
# （PS5 传 env 给子进程走 UTF-16→UTF-8 转换，安全）
$env:EPUB_PATH = "E:\下载\超かぐや姫！中文(1).epub"
node --import tsx scripts/import-novel-v3.ts --resume-from-stage 7 *> import-v3-resume.log
"EXIT=$LASTEXITCODE"
Get-Content import-v3-resume.log -Tail 80
