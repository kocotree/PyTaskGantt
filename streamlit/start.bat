@echo off
title PyTaskGantt Streamlit

cd /d "%~dp0"

set "APP_DIR=%CD%"
set "APP_FILE=%APP_DIR%\create_gantt.py"
set "RUN_DIR=%TEMP%\PyTaskGantt-streamlit-run"
set "UV_CACHE_DIR=%CD%\.uv-cache"
set "UV_LINK_MODE=copy"
set "PYTHONNOUSERSITE=1"
set "PYTHONPATH="
set "PYTHON_VERSION=3.12"
set "VENV_DIR=%CD%\.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "VENV_STREAMLIT=%VENV_DIR%\Scripts\streamlit.exe"
set "VENV_CONFIG=%VENV_DIR%\pyvenv.cfg"
set "ENV_MARKER=%VENV_DIR%\.pytaskgantt-env"
set "ENV_KEY=py312-numpy1-pandas22-streamlit1-copy-v2"
set "PUSHD_RUN_DIR="

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
echo   App file:
echo     %APP_FILE%
echo.
echo   Run directory:
echo     %RUN_DIR%
echo.
echo   Python environment:
echo     %VENV_DIR%
echo     Python %PYTHON_VERSION%
echo.
echo   uv cache:
echo     %UV_CACHE_DIR%
echo ==========================================================
echo.
echo Preparing local Python environment with uv. Please wait...
echo.

set "NEED_INSTALL=0"
set "PYTHON_MISMATCH=0"
if exist "%VENV_PYTHON%" (
    if exist "%VENV_CONFIG%" (
        findstr /b /c:"version_info = %PYTHON_VERSION%." "%VENV_CONFIG%" >nul 2>nul
        if errorlevel 1 set "PYTHON_MISMATCH=1"
    ) else (
        set "PYTHON_MISMATCH=1"
    )
)

if exist "%VENV_PYTHON%" if "%PYTHON_MISMATCH%"=="1" (
    echo Existing .venv is not Python %PYTHON_VERSION%. Rebuilding...
    rmdir /s /q "%VENV_DIR%"
)

if not exist "%VENV_PYTHON%" (
    uv venv --python "%PYTHON_VERSION%" "%VENV_DIR%"
    if errorlevel 1 goto failed
)

if not exist "%ENV_MARKER%" set "NEED_INSTALL=1"
if exist "%ENV_MARKER%" (
    findstr /x /c:"%ENV_KEY%" "%ENV_MARKER%" >nul 2>nul
    if errorlevel 1 set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
    echo Installing or updating pinned dependencies...
    uv pip install --link-mode copy --python "%VENV_PYTHON%" "streamlit>=1.30,<2" "pandas>=2.2,<2.3" "numpy>=1.26,<2" "plotly>=5.20,<7"
    if errorlevel 1 goto failed
) else (
    echo Local Python environment is already prepared.
)

if not exist "%RUN_DIR%" mkdir "%RUN_DIR%"
pushd "%RUN_DIR%"
set "PUSHD_RUN_DIR=1"

"%VENV_PYTHON%" -c "import os, sys, numpy, pandas, plotly, streamlit; print('Dependency import check passed'); print('cwd=' + os.getcwd()); print('numpy=' + numpy.__file__)"
if errorlevel 1 (
    popd
    set "PUSHD_RUN_DIR="
    echo Dependency import check failed. Rebuilding .venv with copied wheels...
    rmdir /s /q "%VENV_DIR%"
    uv venv --python "%PYTHON_VERSION%" "%VENV_DIR%"
    if errorlevel 1 goto failed
    uv pip install --link-mode copy --python "%VENV_PYTHON%" --reinstall "streamlit>=1.30,<2" "pandas>=2.2,<2.3" "numpy>=1.26,<2" "plotly>=5.20,<7"
    if errorlevel 1 goto failed
    pushd "%RUN_DIR%"
    set "PUSHD_RUN_DIR=1"
    "%VENV_PYTHON%" -c "import os, sys, numpy, pandas, plotly, streamlit; print('Dependency import check passed'); print('cwd=' + os.getcwd()); print('numpy=' + numpy.__file__)"
    if errorlevel 1 goto failed
)

> "%ENV_MARKER%" echo %ENV_KEY%

"%VENV_PYTHON%" -m streamlit run "%APP_FILE%" --server.address 0.0.0.0 --server.port 8501
popd
set "PUSHD_RUN_DIR="
goto done

:failed
if defined PUSHD_RUN_DIR popd
echo.
echo Failed to prepare or run the Streamlit environment.
pause
exit /b 1

:done
echo.
echo Streamlit server exited.
pause
