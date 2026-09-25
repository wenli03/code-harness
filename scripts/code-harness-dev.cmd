@echo off
title Code Harness - dev
cd /d "%~dp0.."
call npm run dev
if errorlevel 1 (
  echo.
  echo [code-harness] dev 启动失败，按任意键关闭窗口。
  pause >nul
)
