# claclaw Windows 一键安装 / 更新
#   用法（任选一种）：
#     - 下载仓库里的 install/claclaw-install.cmd，双击
#     - 在 PowerShell 里：irm https://raw.githubusercontent.com/wyidong/claclaw/main/install/install-win.ps1 | iex
#   做的事：检查电脑环境 → 没有就装 Node.js（v24，装在用户目录，不用管理员）和 Git → 下载 claclaw 代码 → npm install
#           → 在后台启动（第一次启动时 claclaw 自己设好开机启动）→ 桌面和开始菜单放「claclaw」图标 → 打开浏览器
#   再跑一遍就是更新（git pull、npm install，所有会话空闲后重启）。日志在 %LOCALAPPDATA%\claclaw\Logs\install.log
#   国内网络：连官方源慢或连不上时自动用国内镜像（npmmirror）；GitHub 连不上、又配了代码包镜像（$MIRROR）就从镜像取代码包
#   测试用环境变量：CLACLAW_INSTALL_DIR（装到哪）、CLACLAW_INSTALL_NODE_DIR（Node 装到哪）、CLACLAW_INSTALL_NOSTART=1（装完不启动、不放图标、不开浏览器）、
#                   CLACLAW_INSTALL_FORCE_NODE=1（已有 Node 也重新下载，配合 CLACLAW_INSTALL_NODE_DIR 用；不改用户的 PATH）
# 这个文件经 irm | iex 执行：不能用 param、不能 exit（会把用户的 PowerShell 窗口关掉），全部包在一个脚本块里

& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1 显示下载进度条会让下载慢几十倍
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}

$NODE_MAJOR = 24                       # 装哪个大版本（claclaw 平时就在这上面跑）
$NODE_MIN = [version]'22.13.0'         # 已经装了、够这个版本就不另装（DeepSeek、OpenCode 等要 22.13+）
$REPO = 'https://github.com/wyidong/claclaw.git'
# 代码包镜像（可选，默认不用）：GitHub 连不上时从 $MIRROR/claclaw.bundle（和 claclaw.bundle.sha256）取代码；转发这个脚本的网站可以填上自己的地址（不带末尾 /）
$MIRROR = ''
$PORT = 8787
$LOGDIR = Join-Path $env:LOCALAPPDATA 'claclaw\Logs'
$DIR = if ($env:CLACLAW_INSTALL_DIR) { $env:CLACLAW_INSTALL_DIR } else { Join-Path $env:USERPROFILE 'claclaw' }
$NODE_HOME = if ($env:CLACLAW_INSTALL_NODE_DIR) { $env:CLACLAW_INSTALL_NODE_DIR } else { Join-Path $env:LOCALAPPDATA 'Programs\nodejs' }
$NOSTART = $env:CLACLAW_INSTALL_NOSTART -eq '1'

New-Item -ItemType Directory -Force $LOGDIR | Out-Null
$LOG = Join-Path $LOGDIR 'install.log'
function Log($s) { try { Add-Content -Path $LOG -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $s) -Encoding UTF8 } catch {} }
function Step($s) { Write-Host ''; Write-Host ('>> ' + $s) -ForegroundColor Cyan; Log ('== ' + $s) }
function Ok($s) { Write-Host ('   ' + $s) -ForegroundColor Green; Log ('   ok ' + $s) }
function Info($s) { Write-Host ('   ' + $s); Log ('   ' + $s) }
function Warn($s) { Write-Host ('   ' + $s) -ForegroundColor Yellow; Log ('   warn ' + $s) }
# 出错时给用户看的一句话（不甩报错堆栈），细节进日志
function Fail($s) { throw [Exception]::new($s) }

