@echo off
rem claclaw installer for Windows: downloads install/install-win.ps1 from the claclaw repo and runs it.
rem Double-click to install; running it again updates claclaw.
rem Kept ASCII-only: cmd reads .cmd files in the OEM code page.
title claclaw installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; try { iex (irm 'https://raw.githubusercontent.com/wyidong/claclaw/main/install/install-win.ps1') } catch { Write-Host ('Download failed: ' + $_.Exception.Message) -ForegroundColor Red }"
echo.
pause
