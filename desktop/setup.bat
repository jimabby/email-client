@echo off
echo ========================================
echo  AI Mail Client - Setup
echo ========================================
echo.

echo [1/4] Setting up backend...
cd backend
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Backend npm install failed
    pause
    exit /b 1
)

echo.
echo [2/4] Copying .env.example to .env...
if not exist .env (
    copy .env.example .env
    echo Created backend/.env - Please edit it and add your API keys!
) else (
    echo .env already exists, skipping...
)

echo.
echo [3/4] Setting up frontend...
cd ..\frontend
call npm install
if %ERRORLEVEL% neq 0 (
    echo ERROR: Frontend npm install failed
    pause
    exit /b 1
)

cd ..

echo.
echo ========================================
echo  Setup complete!
echo ========================================
echo.
echo NEXT STEPS:
echo.
echo 1. Edit backend\.env and add your ANTHROPIC_API_KEY
echo    (Get it at https://console.anthropic.com)
echo.
echo 2. To start the app, run: start.bat
echo    OR run these in separate terminals:
echo      Terminal 1: cd backend ^&^& npm start
echo      Terminal 2: cd frontend ^&^& npm run dev
echo.
echo 3. Open http://localhost:5173 in your browser
echo.
pause
