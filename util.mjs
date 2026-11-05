// 各模块共用的小工具：路径显示、文字压成一行、时间统一成毫秒、找命令、跑命令
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, execFileSync } from 'node:child_process';

export const HOME = os.homedir();
// 家目录下的路径显示成 ~/…
export const tilde = p => { p = String(p || ''); return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p; };
// 在 cwd 下的给相对路径，其余同 tilde
export const relPath = (p, cwd) => { if (typeof p !== 'string') return ''; if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1); return tilde(p); };
export const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();
// 时间统一成毫秒：秒 / 毫秒 / 数字字符串 / ISO 字符串都认；认不出返回 bad
export const tms = (v, bad) => { const n = typeof v === 'string' ? (/^\d+$/.test(v) ? +v : Date.parse(v)) : +v; return n > 0 ? (n < 1e12 ? n * 1000 : n) : bad; };
export const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

export const WIN = process.platform === 'win32';
// 常见安装目录（PATH 之外还要找的）：macOS 是 Homebrew / /usr/local，Windows 是 npm 全局目录和 scoop
const extraDirs = () => WIN
  ? [path.join(process.env.APPDATA || path.join(HOME, 'AppData', 'Roaming'), 'npm'),
     path.join(process.env.LOCALAPPDATA || path.join(HOME, 'AppData', 'Local'), 'npm'),
     path.join(HOME, 'scoop', 'shims'), path.join(HOME, '.local', 'bin')]
  : ['/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), '/usr/bin'];
// 子进程的 PATH：带上当前 node 所在目录（launchd 环境里 PATH 很短）；分隔符按系统来（Windows 是 ;）
export const binEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', ...(WIN ? extraDirs() : ['/usr/local/bin'])].filter(Boolean).join(path.delimiter) });
// Windows 上可执行文件要带后缀：npm 全局命令装成 foo.cmd，scoop 装成 foo.exe，
// 同目录那个不带后缀的 foo 是给 sh 用的脚本，Windows 直接 spawn 会 ENOENT，必须跳过。
// 按 PATHEXT 的顺序找（默认 .COM;.EXE;.BAT;.CMD，所以 .exe 优先于 .cmd）
const PATHEXT = (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(e => e.toLowerCase());
// 找命令：先看 first 里的目录，再看 PATH 和常见安装目录；找到返回真实路径（软链接解开），找不到 null
export function findBin(name, first = []) {
  const dirs = new Set([...first, ...(process.env.PATH || '').split(path.delimiter), path.dirname(process.execPath), ...extraDirs()]);
  const names = WIN && !path.extname(name) ? PATHEXT.map(e => name + e) : [name];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = path.join(d, n);
      try { fs.accessSync(p, WIN ? fs.constants.F_OK : fs.constants.X_OK); } catch { continue; }
      try { return fs.realpathSync(p); } catch { return p; }
    }
  }
  return null;
}
// 把 findBin 的结果变成能直接 spawn 的 { cmd, args }。
// Windows 上 npm 装的命令是 foo.cmd（一段 batch）：Node 从 20 起不让直接 spawn（EINVAL），
// 而 shell:true 不转义参数（DEP0190，等于命令注入）。好在 .cmd 里就是 node "<…>\xxx.js" %*，
// 把真正的 JS 入口抠出来用本进程的 node 起即可 —— 不过 cmd.exe，没有转义问题，和 POSIX 完全一致。
export function binCall(bin, args = []) {
  if (!bin) return null;
  if (!WIN || !/\.(cmd|bat)$/i.test(bin)) return { cmd: bin, args };
  const js = shimTarget(bin);
  if (js) return { cmd: process.execPath, args: [js, ...args] };
  // 抠不出来才退回 cmd.exe（参数仍由 Node 转义，不开 shell）
  return { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', bin, ...args] };
}
// 从 npm / pnpm / yarn 的 Windows shim 里读出它要跑的 JS 入口（.cmd 读不出就读同名无后缀的 sh 脚本）
function shimTarget(cmdFile) {
  const base = cmdFile.replace(/\.(cmd|bat)$/i, '');
  for (const f of [cmdFile, base]) {
    try {
      const m = fs.readFileSync(f, 'utf8').match(/[%$]\{?(?:dp0|basedir)\}?[\\/]+((?:[^"'\n]*?[\\/])?[\w.@-]+\.(?:js|mjs|cjs))/i);
      if (!m) continue;
      const p = path.join(path.dirname(cmdFile), m[1].replace(/\//g, path.sep));
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}
// 跑命令拿 stdout；失败时报错信息取 stderr 最后一行
export const runBin = (bin, args, ms, { maxBuffer = 64 * 1024 * 1024, missing = '没找到命令' } = {}) => new Promise((ok, fail) => {
  if (!bin) return fail(new Error(missing));
  const c = binCall(bin, args);
  execFile(c.cmd, c.args, { cwd: HOME, env: binEnv(), timeout: ms, maxBuffer }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out));
});
// 读 JSON 文件：没有、读不了、内容是 null 都返回 fallback
export const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; } };

// ---------- Windows：用 ACL 收紧目录 ----------
// Node 在 Windows 上的 mode 0o600 / 0o700 基本是空操作（只映射「只读」这一位），
// 而 data/ 里存着协同钥匙、登录凭据、模型库的 key，所以这里改用 ACL：
// 去掉继承来的权限，只留当前用户完全控制，(OI)(CI) 让已有和新建的子文件都按继承跟上。
//
// 千万别加 /T：那会让 icacls 对每个子文件单独执行 /inheritance:r，把它们的继承 ACE 删掉，
// 而 (OI)(CI) 这种继承标志对文件本身没有意义、不会补上任何 ACE，结果子文件变成空 DACL，
// 连本人都读不了（实测把 data/ 整个锁死，claclaw 起不来协同）。不加 /T 时 NTFS 会自动向下传播，
// 已有文件照样可读，子文件的 ACL 变成 <本人>:(I)(F)。
//
// 失败只记一行日志，不影响启动 —— 收不紧也不该让 claclaw 起不来。
export function secureDir(dir, log) {
  if (!WIN || !dir) return false;
  try {
    const user = process.env.USERNAME || os.userInfo().username;
    if (!user) return false;
    execFileSync('icacls', [dir, '/inheritance:r', '/grant:r', user + ':(OI)(CI)F', '/C', '/Q'],
      { timeout: 60000, stdio: ['ignore', 'ignore', 'pipe'] });
    return true;
  } catch (e) { log?.('icacls 收紧 ' + dir + ' 失败：' + String(e.message || '').split('\n')[0]); return false; }
}

// ---------- 进程信息：父进程、启动时间 ----------
// macOS / Linux 用 ps；Windows 没有 ps（Git Bash 带的那个不认 -o/-axo，只会往日志里刷错），
// 用 PowerShell 的 CIM 代替。PowerShell 启动要几秒，所以只在接管这类少数时候查，别放进列表刷新的路径里。
// 查不到一律返回 null / ''：调用方当「不确定」处理，不要当成确定的答案，也不要反复写日志。
const psOut = (args, env) => execFileSync('ps', args, { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'], ...(env ? { env: { ...process.env, ...env } } : {}) });
const cim = (pid, expr) => {
  const exe = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  const script = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId=${Number(pid)}';if($p){${expr}}`;
  return execFileSync(exe, ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 20000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
};
// 父进程 pid；查不到返回 null
export function procPpid(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return null;
  try {
    // 进程不在时 CIM 给空串，Number('') 是 0 —— 会被当成真实的父进程号，所以先挡掉空
    const raw = String(WIN ? cim(p, '$p.ParentProcessId') : psOut(['-o', 'ppid=', '-p', String(p)])).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch { return null; }
}
// 进程启动时间，用来防 pid 被复用。返回的字符串只拿去和登记表里记的值比，不要解析它的含义：
// macOS 是 UTC 下的 ps lstart，Windows 是 FILETIME —— Claude Code 在 Windows 上记的也正是 FILETIME。
export function procStart(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return '';
  // POSIX 这边必须 TZ=UTC：登记表里记的就是 UTC 下的 lstart，用本地时区会对不上
  try { return WIN ? cim(p, '$p.CreationDate.ToFileTimeUtc()') : String(psOut(['-o', 'lstart=', '-p', String(p)], { TZ: 'UTC' })); }
  catch { return ''; }
}
// 某个进程正在监听的本机端口；查不到返回 0。
// macOS / Linux 用 lsof；Windows 没有 lsof，用 netstat -ano 按 pid 找 LISTENING 那行。
export function listenPort(pid) {
  const p = Number(pid);
  if (!Number.isInteger(p) || p <= 0) return 0;
  try {
    if (WIN) {
      const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
        if (m && Number(m[2]) === p) return Number(m[1]);
      }
      return 0;
    }
    const o = execFileSync('lsof', ['-a', '-p', String(p), '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fn'],
      { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = o.match(/^n.*:(\d+)$/m);
    return m ? Number(m[1]) : 0;
  } catch { return 0; }
}
// 两个启动时间算不算同一个进程。
// Windows：CIM 的 CreationDate 只到微秒，比 Claude Code 记的 FILETIME（100 纳秒）末位少几个数
// （实测注册表 …949925、CIM 给 …949920），所以留 10 微秒的容差，不能做字符串全等。
export function sameProcStart(a, b) {
  const x = String(a || '').trim(), y = String(b || '').trim();
  if (!x || !y) return false;
  if (WIN && /^\d+$/.test(x) && /^\d+$/.test(y)) {
    const bx = BigInt(x), by = BigInt(y);
    return (bx > by ? bx - by : by - bx) <= 100n;
  }
  const one = s => s.replace(/\s+/g, ' ').trim();
  return one(x) === one(y);
}
