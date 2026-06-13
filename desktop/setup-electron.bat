@echo off
echo Setting up AI Mail Desktop App...
echo.

echo [1/3] Installing backend dependencies...
cd /d %~dp0backend
call npm install
if errorlevel 1 (echo ERROR: Backend install failed && pause && exit /b 1)
cd /d %~dp0

echo.
echo [2/3] Installing frontend dependencies...
cd /d %~dp0frontend
call npm install
if errorlevel 1 (echo ERROR: Frontend install failed && pause && exit /b 1)
cd /d %~dp0

echo.
echo [3/3] Installing Electron...
call npm install
if errorlevel 1 (echo ERROR: Electron install failed && pause && exit /b 1)

echo.
echo ================================================
echo  Setup complete!
echo  Run start-desktop.bat to launch the app.
echo ================================================
echo.
pause
