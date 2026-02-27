@echo off
echo Starting AI Mail Desktop App...
echo.

cd /d %~dp0

REM Build the frontend if dist folder doesn't exist
if not exist "frontend\dist" (
  echo Building frontend for the first time...
  cd /d %~dp0frontend
  call npm run build
  if errorlevel 1 (echo ERROR: Frontend build failed && pause && exit /b 1)
  cd /d %~dp0
  echo.
)

echo Launching AI Mail...
npm start
