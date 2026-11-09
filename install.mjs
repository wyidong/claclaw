// 帮用户装好第一个 Agent：电脑上一个 Claw 都没有时，网页上默认显示 DeepSeek 卡片和「安装」按钮，
// 点了就在电脑上跑 npm install -g 装 DeepSeek Harness（dsh），装完再引导去 DeepSeek 开放平台拿 API key（见 login.mjs 的 deepseek）。
// - 只能装这里列出的包（不接受网页传来的包名）；同一时间只跑一个
// - 进度：网页每隔几秒取一次 installState()；结果留 10 分钟
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBin, binCall, binEnv } from './util.mjs';

// 当前 Node 旁边的 npm：Windows 在 node.exe 同目录的 node_modules，Mac / Linux 在 bin 的上一级 lib/node_modules
function npmCli() {
  const d = path.dirname(process.execPath);
  for (const f of [path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (fs.existsSync(f)) return f;
  return null;
}

export const INSTALLS = {
  deepseek: { label: 'DeepSeek Harness', pkg: '@deepseek-ai/dsh@latest', bin: 'dsh' },
};

let job = null;
const view = j => j && { claw: j.claw, label: j.label, status: j.status, tail: j.tail, error: j.error, startedAt: j.startedAt };
export const installState = () => view(job);

// 输出的最后一句有内容的（给网页看进度）
const lastLine = t => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map(x => x.trim()).filter(Boolean).pop() || '';

// 跑 npm install -g <包>；npmBin / spawnImpl 给测试用
export function installStart(claw, { log, npmBin, spawnImpl = spawn, timeoutMs = 20 * 60e3 } = {}) {
  const s = INSTALLS[claw];
  if (!s) throw new Error('这个 Claw 不能在这里安装');
  if (job?.status === 'running') return view(job);
  const args = ['install', '-g', '--no-fund', '--no-audit', s.pkg];
  // 优先用当前 Node 自带的 npm-cli.js 直接跑（Windows 官方安装包的 npm.cmd 不是标准 shim，走 cmd.exe 又会被 Program Files 的空格坑）
  const cli = !npmBin && npmCli();
  const npm = npmBin || (!cli && findBin('npm'));
  if (!cli && !npm) throw new Error('没找到 npm：先装好 Node.js（https://nodejs.org），再回来点安装');
  const c = cli ? { cmd: process.execPath, args: [cli, ...args] } : binCall(npm, args);
  const j = job = { claw, label: s.label, status: 'running', tail: '正在下载安装，通常要几分钟…', error: '', startedAt: Date.now(), out: '' };
  const done = (ok, error = '') => {
    if (j.status !== 'running') return;
    clearTimeout(j.timer);
    j.status = ok ? 'ok' : 'fail'; j.error = error; j.tail = ok ? '安装完成' : '';
    log?.('install', claw, ok ? 'ok' : 'fail', error.slice(0, 160));
    setTimeout(() => { if (job === j) job = null; }, 10 * 60e3).unref?.();
  };
  let p;
  try { p = spawnImpl(c.cmd, c.args, { env: binEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
  catch (e) { done(false, 'npm 起不来：' + e.message); return view(j); }
  log?.('install start', claw, s.pkg);
  const onData = d => { j.out = (j.out + d).slice(-8000); const l = lastLine(d); if (l && !/^npm (warn|notice)/i.test(l)) j.tail = l.slice(0, 200); };
  p.stdout?.on('data', onData); p.stderr?.on('data', onData);
  p.on('error', e => done(false, 'npm 起不来：' + e.message));
  p.on('exit', code => {
    if (code === 0) return done(true);
    // 没权限写全局目录（Mac / Linux 用系统自带的 Node 时常见）：说清楚怎么办
    if (/EACCES|EPERM|permission denied/i.test(j.out)) return done(false, '没有权限安装到全局目录。请在电脑终端里运行：sudo npm install -g ' + s.pkg + '，装好回来刷新');
    done(false, 'npm 安装失败（退出码 ' + code + '）：' + (lastLine(j.out.replace(/^npm (warn|notice).*$/gim, '')) || '没有输出'));
  });
  j.timer = setTimeout(() => { try { p.kill(); } catch {} done(false, '安装超过 ' + Math.round(timeoutMs / 60e3) + ' 分钟没完成，已停止（检查网络后再试）'); }, timeoutMs);
  j.timer.unref?.();
  return view(j);
}
