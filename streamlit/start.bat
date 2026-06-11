@echo off
chcp 65001 >nul
title 任务甘特图编辑器 (Streamlit)

cd /d "%~dp0"

set "CONFIG_TASKS_FILE=%TASKS_FILE%"
if not defined CONFIG_TASKS_FILE (
    set "CONFIG_TASKS_FILE=ShadowBot_tasks.csv"
    if exist .env (
        for /f "usebackq tokens=1,* delims==" %%a in (".env") do (
            if /i "%%a"=="TASKS_FILE" set "CONFIG_TASKS_FILE=%%b"
        )
    )
)
for %%f in ("%CONFIG_TASKS_FILE%") do set "DISPLAY_TASKS_FILE=%%~ff"

where uv >nul 2>nul
if errorlevel 1 (
    echo.
    echo [错误] 未找到 uv，请先安装 uv 后再运行本脚本。
    echo 安装命令:
    echo powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    echo.
    pause
    exit /b 1
)

echo.
echo ╔══════════════════════════════════════════════════════════╗
echo ║   任务甘特图编辑器 (Streamlit) - uv 一键启动             ║
echo ╠══════════════════════════════════════════════════════════╣
echo ║  本机访问:  http://localhost:8501
echo ║  具体地址:
set "HAS_IP="
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4"') do for /f "tokens=* delims= " %%j in ("%%i") do (
    set "HAS_IP=1"
    echo ║    http://%%j:8501
)
if not defined HAS_IP echo ║    http://127.0.0.1:8501
echo ║  数据文件:  %DISPLAY_TASKS_FILE%
echo ╚══════════════════════════════════════════════════════════╝
echo.
echo 首次运行会由 uv 自动准备依赖，请稍等...
echo.

uv run --with streamlit --with pandas --with plotly streamlit run create_gantt.py --server.address 0.0.0.0 --server.port 8501

echo.
echo Streamlit 服务已退出。
pause
