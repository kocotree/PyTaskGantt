@echo off
chcp 65001 >nul
title 交互式任务甘特图编辑器

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║        交互式任务甘特图编辑器 - 一键启动脚本             ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  后端 API:  http://localhost:3001                        ║
echo ║  前端页面:  http://localhost:5173                        ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

echo [1/2] 正在启动后端 API 服务器...
start "API Server" /min cmd /c "node server.cjs"

timeout /t 2 /nobreak >nul

echo [2/2] 正在启动前端开发服务器...
start "Frontend" cmd /c "npm run dev"

timeout /t 3 /nobreak >nul

echo.
echo ✨ 服务已启动！正在打开浏览器...
timeout /t 2 /nobreak >nul
start http://localhost:5173

echo.
echo 按任意键关闭此窗口（服务将继续运行）...
pause >nul
