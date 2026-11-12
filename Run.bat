@echo off
cd /d "%~dp0"
echo Executor Kingjo v0.4
echo ==================
echo Starting application...
echo.
start "" "node_modules\electron\dist\electron.exe" .
echo.
echo Application launched. Check tray icon for status.
