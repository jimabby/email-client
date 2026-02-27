@echo off
echo Starting AI Mail Client...
echo.

start "AI Mail Backend" cmd /k "cd /d %~dp0backend && npm start"
timeout /t 2 /nobreak >nul
start "AI Mail Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"
timeout /t 3 /nobreak >nul

echo.
echo App starting at http://localhost:5173
echo Backend API at http://localhost:3001
echo.
start "" http://localhost:5173
