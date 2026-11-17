// npm run serve —— Windows 上的守护：起 node server.mjs，挂了自动拉起，输出同时写进日志文件。
// macOS 有 launchd（KeepAlive、日志进 ~/Library/Logs/claclaw），Windows 原来是窗口里直接 npm start：
// 进程一挂就一直停着，窗口一关报错也没了。这里补上这两样：
//   - 输出照常显示在窗口里，同时追加到 %LOCALAPPDATA%\claclaw\Logs\server.log（每行带日期；超过 5MB 转成 server.log.1）
//   - server 意外退出（崩溃、被杀）：记一行退出码，等几秒重新拉起（2 秒起，连着挂翻倍，最长 60 秒；稳定跑满 5 分钟就重置）
//   - 不拉起的情况：正常退出（退出码 0，比如 Ctrl+C）；刚起就因为端口被占退出（已经有一个 claclaw 在跑）
//   - 守护自己的 pid 写在 Logs\serve.pid，npm run restart 重启时连守护一起结束、再开新窗口 npm run serve
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOGDIR = process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'claclaw', 'Logs')
  : path.join(os.homedir(), 'Library', 'Logs', 'claclaw');
const LOG = path.join(LOGDIR, 'server.log'), PIDFILE = path.join(LOGDIR, 'serve.pid');
const PORT = Number(process.env.CLACLAW_PORT || 8787);
const MAX_LOG = 5 * 1024 * 1024;

fs.mkdirSync(LOGDIR, { recursive: true });
fs.writeFileSync(PIDFILE, String(process.pid));
process.on('exit', () => { try { if (Number(fs.readFileSync(PIDFILE, 'utf8')) === process.pid) fs.unlinkSync(PIDFILE); } catch {} });

const day = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
function rotate() {
  try { if (fs.statSync(LOG).size > MAX_LOG) fs.renameSync(LOG, LOG + '.1'); } catch {}
}
// server 自己的行开头已经有时间（HH:MM:SS），这里只补日期，跨天看日志也分得清
function writer(stream) {
  let carry = '';
  return chunk => {
    stream.write(chunk);
    const s = carry + chunk.toString('utf8'), lines = s.split('\n');
    carry = lines.pop();
    if (lines.length) { try { fs.appendFileSync(LOG, lines.map(l => day() + ' ' + l.replace(/\r$/, '') + '\n').join('')); } catch {} }
  };
}
const note = s => { const l = `${day()} ${new Date().toTimeString().slice(0, 8)} [serve] ${s}`; console.log(l); try { fs.appendFileSync(LOG, l + '\n'); } catch {} };

// 端口有没有人在监听（判断「已有 claclaw 在跑」）
const portBusy = () => new Promise(ok => {
  const s = net.connect({ host: '127.0.0.1', port: PORT });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
  s.setTimeout(1500, () => { s.destroy(); ok(false); });
});

let child = null, stopping = false, wait = 2000;
// Ctrl+C：同一个控制台里的 server 自己也收到，按它的 shutdown 收尾退出；守护这边只记下「别再拉起」
// （不 child.kill：Windows 上那是强杀，server 来不及收尾）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  process.on(sig, () => { stopping = true; if (!child) process.exit(0); });
}

async function run() {
  rotate();
  const t0 = Date.now();
  note(`start node server.mjs（守护 pid ${process.pid}）`);
  child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, CLACLAW_SERVE: '1' } });
  child.stdout.on('data', writer(process.stdout));
  child.stderr.on('data', writer(process.stderr));
  const [code, signal] = await new Promise(ok => child.once('exit', (c, s) => ok([c, s])));
  child = null;
  const ran = Date.now() - t0;
  note(`server 退出：code ${code}${signal ? ' signal ' + signal : ''}，跑了 ${Math.round(ran / 1000)} 秒`);
  if (stopping || code === 0) { note('正常退出，不再拉起'); process.exit(0); }
  if (code === 1 && ran < 15000 && await portBusy()) { note(`端口 ${PORT} 已有 claclaw 在跑，这个守护退出`); process.exit(0); }
  if (ran > 5 * 60000) wait = 2000;
  note(`${wait / 1000} 秒后重新拉起`);
  await new Promise(r => setTimeout(r, wait));
  wait = Math.min(wait * 2, 60000);
  if (!stopping) run();
}
run();