# 从注册表重新读 PATH（刚装的 Git、Node 在这个窗口里也能找到）
function Refresh-Path {
  $m = [Environment]::GetEnvironmentVariable('Path', 'Machine'); $u = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = (@($m, $u) | Where-Object { $_ }) -join ';'
}
# 下载：最多试 3 次；出错说清楚是哪个网址
function Get-File($url, $out) {
  for ($i = 1; $i -le 3; $i++) {
    try { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $out -TimeoutSec 600 -Headers @{ 'User-Agent' = 'claclaw-installer' }; return } catch {
      Log ("   下载失败（第 $i 次）$url ：" + $_.Exception.Message)
      if ($i -eq 3) { Fail "下载失败：$url。请检查网络后再运行一次。" }
      Start-Sleep -Seconds 3
    }
  }
}
# 网址多快能连上（毫秒；连不上返回 -1）
function Probe($url) {
  $sw = [Diagnostics.Stopwatch]::StartNew()
  try { Invoke-WebRequest -UseBasicParsing -Uri $url -Method Head -TimeoutSec 8 -Headers @{ 'User-Agent' = 'claclaw-installer' } | Out-Null; return [int]$sw.ElapsedMilliseconds } catch { return -1 }
}
function Sha256($f) { (Get-FileHash -Algorithm SHA256 -Path $f).Hash.ToLower() }
# 跑命令行程序（git、npm、tar），输出进日志，返回退出码。
# 要临时把 ErrorActionPreference 放回 Continue：PowerShell 5.1 里程序往 stderr 写一行（git 的进度就写在那）也会被当成出错中断
function Run($exe) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $exe @args 2>&1 | ForEach-Object { Log ('   | ' + $_) } } finally { $ErrorActionPreference = $old }
  return $global:LASTEXITCODE
}
function Port-Busy($p) { [bool](Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) }

Write-Host ''
Write-Host '  claclaw 安装程序' -ForegroundColor Cyan
Write-Host '  装好后用手机或这台电脑的浏览器接管电脑上的 AI 编程助手。全程大约 3-10 分钟，看网速。'
Log ('==== install start ' + (Get-Date -Format o) + ' dir=' + $DIR)

