@echo off
chcp 65001 >nul
cd /d D:\claude\pi-ex\narrative-engine
set EPUB_PATH=E:\下载\超かぐや姫！中文(1).epub
node --import tsx scripts/import-novel-v3.ts --epub "%EPUB_PATH%" --chapters 1 --no-embed > import-v3-ch1.log 2>&1
echo EXIT=%ERRORLEVEL%
type import-v3-ch1.log
