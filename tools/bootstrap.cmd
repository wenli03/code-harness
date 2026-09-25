@echo off
rem Windows 引导脚本：装依赖 + 类型自检。
rem 关键：必须先清空 NODE_OPTIONS —— IDE 注入的语言 shim 会让包管理器卡死。
set "NODE_OPTIONS="

cd /d "%~dp0.."

echo [bootstrap] cwd=%CD%
node --version
npm --version

call npm install --no-audit --no-fund
if errorlevel 1 goto :failed

call npm run typecheck
if errorlevel 1 goto :failed

echo [bootstrap] 完成。启动开发模式：npm run dev
exit /b 0

:failed
echo [bootstrap] 失败，请查看上方输出。
exit /b 1
