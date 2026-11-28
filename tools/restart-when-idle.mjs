// npm run restart —— 等 claclaw 里所有会话（四个 Claw）都空闲、连续 30 秒没忙，再 launchctl kickstart -k 重启服务，然后核实。
//   - 自己脱离出去跑（setsid）：发起的会话本身就是 claclaw 的子进程，重启会把它杀掉，所以不能在前台等
//   - 先等 20 秒，让发起重启的这一轮先回完；最多等 30 分钟，到时间也重启（日志里标 timeout）
//   - 同一时间只有一个在等（~/Library/Logs/claclaw/restart.pid），重复调用直接说「已经在等」
//   - 重启后打开一个 Claude 会话、取一次 /login，结果和当前 commit 记到 ~/Library/Logs/claclaw/handover.log
// 用法：npm run restart [-- <备注>]；指定核实用的会话：CLACLAW_VERIFY_SESSION=<Claude 会话 ID>
// Windows：没有 launchd。空闲后建一个一次性计划任务（在用户桌面会话里跑，不在 claclaw 的进程树里，杀 claclaw 时不会被带走）：
//   结束 npm run serve 的守护和监听端口的进程（连同子进程），再拉起来：有开机启动的 claclaw.vbs 就用它在后台拉起（和开机后一样），
//   没有就开一个标题为 claclaw 的新窗口 npm run serve；等 /login 通了把结果记进日志，删掉任务；
//   claclaw 已经没在跑时也照样拉起。
//   日志在 %LOCALAPPDATA%\claclaw\Logs。等的这个进程是 claclaw 的子孙，会跟着被结束，所以核实由计划任务做（只核实 /login）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
// 在 worktree 里跑也重启线上那份（main 工作区）
const WIN = process.platform === 'win32';
const ROOT = path.resolve(path.dirname(SELF), '..').replace(/[\\/]\.worktrees[\\/][^\\/]+$/, '');
const LOGDIR = WIN
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claclaw', 'Logs')
  : path.join(os.homedir(), 'Library', 'Logs', 'claclaw');
