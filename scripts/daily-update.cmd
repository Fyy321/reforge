@echo off
rem 每日榜单更新任务入口（由 Windows 任务计划程序调用）
set NODE="C:\Users\ASUS\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set SCRIPT="C:\Users\ASUS\Documents\deepseek-harness\default-workspace\reforge\scripts\daily-update.js"
set OUTDIR="C:\Users\ASUS\Documents\deepseek-harness\default-workspace\reforge\mirrors\daily-full"
%NODE% %SCRIPT% --out-dir %OUTDIR% >> "%OUTDIR%\task.log" 2>&1
