@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ⚽ 足球游戏启动器
if not exist "dist\index.html" (
  echo [1/2] 首次运行，正在构建游戏（大模型约 200MB，需要几十秒）...
  call npm run build
  if errorlevel 1 (
    echo 构建失败，请检查 Node.js 是否已安装（node -v）
    pause
    exit /b 1
  )
)
echo [2/2] 启动游戏服务器，浏览器将自动打开...
start "" http://localhost:8000
node server.js
pause
