@echo off
chcp 65001 >nul
title 停止甘特图编辑器服务

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║           停止交互式任务甘特图编辑器服务                 ║
echo ╚══════════════════════════════════════════════════════════╝
echo.

echo 正在停止 Node.js 进程...
taskkill /f /im node.exe >nul 2>&1

if %errorlevel% == 0 (
    echo ✓ 所有 Node.js 进程已停止
) else (
    echo ✗ 没有找到运行中的 Node.js 进程
)

echo.
echo 完成！按任意键关闭...
pause >nul
