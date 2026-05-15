@echo off
title DocForge Build

cd /d "%~dp0.."

echo ============================================
echo   DocForge - Build Windows Installer
echo ============================================
echo.

echo [1/3] Finding Python...
set PYCMD=

where py >nul 2>&1
if not errorlevel 1 set PYCMD=py

if "%PYCMD%"=="" where python >nul 2>&1
if not errorlevel 1 set PYCMD=python

if "%PYCMD%"=="" where python3 >nul 2>&1
if not errorlevel 1 set PYCMD=python3

if "%PYCMD%"=="" (
    echo ERROR: Python not found. Run setup.bat first.
    pause
    exit /b 1
)
echo OK - using: %PYCMD%

echo.
echo [2/3] Building Python backend (PyInstaller)...
echo This may take a few minutes...

cd backend
if not exist "dist\" mkdir dist

%PYCMD% -m PyInstaller --onefile --console --name server --add-data "engine;engine" --hidden-import flask --hidden-import flask_cors --hidden-import pikepdf --hidden-import PyPDF2 --hidden-import pdfplumber --hidden-import reportlab --hidden-import docx --hidden-import openpyxl --hidden-import pptx --hidden-import PIL --hidden-import ezdxf --collect-all pikepdf --clean server.py

if errorlevel 1 (
    echo.
    echo ERROR: PyInstaller build failed.
    echo First run: %PYCMD% -m pip install pyinstaller
    cd ..
    pause
    exit /b 1
)
echo OK - server.exe built
cd ..

echo.
echo [3/3] Building Electron app...
echo This may take a few minutes...

:: Use npmmirror for China - much faster
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

call npx electron-builder --win
if errorlevel 1 (
    echo ERROR: Electron build failed.
    echo Make sure npm install completed successfully.
    pause
    exit /b 1
)

echo.
echo ============================================
echo   BUILD COMPLETE
echo.
echo   Installer location: dist\
echo   Double-click the .exe to install.
echo   A desktop shortcut will be created.
echo ============================================
pause
