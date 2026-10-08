@echo off
chcp 65001 >nul
cd /d "%~dp0"
title CRM

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "CRM_OPEN_BROWSER=1"
set "CRM_HOST=127.0.0.1"
set "CRM_PORT=8788"

echo.
echo CRM
echo.

REM Find Python
set "PYEXE="
for %%V in (312 311 310) do (
  if exist "%LocalAppData%\Programs\Python\Python%%V\python.exe" set "PYEXE=%LocalAppData%\Programs\Python\Python%%V\python.exe"
  if exist "%ProgramFiles%\Python%%V\python.exe" set "PYEXE=%ProgramFiles%\Python%%V\python.exe"
)
if not defined PYEXE (
  where py >nul 2>nul && for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PYEXE=%%P"
)
if not defined PYEXE (
  where python >nul 2>nul && for /f "delims=" %%P in ('where python 2^>nul') do set "PYEXE=%%P"
)
if not defined PYEXE (
  echo Python not found. Install Python 3.10+ from python.org
  pause
  exit /b 1
)

echo Python: %PYEXE%

REM Install dependencies if missing
"%PYEXE%" -c "import xlrd, openpyxl" 2>nul
if errorlevel 1 (
  echo Installing dependencies...
  "%PYEXE%" -m pip install xlrd openpyxl
)

echo Open: http://127.0.0.1:%CRM_PORT%/
echo Keep this window open.
echo.

"%PYEXE%" server\app.py

echo.
echo CRM stopped.
pause
