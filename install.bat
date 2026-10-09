@echo off
title Alon Payroll - Install
cd /d "%~dp0"
echo.
echo === Alon Payroll: install ===
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install it first from https://nodejs.org
  pause
  exit /b 1
)
if not exist ".env" (
  copy ".env.example" ".env" >nul
  echo .env created. Edit DATABASE_URL, then run this file again.
  notepad ".env"
  pause
  exit /b 1
)
echo.
echo [1/2] Installing packages...
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo npm install failed.
  pause
  exit /b 1
)
echo.
echo [2/2] Creating database tables...
call npm run migrate
if errorlevel 1 (
  echo Migration failed. Check that MySQL is running and DATABASE_URL in .env is correct.
  pause
  exit /b 1
)
echo.
echo Done! Double-click start.bat to run the system.
pause
