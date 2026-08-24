@echo off
title Stop JARVIS Local Agent
echo.
echo  Stopping JARVIS Local Agent on port 18765...
echo.

set "KILLED=0"
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :18765 ^| findstr LISTENING') do (
  taskkill /PID %%a /F >nul 2>nul
  set "KILLED=1"
)

if "%KILLED%"=="1" (
  echo  The local agent has been stopped.
) else (
  echo  No local agent was listening on port 18765.
  echo  It may already be stopped.
)
echo.
pause
