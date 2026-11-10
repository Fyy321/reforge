@echo off
chcp 65001 >nul
setlocal
title 推送到 GitHub

rem 1) 保证能找到 git（新装的 git 有时要手动加路径）
if exist "C:\Program Files\Git\cmd\git.exe" set "PATH=C:\Program Files\Git\cmd;%PATH%"
git --version >nul 2>&1
if errorlevel 1 (
  echo [错误] 没有找到 git，正在重新读取系统路径...
  set "PATH=%PATH%"
  git --version >nul 2>&1
  if errorlevel 1 (
    echo 仍然找不到 git。请重启电脑后再双击本文件。
    pause
    exit /b 1
  )
)

rem 2) 进入 reforge 目录
cd /d "%~dp0"

rem 3) 输入 GitHub 信息
set "GHUSER="
set /p GHUSER=你的 GitHub 用户名: 
if "%GHUSER%"=="" (
  echo 用户名不能为空，重新运行本文件。
  pause
  exit /b 1
)
set "GHREPO="
set /p GHREPO=仓库名（直接回车默认 reforge）: 
if "%GHREPO%"=="" set "GHREPO=reforge"

echo.
echo 正在推送到 https://github.com/%GHUSER%/%GHREPO%.git ...
echo 如果弹出浏览器请登录 GitHub 并授权。
echo.

git branch -M main
git remote remove origin 2>nul
git remote add origin https://github.com/%GHUSER%/%GHREPO%.git
git push -u origin main
if errorlevel 1 (
  echo.
  echo [推送失败] 常见原因：
  echo   1. GitHub 上还没有创建名为 %GHREPO% 的仓库（去 github.com 点 New repository 先建一个空仓库）
  echo   2. 浏览器登录窗口被关闭
  echo 解决后重新双击本文件即可。
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