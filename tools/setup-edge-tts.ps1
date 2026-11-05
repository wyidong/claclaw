# 装上微软在线语音（晓伊、晓晓、云希…）的 Windows 版：在 claclaw 的 data 目录里建一个独立的 Python 环境，装 edge-tts。
# 再跑一次就是升级（微软改了接口导致念不出来时，升级通常能修好）。不装也行：网页会用浏览器自带的声音念。
# 用法（在 claclaw 目录里）：powershell -ExecutionPolicy Bypass -File tools\setup-edge-tts.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$data = if ($env:CLACLAW_DATA) { $env:CLACLAW_DATA } else { Join-Path $root 'data' }
$dir = Join-Path $data 'edge-tts'
$venvPy = Join-Path $dir 'venv\Scripts\python.exe'

if (-not (Test-Path $venvPy)) {
  # 找一个真的 Python 3：先用 py 启动器；python 可能是微软商店的占位（WindowsApps 里，一跑就让去商店装），要试一下能不能跑
  $base = $null
  foreach ($c in @(@('py', '-3'), @('python'), @('python3'))) {
    if (-not (Get-Command $c[0] -ErrorAction SilentlyContinue)) { continue }
    $args0 = @($c | Select-Object -Skip 1)
    $ok = $false
    try { $ErrorActionPreference = 'Continue'; $null = & $c[0] @args0 -c 'import sys; assert sys.version_info >= (3, 8)' 2>$null; $ok = $LASTEXITCODE -eq 0 } catch {} finally { $ErrorActionPreference = 'Stop' }
    if ($ok) { $base = $c; break }
  }
  if (-not $base) {
    Write-Host '没找到 Python 3.8 以上。先装 Python（https://www.python.org/downloads/ 或 winget install Python.Python.3.12），再运行一次。'
    Write-Host '不装也没关系：朗读会用浏览器自带的声音。'
    exit 1
  }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $args1 = @($base | Select-Object -Skip 1)
  & $base[0] @args1 -m venv (Join-Path $dir 'venv')
  if ($LASTEXITCODE -ne 0) { throw '建 Python 环境失败' }
}
& $venvPy -m pip install -q --upgrade edge-tts
if ($LASTEXITCODE -ne 0) { throw '装 edge-tts 失败（要联网）' }
$ver = & $venvPy -c 'import edge_tts; print(edge_tts.__version__)'
Write-Host "装好了：edge-tts $ver。网页设置 → 语音里就能选微软的声音（不用重启 claclaw）"
