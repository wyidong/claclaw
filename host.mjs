// 「宿主」页：这台电脑和 claclaw 自己的状态。快的（内存、负载、磁盘）每次现取；
// 要跑外部命令的（系统版本、各 Claw 的版本）缓存 10 分钟。不含任何令牌、密码。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

const run = (cmd, args, ms = 4000) => new Promise(ok => {
  execFile(cmd, args, { timeout: ms, env: { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin', '/opt/homebrew/bin'].join(':') } },
    (e, out) => ok(e ? '' : String(out).trim()));
});

const slow = { at: 0, data: null };
export async function slowInfo(root) {   // server 启动时先跑一次，第一次打开宿主页不用等
  if (slow.data && Date.now() - slow.at < 10 * 60 * 1000) return slow.data;
  const mac = process.platform === 'darwin';
  const [name, osVer, model, claude, openclaw, gitLine, opencode] = await Promise.all([
    mac ? run('scutil', ['--get', 'ComputerName']) : Promise.resolve(os.hostname()),
    mac ? run('sw_vers', ['-productVersion']) : Promise.resolve(os.release()),
    mac ? run('sysctl', ['-n', 'hw.model']) : Promise.resolve(''),
    run('claude', ['--version']),
    run('openclaw', ['--version'], 8000),
    run('git', ['-C', root, 'log', '-1', '--format=%h %ct']),
    run('opencode', ['--version'], 8000),
  ]);
  let dsh = '';
  try { dsh = JSON.parse(fs.readFileSync('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json', 'utf8')).version; } catch {}
  const [hash, ct] = gitLine.split(' ');
  slow.data = {
    name: name || os.hostname(), os: (mac ? 'macOS ' : os.type() + ' ') + osVer, model,
    claude: (claude.match(/\d+\.\d+\.\d+\S*/) || [''])[0],
    openclaw: (openclaw.match(/\d{4}\.\d+\.\d+\S*|\d+\.\d+\.\d+\S*/) || [''])[0],
    dsh, opencode: (opencode.match(/\d+\.\d+\.\d+\S*/) || [''])[0], commit: hash || '', commitAt: ct ? Number(ct) * 1000 : 0,
  };
  slow.at = Date.now();
  return slow.data;
}

// macOS 的 os.freemem() 只算「完全空闲」的页，看起来总是快满了；按活动监视器的口径算：
// 已用 = 总量 −（空闲 + 非活跃 + 推测 + 可清除）
async function memUsed() {
  const total = os.totalmem();
  if (process.platform !== 'darwin') return { total, used: total - os.freemem() };
  const vm = await run('vm_stat', []);
  const page = Number((vm.match(/page size of (\d+)/) || [])[1]) || 16384;
  const n = k => Number((vm.match(new RegExp(k + ':\\s+(\\d+)')) || [])[1]) || 0;
  const avail = (n('Pages free') + n('Pages inactive') + n('Pages speculative') + n('Pages purgeable')) * page;
  return { total, used: Math.max(0, total - avail) };
}

async function battery() {
  if (process.platform !== 'darwin') return null;
  const s = await run('pmset', ['-g', 'batt']);
  const m = s.match(/(\d+)%;\s*([^;]+);/);
  if (!m) return null;
  return { percent: Number(m[1]), state: m[2].trim(), ac: /AC Power/.test(s) };
}

function disk() {
  for (const p of ['/System/Volumes/Data', '/']) {
    try { const s = fs.statfsSync(p); return { total: s.blocks * s.bsize, free: s.bavail * s.bsize }; } catch {}
  }
  return null;
}

function addrs() {
  const out = [];
  for (const [ifn, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      // 只列有用的：Tailscale（手机就是走它连过来的）和本机网卡；虚拟机网桥、其它 VPN / 代理的虚拟网卡不列
      if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address)) out.push({ ip: a.address, kind: 'Tailscale' });
      else if (/^en\d/.test(ifn)) out.push({ ip: a.address, kind: '局域网' });
    }
  }
  return out;
}

export async function hostInfo({ root, port, hosts, https, startedAt, sessions, claws }) {
  const [s, mem, batt] = await Promise.all([slowInfo(root), memUsed(), battery()]);
  const cpus = os.cpus();
  return {
    computer: { name: s.name, os: s.os, model: s.model, cpu: (cpus[0]?.model || '').replace(/\((R|TM)\)/g, '').replace(/\s+CPU\s+@\s+/, ' · ').replace(/\s+/g, ' ').trim(), cores: cpus.length, uptime: os.uptime() * 1000 },
    load: { avg: os.loadavg(), cores: cpus.length },
    mem, disk: disk(), battery: batt,
    net: { addrs: addrs().sort((x, y) => (x.kind === 'Tailscale' ? -1 : 0) - (y.kind === 'Tailscale' ? -1 : 0)), port, listen: hosts, https },
    claclaw: { commit: s.commit, commitAt: s.commitAt, node: process.version, startedAt, sessions },
    claws: [
      { id: 'claude', name: 'Claude Code', version: s.claude, ...claws.claude },
      { id: 'openclaw', name: 'OpenClaw', version: s.openclaw, ...claws.openclaw },
      { id: 'deepseek', name: 'DeepSeek Harness', version: s.dsh, ...claws.deepseek },
      { id: 'opencode', name: 'OpenCode', version: s.opencode, ...claws.opencode },
    ],
  };
}