try {
  # ---------- 1. 检查电脑环境 ----------
  Step '检查电脑环境'
  $os = [Environment]::OSVersion.Version
  if ($os.Major -lt 10 -or $os.Build -lt 17763) { Fail ('这台电脑的 Windows 版本太旧（' + $os + '）。claclaw 需要 Windows 10（1809 及以后）或 Windows 11。') }
  $arch = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
  $ARCH = switch ($arch) { 'AMD64' { 'x64' } 'ARM64' { 'arm64' } default { '' } }
  if (-not $ARCH) { Fail ('不支持这种电脑（' + $arch + '）：claclaw 需要 64 位 Windows。') }
  $winName = if ($os.Build -ge 22000) { 'Windows 11' } else { 'Windows 10' }   # Windows 11 的主版本号也是 10，看内部版本号
  Ok ($winName + '（版本号 ' + $os.Build + '），' + $ARCH)
  $drive = (Split-Path -Qualifier $DIR).TrimEnd(':')
  $free = (Get-PSDrive -Name $drive -ErrorAction SilentlyContinue).Free
  if ($free -and $free -lt 1.5GB) { Fail ('磁盘 ' + $drive + ': 剩余空间不够（' + [math]::Round($free / 1GB, 1) + ' GB），至少要 1.5 GB。') }
  if ($free) { Ok ('磁盘 ' + $drive + ': 剩余 ' + [math]::Round($free / 1GB, 1) + ' GB') }

  # 网络：官方源慢（> 3 秒）或连不上就用国内镜像
  $tOff = Probe 'https://registry.npmjs.org/'
  $tCn = Probe 'https://registry.npmmirror.com/'
  if ($tOff -lt 0 -and $tCn -lt 0) { Fail '连不上网（npm 官方源和国内镜像都连不上）。请检查网络后再运行一次。' }
  $CN = ($tOff -lt 0) -or ($tOff -gt 3000 -and $tCn -ge 0)
  $NPM_REG = if ($CN) { 'https://registry.npmmirror.com/' } else { 'https://registry.npmjs.org/' }
  $NODE_DIST = if ($CN) { 'https://cdn.npmmirror.com/binaries/node' } else { 'https://nodejs.org/dist' }
  if ($CN) { Ok '网络正常，官方源较慢：用国内镜像下载' } else { Ok '网络正常' }

  # 已经装过：「启动」里 claclaw.vbs 指向的目录就是原来装的地方
  $startupVbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'claclaw.vbs'
  if (-not $env:CLACLAW_INSTALL_DIR -and (Test-Path $startupVbs)) {
    $m = [regex]::Match((Get-Content $startupVbs -Raw -Encoding Unicode), 'CurrentDirectory = "([^"]+)"')
    if ($m.Success -and (Test-Path (Join-Path $m.Groups[1].Value 'server.mjs'))) { $DIR = $m.Groups[1].Value }
  }
  $UPDATE = Test-Path (Join-Path $DIR '.git')
  if ($UPDATE) { Ok ('已经装过（' + $DIR + '）：这次是更新') }

  # ---------- 2. Node.js ----------
  Step '检查 Node.js'
  $node = $null
  $own = Join-Path $NODE_HOME 'node.exe'
  $cands = @($own) + @(Get-Command node.exe -All -ErrorAction SilentlyContinue | ForEach-Object { $_.Source })
  if ($env:CLACLAW_INSTALL_FORCE_NODE -eq '1') { $cands = @() }   # 测试：不管有没有都重新下载
  foreach ($c in $cands) {
    if (-not $c -or -not (Test-Path $c)) { continue }
    try { $v = [version]((& $c -v).Trim().TrimStart('v')) } catch { continue }
    if ($v -ge $NODE_MIN) { $node = $c; Ok ('已有 Node.js ' + $v + '（' + $c + '）'); break } else { Info ('有 Node.js ' + $v + '，版本太低（要 ' + $NODE_MIN + ' 以上），另装一份新的，不动原来的') }
  }
  if (-not $node) {
    Info '正在查最新的 Node.js 版本...'
    $idx = Invoke-RestMethod -Uri "$NODE_DIST/index.json" -TimeoutSec 60
    $rel = $idx | Where-Object { $_.lts -and $_.version -like "v$NODE_MAJOR.*" -and ($_.files -contains "win-$ARCH-zip") } | Select-Object -First 1
    if (-not $rel) { Fail "找不到 Node.js $NODE_MAJOR 的安装包。" }
    $ver = $rel.version; $name = "node-$ver-win-$ARCH"
    $tmp = Join-Path $env:TEMP ('claclaw-node-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Force $tmp | Out-Null
    Info "正在下载 Node.js $ver（约 35 MB）..."
    Get-File "$NODE_DIST/$ver/$name.zip" "$tmp\$name.zip"
    Get-File "$NODE_DIST/$ver/SHASUMS256.txt" "$tmp\SHASUMS256.txt"
    $hit = Select-String -Path "$tmp\SHASUMS256.txt" -Pattern "^([0-9a-f]{64})\s+$name\.zip$" | Select-Object -First 1
    $want = if ($hit) { $hit.Matches[0].Groups[1].Value } else { '' }
    if (-not $want -or $want -ne (Sha256 "$tmp\$name.zip")) { Fail 'Node.js 安装包校验没通过（可能下载坏了）。请再运行一次。' }
    Info '正在解压...'
    # 系统自带的 tar 解 zip 比 Expand-Archive 快得多；没有 tar 再用 Expand-Archive
    $tar = Join-Path $env:WINDIR 'System32\tar.exe'
    $rc = if (Test-Path $tar) { Run $tar -xf "$tmp\$name.zip" -C $tmp } else { 1 }
    if ($rc -ne 0 -or -not (Test-Path "$tmp\$name\node.exe")) { Expand-Archive -Path "$tmp\$name.zip" -DestinationPath $tmp -Force }
    if (-not (Test-Path "$tmp\$name\node.exe")) { Fail 'Node.js 安装包解压失败。请再运行一次。' }
    if (Test-Path $NODE_HOME) { Remove-Item -Recurse -Force $NODE_HOME }
    New-Item -ItemType Directory -Force (Split-Path $NODE_HOME) | Out-Null
    Move-Item "$tmp\$name" $NODE_HOME
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    # 加进用户的 PATH（放最前面），以后开的命令行窗口也能用 node、npm
    $up = [Environment]::GetEnvironmentVariable('Path', 'User')
    if ($env:CLACLAW_INSTALL_FORCE_NODE -ne '1' -and -not (($up -split ';') -contains $NODE_HOME)) { [Environment]::SetEnvironmentVariable('Path', (@($NODE_HOME, $up) | Where-Object { $_ }) -join ';', 'User') }
    $node = $own
    Ok "Node.js $ver 装好了（$NODE_HOME）"
  }
  $NODE_DIR = Split-Path $node
  $npm = Join-Path $NODE_DIR 'npm.cmd'
  if (-not (Test-Path $npm)) { Fail ('找不到 npm（' + $npm + '）。请重新安装 Node.js 后再运行一次。') }
  $env:Path = $NODE_DIR + ';' + $env:Path

  # ---------- 3. Git ----------
  Step '检查 Git'
  $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
  if (-not $git) {
    foreach ($d in @("$env:ProgramFiles\Git\cmd", "$env:LOCALAPPDATA\Programs\Git\cmd")) { if (Test-Path "$d\git.exe") { $git = "$d\git.exe"; break } }
  }
  if ($git) { Ok ('已有 ' + (& $git --version)) } else {
    Info '正在查最新的 Git 版本...'
    $list = Invoke-RestMethod -Uri 'https://registry.npmmirror.com/-/binary/git-for-windows/' -TimeoutSec 60
    $gv = $list | Where-Object { $_.name -match '^v(\d+)\.(\d+)\.(\d+)\.windows\.(\d+)/$' } | Sort-Object { $m = [regex]::Match($_.name, '^v(\d+)\.(\d+)\.(\d+)\.windows\.(\d+)'); [version]('{0}.{1}.{2}.{3}' -f $m.Groups[1].Value, $m.Groups[2].Value, $m.Groups[3].Value, $m.Groups[4].Value) } | Select-Object -Last 1
    if (-not $gv) { Fail '找不到 Git 的安装包。' }
    $files = Invoke-RestMethod -Uri ('https://registry.npmmirror.com/-/binary/git-for-windows/' + $gv.name) -TimeoutSec 60
    $pat = if ($ARCH -eq 'arm64') { '^Git-[\d.]+-arm64\.exe$' } else { '^Git-[\d.]+-64-bit\.exe$' }
    $f = $files | Where-Object { $_.name -match $pat } | Select-Object -First 1
    if (-not $f) { Fail '找不到 Git 的安装包。' }
    $exe = Join-Path $env:TEMP $f.name
    Info ('正在下载 ' + $f.name + '（约 65 MB）...')
    Get-File $f.url $exe
    if ((Get-Item $exe).Length -ne [long]$f.size) { Fail 'Git 安装包大小不对（可能下载坏了）。请再运行一次。' }
    # 镜像上没有校验值：认 Git for Windows 发布者（Johannes Schindelin）的数字签名
    $sig = Get-AuthenticodeSignature $exe
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'Johannes Schindelin') { Fail ('Git 安装包的数字签名不对（' + $sig.Status + '）。请再运行一次。') }
    Info '正在安装 Git（装在你的用户目录，不用管理员；要 1-2 分钟）...'
    $p = Start-Process -FilePath $exe -ArgumentList '/VERYSILENT', '/NORESTART', '/NOCANCEL', '/SP-', '/SUPPRESSMSGBOXES', '/CURRENTUSER', '/o:PathOption=Cmd' -Wait -PassThru
    Remove-Item $exe -ErrorAction SilentlyContinue
    Refresh-Path; $env:Path = $NODE_DIR + ';' + $env:Path
    $git = (Get-Command git.exe -ErrorAction SilentlyContinue).Source
    if (-not $git) { foreach ($d in @("$env:LOCALAPPDATA\Programs\Git\cmd", "$env:ProgramFiles\Git\cmd")) { if (Test-Path "$d\git.exe") { $git = "$d\git.exe"; break } } }
    if (-not $git) { Fail ('Git 没装上（安装程序退出码 ' + $p.ExitCode + '）。可以到 https://git-scm.com 手动装好后再运行一次。') }
    Ok ('Git 装好了：' + (& $git --version))
  }

  # ---------- 4. claclaw 代码 ----------
  if ($UPDATE) {
    Step '更新 claclaw 代码'
    $before = (& $git -C $DIR rev-parse --short HEAD)
    $rc = Run $git -C $DIR -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 pull --ff-only
    if ($rc -ne 0) { Warn '从 GitHub 更新没成功（网络或本地改过代码）：先用现有的版本，稍后可以再运行一次' } else {
      $after = (& $git -C $DIR rev-parse --short HEAD)
      if ($before -eq $after) { Ok ('已经是最新（' + $after + '）') } else { Ok ('从 ' + $before + ' 更新到 ' + $after) }
    }
  } else {
    Step '下载 claclaw'
    if ((Test-Path $DIR) -and (Get-ChildItem $DIR -Force | Select-Object -First 1)) { Fail ($DIR + ' 已经存在，里面还有别的文件。请把它改名或挪走后再运行一次。') }
    Info '从 GitHub 下载...'
    $rc = Run $git -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=20 clone $REPO $DIR
    if ($rc -ne 0 -or -not (Test-Path (Join-Path $DIR 'server.mjs'))) {
      if (-not $MIRROR) { Fail 'GitHub 连不上，下载不了 claclaw。请检查网络后再运行一次。' }
      Warn 'GitHub 连不上，改从代码包镜像下载...'
      if (Test-Path $DIR) { Remove-Item -Recurse -Force $DIR }
      $b = Join-Path $env:TEMP 'claclaw.bundle'
      Get-File "$MIRROR/claclaw.bundle" $b
      Get-File "$MIRROR/claclaw.bundle.sha256" "$b.sha256"
      $want = ((Get-Content "$b.sha256" -Raw).Trim() -split '\s+')[0].ToLower()
      if ($want -ne (Sha256 $b)) { Fail '代码包校验没通过（可能下载坏了）。请再运行一次。' }
      if ((Run $git clone $b $DIR) -ne 0) { Fail '代码包解不开。请再运行一次。' }
      Run $git -C $DIR remote set-url origin $REPO | Out-Null   # 以后照常从 GitHub 更新
      Remove-Item $b, "$b.sha256" -ErrorAction SilentlyContinue
    }
    Ok ('下载好了（' + $DIR + '）')
  }

  # ---------- 5. 依赖 ----------
  Step '安装 claclaw 用到的组件（npm install）'
  Push-Location $DIR
  try {
    if ((Run $npm install --no-audit --no-fund --registry $NPM_REG) -ne 0) { Fail ('组件没装好（npm install 出错）。细节在 ' + $LOG + '，请再运行一次。') }
  } finally { Pop-Location }
  Ok '组件装好了'

  if ($NOSTART) { Ok '（测试：不启动）'; return }

  # ---------- 6. 启动 ----------
  Step '启动 claclaw'
  $running = Port-Busy $PORT
  if ($running -and $UPDATE) {
    # 正在用的会话不打断：等所有会话空闲 30 秒后自动重启
    Push-Location $DIR; try { $rc = Run $node tools\restart-when-idle.mjs 安装程序更新 } finally { Pop-Location }
    if ($rc -eq 0) { Ok 'claclaw 正在运行：等所有会话空闲 30 秒后自动重启，更新就生效了' } else { Warn '没能排上重启：重启电脑后更新生效' }
  } elseif ($running) {
    Warn ('端口 ' + $PORT + ' 已经被别的程序占着，claclaw 起不来。关掉那个程序后，双击桌面上的 claclaw 图标就能启动。')
  } else {
    # 用守护在后台跑（挂了自动拉起）；第一次启动时 claclaw 自己在「启动」文件夹放 claclaw.vbs，以后开机自动启动
    Start-Process -FilePath $node -ArgumentList 'tools\win-serve.mjs' -WorkingDirectory $DIR -WindowStyle Hidden
    $up = $false
    for ($i = 0; $i -lt 45 -and -not $up; $i++) { Start-Sleep -Seconds 2; try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "http://127.0.0.1:$PORT/login").StatusCode -eq 200 } catch {} }
    if (-not $up) { Fail ('claclaw 90 秒内没启动起来。日志在 ' + (Join-Path $LOGDIR 'server.log')) }
    Ok ('已在后台运行，以后开机会自动启动')
  }

  # ---------- 7. 桌面和开始菜单的图标 ----------
  Step '放桌面图标'
  $ico = Join-Path $env:LOCALAPPDATA 'claclaw\claclaw.ico'
  try {
    # 把网页图标（PNG）包成 .ico：Windows Vista 以后的 .ico 可以直接装 PNG
    $png = [IO.File]::ReadAllBytes((Join-Path $DIR 'public\icons\icon-192.png'))
    $ms = New-Object IO.MemoryStream; $w = New-Object IO.BinaryWriter($ms)
    $w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]1)
    $w.Write([byte]192); $w.Write([byte]192); $w.Write([byte]0); $w.Write([byte]0); $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$png.Length); $w.Write([uint32]22); $w.Write($png); $w.Flush()
    [IO.File]::WriteAllBytes($ico, $ms.ToArray())
  } catch { $ico = $null; Log ('   图标没做成：' + $_.Exception.Message) }
  $wsh = New-Object -ComObject WScript.Shell
  # 桌面上已经有一个 claclaw（多半是浏览器「安装为应用」放的网页快捷方式）就不覆盖，开始菜单里照样放
  $spots = @()
  $desk = Join-Path ([Environment]::GetFolderPath('Desktop')) 'claclaw.lnk'
  if (-not (Test-Path $desk) -or ($wsh.CreateShortcut($desk).Arguments -match 'open-claclaw\.vbs')) { $spots += $desk } else { Info '桌面上已经有 claclaw 图标，不覆盖' }
  $spots += (Join-Path ([Environment]::GetFolderPath('Programs')) 'claclaw.lnk')
  foreach ($s in $spots) {
    $l = $wsh.CreateShortcut($s)
    $l.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
    $l.Arguments = '"' + (Join-Path $DIR 'tools\open-claclaw.vbs') + '"'
    $l.WorkingDirectory = $DIR
    $l.Description = '打开 claclaw（没在运行就先启动）'
    if ($ico) { $l.IconLocation = $ico + ',0' }
    $l.Save()
  }
  Ok '双击桌面上的 claclaw 就能打开（没在运行会先自动启动）'

  # ---------- 8. 打开 ----------
  Step '完成'
  Write-Host ''
  Write-Host '  claclaw 装好了！' -ForegroundColor Green
  Write-Host ("  正在打开 http://127.0.0.1:$PORT —— 第一次打开请按提示设登录账号。")
  Write-Host '  以后：开机会自动启动；双击桌面上的 claclaw 打开。'
  Write-Host '  手机怎么连上：打开后在网页的「设置」里看 clarelay 或 Tailscale 的说明。'
  Log '==== install ok'
  if (-not $UPDATE) { Start-Process "http://127.0.0.1:$PORT/" }
} catch {
  Log ('==== install failed: ' + $_.Exception.Message + "`r`n" + $_.ScriptStackTrace)
  Write-Host ''
  Write-Host ('  安装没完成：' + $_.Exception.Message) -ForegroundColor Red
  Write-Host ('  详细记录在 ' + $LOG + '，可以把它发给帮你装的人。')
}
}
