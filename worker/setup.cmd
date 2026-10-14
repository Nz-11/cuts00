@echo off
rem Instala o worker: cria worker\.venv e instala o faster-whisper.
setlocal
cd /d "%~dp0"
set "PY="
where py >nul 2>nul && py -3.12 --version >nul 2>nul && set "PY=py -3.12"
if not defined PY if exist "%LOCALAPPDATA%\Programs\Python\Python312\python.exe" set "PY="%LOCALAPPDATA%\Programs\Python\Python312\python.exe""
if not defined PY where python >nul 2>nul && python -c "import sys; sys.exit(sys.version_info < (3, 11))" >nul 2>nul && set "PY=python"
if not defined PY (
  echo [ERRO] Python 3.11+ nao encontrado. Instale com:  winget install -e --id Python.Python.3.12
  exit /b 1
)
if not exist ".venv\Scripts\python.exe" (
  echo Criando ambiente virtual em worker\.venv ...
  %PY% -m venv .venv || exit /b 1
)
".venv\Scripts\python.exe" -m pip install --disable-pip-version-check -r requirements.txt || exit /b 1
echo.
echo Instalado. Proximos passos:
echo   1. worker\start.cmd download-model   (baixa o modelo, uma vez)
echo   2. worker\start.cmd check            (diagnostico)
echo   3. worker\start.cmd                  (inicia o worker)
