// npm run restart —— 等 claclaw 里所有会话（四个 Claw）都空闲、连续 30 秒没忙，再 launchctl kickstart -k 重启服务，然后核实。
//   - 自己脱离出去跑（setsid）：发起的会话本身就是 claclaw 的子进程，重启会把它杀掉，所以不能在前台等
//   - 先等 20 秒，让发起重启的这一轮先回完；最多等 30 分钟，到时间也重启（日志里标 timeout）
//   - 同一时间只有一个在等（~/Library/Logs/claclaw/restart.pid），重复调用直接说「已经在等」
//   - 重启后打开一个 Claude 会话、取一次 /login，结果和当前 commit 记到 ~/Library/Logs/claclaw/handover.log
// 用法：npm run restart [-- <备注>]；指定核实用的会话：CLACLAW_VERIFY_SESSION=<Claude 会话 ID>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SELF = fileURLToPath(import.meta.url);
// 在 worktree 里跑也重启线上那份（main 工作区）
const ROOT = path.resolve(path.dirname(SELF), '..').replace(/\/\.worktrees\/[^/]+$/, '');
const LOGDIR = path.join(os.homedir(), 'Library', 'Logs', 'claclaw');
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
    detached: true, stdio: 'ignore', cwd: ROOT, env: { ...process.env, CLACLAW_RESTART_CHILD: '1' },
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
const { issueToken, revokeToken } = await import(path.join(ROOT, 'auth.mjs'));
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
  const { default: WebSocket } = await import(path.join(ROOT, 'node_modules', 'ws', 'wrapper.mjs'));
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
try { execFileSync('launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${LABEL}`]); } catch (e) { log('    kickstart failed: ' + e.message); }

// 等服务起来（最多 60 秒），再核实
let up = false;
for (let i = 0; i < 30 && !up; i++) { await sleep(2000); try { up = (await fetch(BASE + '/login', { signal: AbortSignal.timeout(3000) })).ok; } catch {} }
let res = up ? '' : '服务 60 秒没起来';
if (up) { try { res = await verify(); } catch (e) { res = '核实出错 ' + e.message; } }
log(`    after restart (${git('log', '-1', '--format=%h')}): ${res} | ${up ? 'login ok' : 'login fail'}`);
process.exit(0);
