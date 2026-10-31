@echo off
setlocal
set "PLAYER_NODE=node"
where node >nul 2>nul
if errorlevel 1 set "PLAYER_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%~dp0adaptive-eq\node_modules\vite\package.json" (
  echo Dependencies are missing. Run pnpm install inside adaptive-eq first.
  pause
  exit /b 1
)
"%PLAYER_NODE%" "%~dp0adaptive-eq\scripts\dev.mjs" --open
if errorlevel 1 pause
