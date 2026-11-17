@echo off
rem Запуск бенчмарка. Аргументы передаются в run_all.py, например:
rem   start.bat                 - все тесты
rem   start.bat --gpu-only      - только ROCm и DirectML
rem   start.bat --resume last   - продолжить прерванный прогон
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PYEXE="
py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PYEXE=py -3"
if defined PYEXE goto run
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul
if not errorlevel 1 set "PYEXE=python"
if defined PYEXE goto run

echo.
echo Не найден Python 3.10 или новее.
echo Установите Python с https://www.python.org/downloads/windows/ (галочка "Add python.exe to PATH")
echo и запустите start.bat снова. Глобальный Python бенчмарк не изменяет:
echo все библиотеки ставятся в папки .tools и .envs внутри этого каталога.
echo.
pause
exit /b 1

:run
%PYEXE% run_all.py %*
set "RC=%errorlevel%"
echo.
echo Завершено с кодом %RC%. Отчёт: папка runs\(дата_время)\summary.html
pause
exit /b %RC%
