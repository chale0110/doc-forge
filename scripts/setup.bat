@echo off
title DocForge Setup

echo ============================================
echo   DocForge Setup
echo ============================================
echo.

echo [1/4] Checking Node.js...
where node >nul 2>&1
if errorlevel 1 goto NO_NODE
echo OK
goto CHECK_PYTHON

:NO_NODE
echo ERROR: Node.js not found.
echo Download from https://nodejs.org
pause
exit /b 1

:CHECK_PYTHON
echo [2/4] Checking Python...
set PYCMD=

where py >nul 2>&1
if errorlevel 1 goto TRY_PYTHON
set PYCMD=py
goto PY_FOUND

:TRY_PYTHON
where python >nul 2>&1
if errorlevel 1 goto TRY_PYTHON3
set PYCMD=python
goto PY_FOUND

:TRY_PYTHON3
where python3 >nul 2>&1
if errorlevel 1 goto PY_NOT_FOUND
set PYCMD=python3
goto PY_FOUND

:PY_NOT_FOUND
echo ERROR: Python not found in PATH.
echo.
echo You said you have Python 3.12 64-bit.
echo Please re-run the installer and check:
echo   [x] Add Python to PATH
echo.
echo Or open a NEW Command Prompt and type:  py --version
echo If that works, Python is installed but not on PATH.
echo In that case, manually edit this file and replace
echo "py" with the full path to your python.exe
pause
exit /b 1

:PY_FOUND
echo OK - found: %PYCMD%

:INSTALL_NODE
echo.
echo [3/4] Installing Node dependencies...

:: Use npmmirror for China - much faster
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

cd /d "%~dp0.."
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed
    pause
    exit /b 1
)
echo OK  (deprecated warnings above are normal, not errors)

:INSTALL_PYTHON
echo.
echo [4/4] Installing Python dependencies...
cd backend
%PYCMD% -m pip install -r requirements.txt
if errorlevel 1 (
    echo WARNING: Some packages failed. You can retry later.
)
cd ..
echo OK

:CHECK_LO
echo.
echo Checking LibreOffice...
where soffice >nul 2>&1
if errorlevel 1 (
    if exist "C:\Program Files\LibreOffice\program\soffice.exe" goto LO_OK
    if exist "C:\Program Files (x86)\LibreOffice\program\soffice.exe" goto LO_OK
    echo WARNING: LibreOffice not found.
    echo Office format conversion (docx/xlsx/pptx) will not work.
    echo Download: https://www.libreoffice.org/download/
    goto DONE
)
:LO_OK
echo OK - LibreOffice found

:DONE
echo.
echo ============================================
echo   Setup complete.
echo   Next: double-click dev.bat to start
echo ============================================
pause
