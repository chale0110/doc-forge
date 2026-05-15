@echo off
title DocForge Dev

cd /d "%~dp0.."

if not exist "node_modules\" (
    echo node_modules not found. Run setup.bat first.
    pause
    exit /b 1
)

:: Find Python
set PYCMD=
where py >nul 2>&1 && set PYCMD=py
if "%PYCMD%"=="" where python >nul 2>&1 && set PYCMD=python
if "%PYCMD%"=="" where python3 >nul 2>&1 && set PYCMD=python3

if "%PYCMD%"=="" (
    echo ERROR: Python not found.
    pause
    exit /b 1
)

:: Auto-check and install Python deps if missing
echo Checking Python dependencies...
%PYCMD% -c "import flask" >nul 2>&1
if errorlevel 1 (
    echo Flask not found, installing Python dependencies...
    cd backend
    %PYCMD% -m pip install -r requirements.txt
    if errorlevel 1 (
        echo ERROR: pip install failed
        cd ..
        pause
        exit /b 1
    )
    cd ..
    echo Done.
)

:: Verify LibreOffice
%PYCMD% -c "import shutil; exit(0 if shutil.which('soffice') or __import__('os').path.exists(r'C:\Program Files\LibreOffice\program\soffice.exe') else 1)" >nul 2>&1
if errorlevel 1 (
    echo WARNING: LibreOffice not found - Office format conversion unavailable
) else (
    echo LibreOffice: OK
)

echo.
echo Starting DocForge...
echo.

:: Use npmmirror for faster download
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/

npx electron . --dev

if errorlevel 1 (
    echo.
    echo ERROR: Electron failed to start.
)
pause
