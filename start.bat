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
echo ========================================
echo   CRM - Система учёта квалификаций
echo ========================================
echo.

REM ===== 1. Поиск Python =====
set "PYEXE="
for %%V in (313 312 311 310) do (
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
  echo [ERROR] Python не найден!
  echo.
  echo Установите Python 3.10+ с https://python.org
  echo При установке отметьте "Add Python to PATH"
  echo.
  pause
  exit /b 1
)

echo Python: %PYEXE%
"%PYEXE%" --version

REM ===== 2. Проверка и обновление pip =====
echo.
echo [1/3] Проверка pip...
"%PYEXE%" -m pip --version >nul 2>nul
if errorlevel 1 (
  echo   Установка pip...
  "%PYEXE%" -m ensurepip --upgrade >nul 2>nul
)
"%PYEXE%" -m pip install --upgrade pip >nul 2>nul

REM ===== 3. Установка зависимостей =====
echo.
echo [2/3] Проверка зависимостей...
set "NEED_INSTALL=0"

REM Проверяем каждую зависимость отдельно
"%PYEXE%" -c "import openpyxl" 2>nul
if errorlevel 1 (
  echo   - openpyxl: НЕ найден, будет установлен
  set "NEED_INSTALL=1"
) else (
  echo   - openpyxl: OK
)

"%PYEXE%" -c "import xlrd" 2>nul
if errorlevel 1 (
  echo   - xlrd: НЕ найден, будет установлен
  set "NEED_INSTALL=1"
) else (
  echo   - xlrd: OK
)

REM Проверяем версию openpyxl (нужна 3.1+)
"%PYEXE%" -c "import openpyxl; exit(0 if openpyxl.__version__ >= '3.1' else 1)" 2>nul
if errorlevel 1 (
  echo   - openpyxl: версия устарела, будет обновлена
  set "NEED_INSTALL=1"
)

if "%NEED_INSTALL%"=="1" (
  echo.
  echo   Установка зависимостей...
  "%PYEXE%" -m pip install "openpyxl>=3.1.0" "xlrd>=2.0.1"
  if errorlevel 1 (
    echo.
    echo [ERROR] Не удалось установить зависимости!
    echo Попробуйте вручную: pip install openpyxl xlrd
    pause
    exit /b 1
  )
  echo   Зависимости установлены.
) else (
  echo   Все зависимости установлены.
)

REM ===== 4. Проверка структуры проекта =====
echo.
echo [3/3] Проверка структуры проекта...
if not exist "server\app.py" (
  echo [ERROR] Не найден server\app.py
  echo Запустите этот файл из папки проекта CRM.
  pause
  exit /b 1
)
if not exist "server\db.py" (
  echo [ERROR] Не найден server\db.py
  pause
  exit /b 1
)
if not exist "dashboard.html" (
  echo [ERROR] Не найден dashboard.html
  pause
  exit /b 1
)
echo   Структура проекта: OK

REM ===== 5. Проверка порта =====
echo.
echo Проверка порта %CRM_PORT%...
netstat -ano | findstr ":%CRM_PORT% " | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo   Внимание: порт %CRM_PORT% уже занят.
  echo   Возможно, CRM уже запущен. Откройте http://127.0.0.1:%CRM_PORT%/
  echo.
  set /p "ANSWER=Запустить ещё один экземпляр на порту 8789? (y/n): "
  if /i "%ANSWER%"=="y" (
    set "CRM_PORT=8789"
  ) else (
    pause
    exit /b 0
  )
)

REM ===== 6. Запуск =====
echo.
echo ========================================
echo   CRM запускается...
echo   Адрес: http://%CRM_HOST%:%CRM_PORT%/
echo   Закройте это окно для остановки.
echo ========================================
echo.

"%PYEXE%" server\app.py

echo.
echo ========================================
echo   CRM остановлен.
echo ========================================
pause
