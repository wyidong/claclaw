// npm run restart —— 等 claclaw 里所有会话（四个 Claw）都空闲、连续 30 秒没忙，再 launchctl kickstart -k 重启服务，然后核实。
//   - 自己脱离出去跑（setsid）：发起的会话本身就是 claclaw 的子进程，重启会把它杀掉，所以不能在前台等
//   - 先等 20 秒，让发起重启的这一轮先回完；最多等 30 分钟，到时间也重启（日志里标 timeout）
//   - 同一时间只有一个在等（~/Library/Logs/claclaw/restart.pid），重复调用直接说「已经在等」
//   - 重启后打开一个 Claude 会话、取一次 /login，结果和当前 commit 记到 ~/Library/Logs/claclaw/handover.log
// 用法：npm run restart [-- <备注>]；指定核实用的会话：CLACLAW_VERIFY_SESSION=<Claude 会话 ID>
// Windows：没有 launchd。空闲后建一个一次性计划任务（在用户桌面会话里跑，不在 claclaw 的进程树里，杀 claclaw 时不会被带走）：
//   结束监听端口的那个进程连同子进程，开一个标题为 claclaw 的新窗口 npm start，等 /login 通了把结果记进日志，删掉任务。
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
const { issueToken, revokeToken } = await import(pathToFileURL(path.join(ROOT, 'auth.mjs')).href);
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
function winKick() {
  const pid = winServerPid();
  if (!pid) { log('    没找到监听 ' + PORT + ' 的进程，没重启'); return; }
  const TASK = 'claclaw-restart';
  // 新窗口要带上原来的端口 / 监听地址设置（计划任务里起的进程不继承这里的环境变量）
  const env = ['CLACLAW_PORT', 'CLACLAW_HOST'].filter(k => process.env[k]).map(k => `set "${k}=${process.env[k].replace(/["&|<>^%]/g, '')}" && `).join('');
  const ps1 = path.join(LOGDIR, 'restart-task.ps1');
  const script = [
    `$log = ${psq(LOG)}`,
    `function L($s) { Add-Content -Path $log -Value $s -Encoding UTF8 }`,
    `taskkill /PID ${pid} /T /F | Out-Null`,   // 连子进程（各 Claw 的 agent、Claude 会话）一起结束，不留孤儿
    `for ($i = 0; $i -lt 40; $i++) { if (-not (Get-NetTCPConnection -LocalPort ${PORT} -State Listen -ErrorAction SilentlyContinue)) { break }; Start-Sleep -Milliseconds 500 }`,
    `Start-Process cmd.exe -ArgumentList '/k', ${psq(`title claclaw && ${env}npm start`)} -WorkingDirectory ${psq(ROOT)}`,
    `$up = $false`,
    `for ($i = 0; $i -lt 30 -and -not $up; $i++) { Start-Sleep -Seconds 2; try { $up = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 ${psq(BASE + '/login')}).StatusCode -eq 200 } catch {} }`,
    `$h = (& git -C ${psq(ROOT)} log -1 --format=%h)`,
    `L ("    after restart ($h): " + $(if ($up) { 'login ok' } else { '服务 60 秒没起来' }))`,
    `schtasks /delete /tn ${TASK} /f | Out-Null`,
  ].join('\r\n');
  fs.writeFileSync(ps1, '﻿' + script);   // 带 BOM：Windows PowerShell 5.1 才按 UTF-8 读中文路径
  try {
    const tr = `powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "${ps1}"`;
    execFileSync('schtasks', ['/create', '/tn', TASK, '/tr', tr, '/sc', 'once', '/st', '23:59', '/it', '/f'], { stdio: 'ignore' });
    execFileSync('schtasks', ['/run', '/tn', TASK], { stdio: 'ignore' });
    log(`    已交给计划任务 ${TASK}：结束 pid ${pid}，新窗口 npm start`);
  } catch (e) { log('    计划任务没建成：' + e.message + '（手动关掉 claclaw 窗口再 npm start）'); }
}

const t0 = Date.now();
await sleep(20000);
let quietSince = 0, idle = false;
while (Date.now() - t0 < 30 * 60000) {
  let n = 1; try { n = await busyCount(); } catch {}
  if (n === 0) { quietSince ||= Date.now(); if (Date.now() - quietSince >= 30000) { idle = true; break; } } else quietSince = 0;
  await sleep(5000);
}
const note = process.argv.slice(2).join(' ');
log(`=== kickstart ${new Date().toISOString()} ${git('log', '-1', '--format=%h')}${note ? ' ' + note : ''} (${idle ? 'all idle' : 'timeout'}) ===`);
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
