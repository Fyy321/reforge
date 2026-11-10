@echo off
setlocal
title 推送到 GitHub

rem 1) 保证能找到 git
if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=C:\Program Files\Git\cmd;%PATH%"
git --version >nul 2>&1
if errorlevel 1 (
  echo [错误] 没有找到 git。请重启电脑后再双击本文件。
  pause
  exit /b 1
)

rem 2) 进入 reforge 目录
cd /d "%~dp0"

rem 3) 日志（供诊断，全部输出都会写进这个文件）
set "LOG=%~dp0publish-log.txt"
echo === 运行时间 %date% %time% === > "%LOG%"

rem 4) 输入 GitHub 信息（默认已填好，直接回车即可）
set "GHUSER=Fyy321"
set /p GHUSER=GitHub 用户名（直接回车=Fyy321）: 
set "GHREPO=reforge"
set /p GHREPO=仓库名（直接回车=reforge）: 

echo 正在连接 https://github.com/%GHUSER%/%GHREPO%.git ... >> "%LOG%"
echo 如果弹出浏览器请登录 GitHub 账号 %GHUSER% 并点绿色授权按钮。
echo.

rem 5) 先探测仓库连接（真实错误写日志）
git ls-remote https://github.com/%GHUSER%/%GHREPO%.git >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [连接失败] 错误已写入 publish-log.txt，正在显示:
  type "%LOG%"
  pause
  exit /b 1
)

echo 连接成功，开始推送...
echo.
git branch -M main >> "%LOG%" 2>&1
git remote remove origin >> "%LOG%" 2>&1
git remote add origin https://github.com/%GHUSER%/%GHREPO%.git >> "%LOG%" 2>&1
git push -u origin main >> "%LOG%" 2>&1
if errorlevel 1 (
  echo [推送失败] 完整错误已写入 publish-log.txt，正在显示:
  type "%LOG%"
  pause
  exit /b 1
)

echo 推送完成！ >> "%LOG%"
echo.
echo ============================================
echo 推送完成！接下来两步网页操作:
echo   1. 打开 https://github.com/%GHUSER%/%GHREPO%/settings/pages
echo      Source 选 Deploy from a branch，分支选 gh-pages，保存
echo   2. 打开 https://github.com/%GHUSER%/%GHREPO%/actions
echo      点左侧 daily-ranks，右侧 Run workflow 手动跑第一次
echo 数据源网址（给苹果软件用）:
echo   https://%GHUSER%.github.io/%GHREPO%/ranks-apple.json
echo ============================================
pause