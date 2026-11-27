@echo off
rem claclaw installer for Windows: downloads install.ps1 from relay.165i.com and runs it.
rem Download from https://relay.165i.com/claclaw and double-click. Running it again updates claclaw.
rem Kept ASCII-only: cmd reads .cmd files in the OEM code page.
title claclaw installer
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12; $ProgressPreference = 'SilentlyContinue'; try { iex (irm 'https://relay.165i.com/claclaw/install.ps1') } catch { Write-Host ('Download failed: ' + $_.Exception.Message) -ForegroundColor Red }"
echo.
pause
