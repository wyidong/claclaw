// claclaw 桌面版的外壳（Electron）：只做「把 claclaw 在这台电脑上跑起来」这件事
//   - 用安装包里自带的 node（resources/node）跑 claclaw 服务（resources/server/server.mjs），挂了自动拉起
//   - 数据放用户目录（%APPDATA%\claclaw\data；macOS ~/Library/Application Support/claclaw/data），更新换掉程序目录也不丢
//   - 托盘：打开 claclaw、开机自动启动、重启服务、查看日志、退出
//   - 只开一个：再点图标就是打开 claclaw 网页
//   - 第一次装好默认开机自动启动（登录后在后台跑，不弹网页）
// 手机等别的设备怎么连进来不归 claclaw 管（那是 clarelay 的事），这里不做
const { app, Tray, Menu, shell, dialog, nativeImage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const WIN = process.platform === 'win32';
const PORT = Number(process.env.CLACLAW_PORT) || 8787;   // 测试时可以换端口（server 也读这个环境变量）
const NO_AUTOSTART = process.env.CLACLAW_DESKTOP_NO_AUTOSTART === '1';   // 测试用：不碰系统的开机启动项
const HOME_URL = `http://127.0.0.1:${PORT}/`;
const HIDDEN = process.argv.includes('--hidden');   // 开机自动启动时带这个：只在后台跑，不打开网页

// 测试用：数据、日志放到别处（不碰这台电脑上真的 claclaw 桌面版数据）
if (process.env.CLACLAW_DESKTOP_USER_DIR) app.setPath('userData', process.env.CLACLAW_DESKTOP_USER_DIR);
if (!app.requestSingleInstanceLock()) { app.quit(); return; }

// 程序文件在哪：打包后在 resources/；开发时（npm run dev）用仓库本身和本机的 node
const RES = app.isPackaged ? process.resourcesPath : null;
const SERVER_DIR = RES ? path.join(RES, 'server') : path.resolve(__dirname, '..');
const NODE = RES ? path.join(RES, 'node', WIN ? 'node.exe' : path.join('bin', 'node')) : 'node';
const USER_DIR = app.getPath('userData');
// 这台电脑以前用脚本装过 claclaw（Windows：「启动」里 claclaw.vbs 指向的目录，或 %USERPROFILE%\claclaw）、已经建过账号：
// 桌面版直接用那份数据（账号、会话、设置都在），免得两边开机抢 8787，抢到的是一份没账号的新实例
function scriptData() {
  if (!WIN || process.env.CLACLAW_DESKTOP_USER_DIR) return null;   // 测试时不碰
  const dirs = [];
  try {
    const vbs = fs.readFileSync(path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'claclaw.vbs'), 'utf16le');
    const m = vbs.match(/^sh\.CurrentDirectory = "((?:[^"]|"")*)"/m); if (m) dirs.push(m[1].replace(/""/g, '"'));
  } catch {}
  dirs.push(path.join(app.getPath('home'), 'claclaw'));
  for (const d of dirs) if (fs.existsSync(path.join(d, 'server.mjs')) && fs.existsSync(path.join(d, 'data', 'auth.json'))) return path.join(d, 'data');
  return null;
}
const SCRIPT_DATA = scriptData();
const DATA = SCRIPT_DATA || path.join(USER_DIR, 'data');
const LOGS = path.join(USER_DIR, 'logs');
const STATE = path.join(USER_DIR, 'desktop.json');
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(LOGS, { recursive: true });

