@echo off
chcp 65001 >nul
title 任务甘特图编辑器 (Vue / AntD 风)

REM 从 .env 读端口配置（缺省时回退到 3002/5174）
set "BACKEND_PORT=3002"
set "FRONTEND_PORT=5174"
if exist .env (
    for /f "usebackq tokens=1,2 delims==" %%a in (".env") do (
        if /i "%%a"=="PORT" set "BACKEND_PORT=%%b"
        if /i "%%a"=="VITE_DEV_PORT" set "FRONTEND_PORT=%%b"
    )
)

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   任务甘特图编辑器 - 一键启动               ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  后端 API:  http://localhost:%BACKEND_PORT%
echo ║  前端页面:  http://localhost:%FRONTEND_PORT%
echo ╚══════════════════════════════════════════════════════════╝
echo.

echo [1/2] 正在启动后端 API 服务器 (端口 %BACKEND_PORT%)...
start "API Server (%BACKEND_PORT%)" /min cmd /c "node server.cjs"

timeout /t 2 /nobreak >nul

echo [2/2] 正在启动前端开发服务器 (端口 %FRONTEND_PORT%)...
start "Frontend (%FRONTEND_PORT%)" cmd /c "npm run dev"

timeout /t 3 /nobreak >nul

echo.
echo ✨ 服务已启动！正在打开浏览器...
timeout /t 2 /nobreak >nul
start http://localhost:%FRONTEND_PORT%

echo.
echo 按任意键关闭此窗口（服务将继续运行）...
pause >nul
