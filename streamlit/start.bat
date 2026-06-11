@echo off
title PyTaskGantt Streamlit

cd /d "%~dp0"

set "UV_CACHE_DIR=%CD%\.uv-cache"
set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_STREAMLIT=%VENV_DIR%\Scripts\streamlit.exe"

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
    echo [ERROR] uv was not found. Please install uv first.
    echo Install command:
    echo powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"
    echo.
    pause
    exit /b 1
)

echo.
echo ==========================================================
echo   PyTaskGantt Streamlit - uv launcher
echo ==========================================================
echo   Local URL:
echo     http://localhost:8501
echo.
echo   Network URLs:
set "HAS_IP="
for /f "tokens=2 delims=:" %%i in ('ipconfig ^| findstr /C:"IPv4"') do for /f "tokens=* delims= " %%j in ("%%i") do (
    set "HAS_IP=1"
    echo     http://%%j:8501
)
if not defined HAS_IP echo     http://127.0.0.1:8501
echo.
echo   Data file:
echo     %DISPLAY_TASKS_FILE%
echo.
echo   Python environment:
echo     %VENV_DIR%
echo.
echo   uv cache:
echo     %UV_CACHE_DIR%
echo ==========================================================
echo.
echo Preparing local Python environment with uv. Please wait...
echo.

if not exist "%VENV_PYTHON%" (
    uv venv "%VENV_DIR%"
    if errorlevel 1 goto failed
)

uv pip install --python "%VENV_PYTHON%" streamlit pandas plotly
if errorlevel 1 goto failed

"%VENV_STREAMLIT%" run create_gantt.py --server.address 0.0.0.0 --server.port 8501
goto done

:failed
echo.
echo Failed to prepare or run the Streamlit environment.
pause
exit /b 1

:done
echo.
echo Streamlit server exited.
pause