const readState = () => { try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = o => { try { fs.writeFileSync(STATE, JSON.stringify({ ...readState(), ...o }, null, 2)); } catch {} };
const LOG = path.join(LOGS, 'desktop.log');
const log = s => { try { fs.appendFileSync(LOG, new Date().toISOString() + ' ' + s + '\n'); } catch {} };

let tray = null, child = null, quitting = false, external = false, startedAt = 0, fails = 0, status = '正在启动…';

// GET /login：200 = claclaw 在这个端口上跑着
function probe() {
  return new Promise(ok => {
    const req = http.get(HOME_URL + 'login', { timeout: 3000 }, r => { r.resume(); ok(r.statusCode < 400 ? 200 : r.statusCode); });   // 还没建账号时 /login 是跳转（302），也算在跑
    req.on('timeout', () => { req.destroy(); ok(0); });
    req.on('error', e => ok(e.code === 'ECONNREFUSED' ? 0 : -1));
  });
}
async function waitUp(ms) {
  for (const end = Date.now() + ms; Date.now() < end;) { if (await probe() === 200) return true; await new Promise(r => setTimeout(r, 1000)); }
  return false;
}

// 日志超过 5MB 就换一个（留一份旧的）
function logFile(name) {
  const f = path.join(LOGS, name);
  try { if (fs.statSync(f).size > 5 * 1024 * 1024) fs.renameSync(f, f + '.1'); } catch {}
  return fs.openSync(f, 'a');
}

function startServer() {
  if (quitting || child) return;
  const out = logFile('server.log');
  const env = { ...process.env, CLACLAW_APP_DATA: DATA, CLACLAW_SUPERVISOR: 'desktop' };
  delete env.ELECTRON_RUN_AS_NODE;
  // 装各家 Claw 走 npm：用户自己没设下载源就用国内镜像（官方源在国内常常连不上，几百个包装到一半失败）
  if (!Object.keys(env).some(k => k.toLowerCase() === 'npm_config_registry')) env.npm_config_registry = 'https://registry.npmmirror.com';
  // 自带的 node、npm 放在 PATH 最前面：claclaw 装各家 Claw（npm）、跑技能都用它
  if (RES) env.PATH = path.dirname(NODE) + path.delimiter + (env.PATH || env.Path || '');
  if (RES && WIN) delete env.Path;
  child = spawn(NODE, ['server.mjs'], { cwd: SERVER_DIR, env, stdio: ['ignore', out, out], windowsHide: true });
  startedAt = Date.now();
  log('server 启动 pid ' + child.pid);
  child.on('error', e => log('server 起不来：' + e.message));
  child.on('exit', (code, sig) => {
    fs.closeSync(out);
    child = null;
    if (quitting) return;
    // 跑了一分钟以上再退出的（比如 claclaw 自己重启）马上拉起；刚起就退出的越等越久，免得一直空转
    fails = Date.now() - startedAt > 60000 ? 0 : fails + 1;
    const wait = Math.min(30000, fails ? 1000 * 2 ** fails : 500);
    log(`server 退出（${sig || code}），${wait}ms 后重新拉起`);
    setStatus(fails >= 3 ? 'claclaw 服务一直起不来，正在重试（详情看日志）' : '正在重启…');
    setTimeout(async () => { startServer(); if (await waitUp(60000)) setStatus('正在运行'); }, wait);
  });
}

// 结束 server 连同它的子进程（各家 Claw、Claude 会话），不留孤儿
function stopServer() {
  const c = child; if (!c) return;
  try {
    if (WIN) execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    else c.kill('SIGTERM');
  } catch {}
}

const openUI = () => shell.openExternal(HOME_URL);

function setStatus(s) {
  status = s; log('状态：' + s);
  if (!tray) return;
  tray.setToolTip('claclaw：' + s);
  tray.setContextMenu(menu());
}

function menu() {
  const login = app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin;
  return Menu.buildFromTemplate([
    { label: 'claclaw：' + status, enabled: false },
    { type: 'separator' },
    { label: '打开 claclaw', click: openUI },
    { label: '开机自动启动', type: 'checkbox', checked: login, click: it => setLogin(it.checked) },
    { label: '重启 claclaw 服务', enabled: !external, click: () => { setStatus('正在重启…'); fails = 0; stopServer(); } },
    { label: '查看日志', click: () => shell.openPath(LOGS) },
    { type: 'separator' },
    { label: '退出', click: () => app.quit() },
  ]);
}

function setLogin(on) {
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
  writeState({ autostart: on });
  tray && tray.setContextMenu(menu());
}

function makeTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.on('click', () => { if (WIN) openUI(); });
  tray.on('double-click', openUI);
  setStatus(status);
}

app.on('second-instance', openUI);
app.on('window-all-closed', e => e.preventDefault());   // 没有窗口，只有托盘
app.on('before-quit', () => { quitting = true; stopServer(); });
if (process.platform === 'darwin') app.dock?.hide();

app.whenReady().then(async () => {
  log('启动 ' + app.getVersion() + (HIDDEN ? '（开机自动启动）' : '') + '，数据 ' + DATA + (SCRIPT_DATA ? '（沿用脚本版的）' : ''));
  makeTray();
  const st = readState();
  // 第一次装好：默认开机自动启动（用户在托盘里能关；关了以后不再替他打开）
  if (!('autostart' in st) && !NO_AUTOSTART) setLogin(true);

  const code = await probe();
  if (code === 200) {
    // 端口上已经有一份 claclaw（比如以前用脚本装的那份）在跑：不再另起一份，直接用它
    external = true;
    log(PORT + ' 上已经有 claclaw 在跑，不另起');
    setStatus('正在运行（这台电脑上另一份 claclaw）');
    // 那份停了（被关掉、卸载了）：换成自己来跑
    const watch = setInterval(async () => {
      if (await probe() === 0) { clearInterval(watch); external = false; log('另一份 claclaw 停了，改由桌面版来跑'); startServer(); if (await waitUp(60000)) setStatus('正在运行'); }
    }, 30000);
  } else if (code !== 0) {
    log(PORT + ' 被别的程序占着');
    setStatus('端口 ' + PORT + ' 被别的程序占着');
    dialog.showErrorBox('claclaw 启动不了', '端口 ' + PORT + ' 被别的程序占着。请关掉那个程序后，在托盘里退出 claclaw 再重新打开。');
    return;
  } else {
    startServer();
    if (!(await waitUp(60000))) {
      setStatus('启动失败（详情看日志）');
      dialog.showErrorBox('claclaw 启动不了', '服务一分钟内没起来。可以在托盘菜单里点「查看日志」，把 server.log 发给帮你装的人。');
      return;
    }
    setStatus('正在运行');
  }
  if (!HIDDEN) openUI();
});