const LOG = path.join(LOGDIR, 'handover.log'), PIDFILE = path.join(LOGDIR, 'restart.pid');
const PORT = Number(process.env.CLACLAW_PORT || 8787), BASE = 'http://127.0.0.1:' + PORT;
const LABEL = 'com.wyidong.claclaw';
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const git = (...a) => { try { return execFileSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' }).trim(); } catch { return ''; } };

fs.mkdirSync(LOGDIR, { recursive: true });
const other = Number(fs.existsSync(PIDFILE) && fs.readFileSync(PIDFILE, 'utf8')) || 0;

if (!process.env.CLACLAW_RESTART_CHILD) {
  if (other && alive(other)) { console.log('已经有一个在等空闲重启（pid ' + other + '），这次不重复排'); process.exit(0); }
  const note = process.argv.slice(2).join(' ');
  spawn(process.execPath, [SELF, ...process.argv.slice(2)], {
    detached: true, stdio: 'ignore', windowsHide: true, cwd: ROOT, env: { ...process.env, CLACLAW_RESTART_CHILD: '1' },
  }).unref();
  console.log(`已排队：所有会话空闲满 30 秒后重启 claclaw（${git('log', '-1', '--format=%h')}${note ? ' · ' + note : ''}），结果写进 ${LOG.replace(os.homedir(), '~')}`);
  process.exit(0);
}

if (other && other !== process.pid && alive(other)) process.exit(0);
fs.writeFileSync(PIDFILE, String(process.pid));
const cleanup = () => { try { if (Number(fs.readFileSync(PIDFILE, 'utf8')) === process.pid) fs.unlinkSync(PIDFILE); } catch {} };
process.on('exit', cleanup);

const log = s => fs.appendFileSync(LOG, s + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const { issueToken, revokeToken } = await import(pathToFileURL(path.join(ROOT, 'src', 'auth.mjs')).href);
const { startupDir } = await import(pathToFileURL(path.join(ROOT, 'src', 'winstart.mjs')).href);
async function withToken(via, fn) {
  const token = issueToken(via, '127.0.0.1');
  try { return await fn({ cookie: 'claclaw_sid=' + token, origin: BASE }); } finally { revokeToken(token); }
}
const getJson = (route, headers) => fetch(BASE + route, { headers, signal: AbortSignal.timeout(10000) }).then(r => r.json());

async function busyCount() {
  return withToken('restart-wait', async h => {
    const s = (await getJson('/api/host', h)).claclaw?.sessions || {};
    return Object.values(s).reduce((n, v) => n + (v && typeof v === 'object' ? Number(v.busy) || 0 : 0), 0);
  });
}

async function verify() {
  const { default: WebSocket } = await import(pathToFileURL(path.join(ROOT, 'node_modules', 'ws', 'wrapper.mjs')).href);
  return withToken('restart-verify', async h => {
    let id = process.env.CLACLAW_VERIFY_SESSION;
    if (!id) { try { id = (await getJson('/api/sessions', h)).find(s => !s.busyElsewhere && s.lastModified)?.id; } catch {} }
    if (!id) return '没有可打开的 Claude 会话，跳过';
    return new Promise(resolve => {
      const ws = new WebSocket(BASE.replace('http', 'ws') + '/ws', { headers: h });
      const done = r => { clearTimeout(t); try { ws.send(JSON.stringify({ t: 'session.leave' })); ws.close(); } catch {} resolve(r); };
      const t = setTimeout(() => done('打开会话超时'), 20000);
      ws.on('error', e => done('ws 出错 ' + e.message));
      ws.on('open', () => ws.send(JSON.stringify({ t: 'session.open', id })));
      ws.on('message', raw => {
        let m; try { m = JSON.parse(raw); } catch { return; }
        if (m.t === 'session.opened') done(`Claude 会话 ${id.slice(0, 8)} 打开正常（${m.history?.length ?? 0} 条历史）`);
        else if (m.t === 'error' || m.t === 'session.busy') done(`Claude 会话 ${id.slice(0, 8)}：${m.t} ${m.message || ''}`);
      });
    });
  });
}

// 谁在监听 127.0.0.1:PORT（就是 claclaw）
function winServerPid() {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
      if (m && Number(m[1]) === PORT) return Number(m[2]);
    }
  } catch {}
  return 0;
}
const psq = s => "'" + String(s).replace(/'/g, "''") + "'";   // PowerShell 单引号字符串
// npm run serve 的守护（tools/win-serve.mjs）还活着就连它一起结束，不然它会把刚结束的 server 又拉起来
function winServePid() {
  const pid = Number((() => { try { return fs.readFileSync(path.join(LOGDIR, 'serve.pid'), 'utf8'); } catch { return 0; } })()) || 0;
  return pid && alive(pid) ? pid : 0;
}
function winKick() {
  // 守护和正在监听端口的 server 都结束：server 不一定是这个守护拉起的（别处另起的、守护已经没了），只杀一个会漏
  const pids = [...new Set([winServePid(), winServerPid()].filter(Boolean))];
  const pid = pids.join(',');
  // 没在跑（挂了、没人拉起）：不再干等，直接拉起来
  if (!pid) log('    没找到监听 ' + PORT + ' 的进程：直接拉起');
  const TASK = 'claclaw-restart';
  // 新窗口要带上原来的端口 / 监听地址设置（计划任务里起的进程不继承这里的环境变量）
  const env = ['CLACLAW_PORT', 'CLACLAW_HOST'].filter(k => process.env[k]).map(k => `set "${k}=${process.env[k].replace(/["&|<>^%]/g, '')}" && `).join('');
  const ps1 = path.join(LOGDIR, 'restart-task.ps1');
  const bootVbs = (() => {
    const f = path.join(startupDir(), 'claclaw.vbs');
    try { return fs.readFileSync(f).toString('utf16le').includes(ROOT) ? f : ''; } catch { return ''; }
  })();
  // 每一步都记进 handover.log（带时间）：任务中途没了的话，能看出停在哪一步
  const script = [
    `$log = ${psq(LOG)}`,
    `function L($s) { Add-Content -Path $log -Value ((Get-Date -Format 'HH:mm:ss') + ' ' + $s) -Encoding UTF8 }`,
    `L '    任务开始'`,
    ...pids.flatMap(p => [   // 连子进程（各 Claw 的 agent、Claude 会话）一起结束，不留孤儿
      `$r = taskkill /PID ${p} /T /F 2>&1`,
      `L ("    taskkill ${p}：退出码 $LASTEXITCODE；" + (($r | Select-Object -Last 2) -join ' '))`,
    ]),
    `for ($i = 0; $i -lt 40; $i++) { if (-not (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }`,
    `$still = Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
    `if ($still) { L ("    端口 ${PORT} 还被 pid " + $still.OwningProcess + " 占着：旧进程没结束，新窗口会因为端口被占自己退出") } else { L '    端口已空出' }`,
    // 有开机启动的 claclaw.vbs（src/winstart.mjs 放的、指向这份代码）就用它拉起：和开机后一样在后台跑、不弹窗口；
    // 没有就开一个标题为 claclaw 的窗口 npm run serve。两种都是 tools/win-serve.mjs 守护：挂了自动拉起、输出进 Logs\server.log
    ...(bootVbs ? [
      `Start-Process wscript.exe -ArgumentList ${psq('"' + bootVbs + '"')}`,
      `L '    已按开机启动的方式在后台拉起'`,
    ] : [
      `Start-Process cmd.exe -ArgumentList '/k', ${psq(`title claclaw && ${env}npm run serve`)} -WorkingDirectory ${psq(ROOT)}`,
      `L '    新窗口已开'`,
    ]),
    `$up = $false`,
    `for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Seconds 2; try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ${psq(BASE + '/login')}).StatusCode -eq 200 } catch {} }`,
    `$h = (& git -C ${psq(ROOT)} log -1 --format=%h)`,
    `L ("    after restart ($h): " + $(if ($up) { 'login ok' } else { '服务 60 秒没起来' }))`,
    `schtasks /delete /tn ${TASK} /f | Out-Null`,
  ].join('\r\n');
  fs.writeFileSync(ps1, '﻿' + script);   // 带 BOM：Windows PowerShell 5.1 才按 UTF-8 读中文路径
  const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`;
  // 建任务偶尔会失败（遇到过一次 /create 失败，手动再跑就成了）：把 schtasks 的报错记下来，隔几秒再试，最多 3 次。
  // 启动任务（/run）只跑一次：它报错时任务可能其实已经起来了，再来一遍就会重启两遍；失败了查一下任务状态记下来
  const sch = args => execFileSync('schtasks', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const why = e => `退出码 ${e.status ?? e.signal ?? '?'}；` + (String(e.stderr || e.stdout || '').trim().replace(/\s+/g, ' ') || e.message).slice(0, 300);
  let made = false;
  for (let i = 1; i <= 3 && !made; i++) {
    try { sch(['/create', '/tn', TASK, '/tr', tr, '/sc', 'once', '/st', '23:59', '/it', '/f']); made = true; } catch (e) {
      log(`    建计划任务第 ${i} 次没成：${why(e)}`);
      if (i < 3) execFileSync(process.execPath, ['-e', 'setTimeout(() => {}, 5000)']);   // 同步等 5 秒
    }
  }
  if (!made) { log('    计划任务 3 次都没建成：手动关掉 claclaw 再 npm run serve'); return; }
  try {
    sch(['/run', '/tn', TASK]);
    log(`    已交给计划任务 ${TASK}：${pid ? '结束 pid ' + pid + '，' : ''}${bootVbs ? '按开机启动的方式在后台拉起' : '新窗口 npm run serve'}`);
  } catch (e) {
    let st = ''; try { st = (sch(['/query', '/tn', TASK, '/fo', 'list']).match(/^(?:Status|状态):\s*(.+)$/m) || [])[1] || ''; } catch {}
    log(`    启动计划任务报错（不重试，免得重启两遍）：${why(e)}；任务状态：${st || '查不到'}`);
  }
}

const t0 = Date.now();
await sleep(20000);
let quietSince = 0, idle = false, down = 0;
while (Date.now() - t0 < 30 * 60000) {
  let n = 1; try { n = await busyCount(); down = 0; } catch { down++; }
  // Windows：连着 30 秒连不上 = claclaw 已经挂了，没有会话可等，别干等满 30 分钟（macOS 有 launchd 自己拉起，照旧）
  if (WIN && down >= 6) break;
  if (n === 0) { quietSince ||= Date.now(); if (Date.now() - quietSince >= 30000) { idle = true; break; } } else quietSince = 0;
  await sleep(5000);
}
const note = process.argv.slice(2).join(' ');
log(`=== kickstart ${new Date().toISOString()} ${git('log', '-1', '--format=%h')}${note ? ' ' + note : ''} (${idle ? 'all idle' : down >= 6 ? 'down' : 'timeout'}) ===`);
// 桌面版（desktop/main.cjs 托管 server，环境变量 CLACLAW_SUPERVISOR=desktop）：只结束 server（连同子进程），桌面程序看到它退出会马上重新拉起
if (process.env.CLACLAW_SUPERVISOR === 'desktop') {
  let pid = 0;
  if (WIN) pid = winServerPid();
  else { try { pid = Number(execFileSync('lsof', ['-tiTCP:' + PORT, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]) || 0; } catch {} }
  log(pid ? '    桌面版：结束 server ' + pid + '，由桌面程序重新拉起' : '    桌面版：没找到监听 ' + PORT + ' 的进程');
  if (pid) { try { if (WIN) execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); else process.kill(pid, 'SIGTERM'); } catch {} }
  process.exit(0);
}
if (WIN) { winKick(); process.exit(0); }   // 计划任务接手；这个进程马上会跟着 claclaw 一起被结束
const startedOf = () => withToken('restart-wait', async h => (await getJson('/api/host', h)).claclaw?.startedAt).catch(() => null);
const before = await startedOf();
// 没有这个 launchd 服务（比如手动 node server.mjs 跑的）kickstart 会失败：照实记失败，不去「核实」还活着的旧进程
try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`], { stdio: ['ignore', 'ignore', 'pipe'] }); } catch (e) { log('    kickstart failed（没重启）: ' + String(e.stderr || e.message).trim().split('\n')[0]); process.exit(1); }

// 等服务起来（最多 60 秒），再核实
let up = false;
for (let i = 0; i < 30 && !up; i++) { await sleep(2000); try { up = (await fetch(BASE + '/login', { signal: AbortSignal.timeout(3000) })).ok; } catch {} }
let res = up ? '' : '服务 60 秒没起来';
if (up && before && (await startedOf()) === before) { res = '启动时间没变，还是原来的进程（没重启）'; up = false; }
if (up) { try { res = await verify(); } catch (e) { res = '核实出错 ' + e.message; } }
log(`    after restart (${git('log', '-1', '--format=%h')}): ${res} | ${up ? 'login ok' : 'login fail'}`);
process.exit(0);
