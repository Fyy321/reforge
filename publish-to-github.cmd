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

rem 3) 输入 GitHub 信息（默认已填好，直接回车即可）
set "GHUSER=Fyy321"
set /p GHUSER=GitHub 用户名（直接回车=Fyy321）: 
set "GHREPO=reforge"
set /p GHREPO=仓库名（直接回车=reforge）: 

echo.
echo 正在连接 https://github.com/%GHUSER%/%GHREPO%.git ...
echo 如果弹出浏览器请登录 GitHub 账号 %GHUSER% 并点绿色授权按钮。
echo.

rem 4) 先探测仓库是否可见（显示真实错误）
git ls-remote https://github.com/%GHUSER%/%GHREPO%.git >nul 2>&1
if errorlevel 1 (
  echo [连接失败] 真实错误信息如下:
  git ls-remote https://github.com/%GHUSER%/%GHREPO%.git
  echo.
  echo 对照处理:
  echo   - 显示 Repository not found = 用户名或仓库名与 GitHub 上不一致
  echo   - 显示 Authentication failed = 登录授权没完成，先执行:
  echo       git credential-manager github logout
  echo     然后重新双击本文件，浏览器会重新弹登录
  pause
  exit /b 1
)

echo 连接成功，开始推送...
echo.
git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/%GHUSER%/%GHREPO%.git
git push -u origin main
if errorlevel 1 (
  echo.
  echo [推送失败] 真实错误信息已在上方，解决后重新双击本文件。
  pause
  exit /b 1
)

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