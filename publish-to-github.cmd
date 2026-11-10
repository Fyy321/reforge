@echo off
rem 一键推送到 GitHub（首次会弹出浏览器让你登录 GitHub）
chcp 65001 >nul
cd /d "%~dp0.."
git branch -M main
set /p GHUSER="你的 GitHub 用户名: "
set /p GHREPO="仓库名（直接回车默认 reforge）: "
if "%GHREPO%"=="" set GHREPO=reforge
git remote remove origin 2>nul
git remote add origin https://github.com/%GHUSER%/%GHREPO%.git
git push -u origin main
echo.
echo ============================================
echo 推送完成。接下来两步（网页操作）:
echo   1. 打开 https://github.com/%GHUSER%/%GHREPO%/settings/pages
echo       Source 选 "Deploy from a branch"，分支选 gh-pages，保存
echo   2. 打开 https://github.com/%GHUSER%/%GHREPO%/actions
echo       点左侧 daily-ranks，再点右侧 Run workflow 手动跑第一次
echo   数据源网址（给苹果软件用）:
echo   https://%GHUSER%.github.io/%GHREPO%/ranks-apple.json
echo ============================================
pause
