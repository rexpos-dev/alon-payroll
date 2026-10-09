@echo off
title Alon Payroll
cd /d "%~dp0"
if not exist "node_modules" (
  echo Not installed yet. Run install.bat first.
  pause
  exit /b 1
)
set PORT=3000
for /f "tokens=1,* delims==" %%a in ('findstr /b "PORT=" ".env" 2^>nul') do set PORT=%%b
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"
echo Alon Payroll is running. Do not close this window while using the system.
call npm start
pause
