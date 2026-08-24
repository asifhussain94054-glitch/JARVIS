@echo off
title JARVIS Local Agent
cd /d "%~dp0"

echo.
echo  ============================================
echo   JARVIS Local Agent  —  Phase 1
echo  ============================================
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  set "PY=py -3"
) else (
  where python >nul 2>nul
  if %errorlevel%==0 (
    set "PY=python"
  ) else (
    echo  Python was not found on this computer.
    echo.
    echo  Please install Python 3 from:
    echo    https://www.python.org/downloads/
    echo.
    echo  IMPORTANT: during setup, CHECK the box
    echo    "Add python.exe to PATH"
    echo  Then run this file again.
    echo.
    pause
    exit /b 1
  )
)

if not exist ".venv\Scripts\python.exe" (
  echo  Setting up a private Python environment.
  echo  This happens only the first time...
  echo.
  %PY% -m venv .venv
  if errorlevel 1 (
    echo  Could not create the virtual environment.
    echo  Reinstall Python and make sure "Add to PATH" is checked.
    echo.
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"
python -m pip install --upgrade pip >nul
python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo  Could not install the required packages.
  echo  Check your internet connection and try again.
  echo.
  pause
  exit /b 1
)

echo.
echo  Starting the local agent...
echo  Leave this window open while you use JARVIS.
echo  Press Ctrl+C to stop.
echo.
python agent.py
echo.
echo  The local agent has stopped.
pause
