@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title CRM

if /I "%~1"=="help" goto :help
if /I "%~1"=="check" set "CRM_CHECK=1"
if /I "%~1"=="lan" set "CRM_HOST=0.0.0.0"

set "PYTHONIOENCODING=utf-8"
set "PYTHONUTF8=1"
set "PYTHONUNBUFFERED=1"
set "CRM_OPEN_BROWSER=1"
if not defined CRM_HOST set "CRM_HOST=127.0.0.1"
if not defined CRM_PORT set "CRM_PORT=8788"
set "PYEXE="

echo.
echo CRM
echo Folder: %CD%
echo.

if not exist "server\app.py" (
  echo server\app.py not found. Copy the whole CRM folder, then run start.bat from it.
  goto :fail
)

call :find_python
if not defined PYEXE (
  echo Python 3.10+ not found.
  echo Install Python 3.12 from python.org and check "Add python.exe to PATH".
  echo Do not use the Microsoft Store stub.
  echo.
  call :offer_install
  call :find_python
)
if not defined PYEXE goto :fail

if defined CRM_CHECK (
  echo Python OK: %PYEXE%
  echo Ready. Run start.bat to open CRM.
  pause
  exit /b 0
)

echo Python: %PYEXE%

REM Check and install dependencies (xlrd, openpyxl)
echo Checking dependencies...
"%PYEXE%" -c "import xlrd, openpyxl" 2>nul
if errorlevel 1 (
  echo Installing dependencies (xlrd, openpyxl)...
  "%PYEXE%" -m pip install -r requirements.txt
  if errorlevel 1 (
    echo Failed to install dependencies. Check your internet connection.
    goto :fail
  )
  echo Dependencies installed.
)

echo Open:   http://127.0.0.1:%CRM_PORT%/
if /I "%CRM_HOST%"=="0.0.0.0" echo LAN mode: other laptops on the same Wi-Fi can open the Network URL from this window.
echo Keep this window open while using CRM.
echo.

"%PYEXE%" server\app.py
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo CRM failed to start. Exit code: %ERR%
  goto :fail
)
pause
exit /b 0

:fail
echo.
pause
exit /b 1

:help
echo.
echo start.bat
echo.
echo This computer:
echo   start.bat
echo.
echo Check Python without starting:
echo   start.bat check
echo.
echo Other laptop on the same Wi-Fi:
echo   start.bat lan
echo Then open the Network URL shown in this window on the second laptop.
echo.
echo New computer:
echo   1. Copy the whole CRM folder
echo   2. Install Python 3.12 from python.org, enable Add python.exe to PATH
echo   3. Double-click start.bat
echo   4. Leave the black window open
echo.
pause
exit /b 0

:offer_install
where winget >nul 2>nul
if errorlevel 1 goto :eof
echo Install Python 3.12 with winget now?  Y / N
set "ANS="
set /p ANS=
if /I "%ANS%"=="Y" goto :do_install
goto :eof

:do_install
echo Installing Python 3.12...
winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements
echo.
goto :eof

:find_python
set "PYEXE="
call :from_py_launcher
if defined PYEXE goto :eof

for %%V in (314 313 312 311 310) do (
  call :try_py "%LocalAppData%\Programs\Python\Python%%V\python.exe"
  if defined PYEXE goto :eof
  call :try_py "%ProgramFiles%\Python%%V\python.exe"
  if defined PYEXE goto :eof
  call :try_py "%ProgramFiles(x86)%\Python%%V-32\python.exe"
  if defined PYEXE goto :eof
)

for /f "delims=" %%P in ('where python 2^>nul') do (
  echo %%P | findstr /I /C:"WindowsApps" >nul
  if errorlevel 1 (
    call :try_py "%%P"
    if defined PYEXE goto :eof
  )
)
goto :eof

:from_py_launcher
where py >nul 2>nul
if errorlevel 1 goto :eof
set "CAND="
for /f "delims=" %%P in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "CAND=%%P"
if not defined CAND goto :eof
echo %CAND% | findstr /I /C:"WindowsApps" >nul
if not errorlevel 1 goto :eof
call :try_py "%CAND%"
goto :eof

:try_py
if not exist "%~1" goto :eof
"%~1" -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)" 1>nul 2>nul
if errorlevel 1 goto :eof
set "PYEXE=%~1"
goto :eof
