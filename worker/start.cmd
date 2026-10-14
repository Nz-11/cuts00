@echo off
rem Inicia o worker (ou passa um comando: check, download-model, run --once).
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo [ERRO] Worker nao instalado. Rode primeiro: worker\setup.cmd
  exit /b 1
)
".venv\Scripts\python.exe" -m cca_worker %*
