// 帮用户装 Agent：DeepSeek / Gemini CLI 没装时（别的 Claw 装没装都一样），网页的 Claw 页显示它的卡片和「安装」按钮，
// 点了就在电脑上跑 npm install -g 装，装完再引导去登录：DeepSeek 填开放平台的 API key，Gemini 登 Google 账号或填 key（见 login.mjs）。
// - 只能装这里列出的包（不接受网页传来的包名）；同一时间只跑一个
// - 进度：网页每隔几秒取一次 installState()；结果留 10 分钟
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { findBin, binCall, binEnv } from '../util.mjs';

// 当前 Node 旁边的 npm：Windows 在 node.exe 同目录的 node_modules，Mac / Linux 在 bin 的上一级 lib/node_modules
function npmCli() {
  const d = path.dirname(process.execPath);
  for (const f of [path.join(d, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(d, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')]) if (fs.existsSync(f)) return f;
  return null;
}

// allowScripts：npm 从 11.19 起 install -g 默认不跑依赖的安装脚本（只给一句 warn），这里列出要放行的依赖：
//   node-pty / koffi 挑预编译的原生模块，dsh-subprocess-local 给 node-pty 的 spawn-helper 补执行权限（Mac 上缺了跑不了命令）。
//   dsh 新加了带安装脚本的依赖时，npm 输出里 `Run npm install -g --allow-scripts=…` 那句会列出来，照着补进来。
//   旧版 npm 不认这个参数也照常安装（实测 npm 10；那时本来就跑全部脚本）。
export const INSTALLS = {
  deepseek: {
    label: 'DeepSeek Harness', pkg: '@deepseek-ai/dsh@latest', bin: 'dsh',
    // 进度条用的大概数目（2026-11 实测 dsh：查依赖 ≈680 次、装 654 个包、900 多 MB）；查依赖阶段按它估，到顶就停；包数装的时候会数出真的
    expect: { meta: 680, pkgs: 654 },
    allowScripts: ['@deepseek-ai/dsh-subprocess-local', 'node-pty', 'koffi', 'protobufjs', '@google/genai'],
  },
  // Gemini CLI：打包好的一个包（2026-11 实测 0.71：压缩 25 MB，没有必需依赖，可选的 node-pty / keytar 有预编译的，不用放行安装脚本）
  gemini: {
    label: 'Gemini CLI', pkg: '@google/gemini-cli@latest', bin: 'gemini',
    expect: { meta: 12, pkgs: 6 },
  },
};
// Claw 列表里哪些能在网页上一键装：这里列了、这台机器能用、还没装的，标上 canInstall（网页显示卡片和「安装」按钮）
//   以前只在一个 Claw 都没装时才标：模型库里一配上模型 kuAi 就算装了，按钮跟着没了
export function markInstallable(list) { for (const c of list) if (Object.hasOwn(INSTALLS, c.id) && c.supported && !c.installed) c.canInstall = true; return list; }
const pkgArgs = s => [...(s.allowScripts?.length ? ['--allow-scripts=' + s.allowScripts.join(',')] : []), s.pkg];

let job = null;
// 进度：npm 加 --loglevel http 后打 `npm http …` 行，按阶段数出来折成百分比（实测冷装 60 秒：查依赖 25 秒、下载 30 秒、收尾 3 秒）：
//   1. 查依赖（`npm http fetch GET …` 不带 .tgz，≈680 次）0–35%：npm 先把依赖树全查完
//   2. 下载 35–92%：先一口气给每个包打一行 `npm http cache 名@….tgz`（查缓存，这时就知道一共要装几个包），
//      再每下完一个打一行 `npm http fetch GET ….tgz`；按「下完的 / 总数」走（包大小不一，大包会停一会儿）
//   3. 收尾（解压、跑安装脚本）92–99% 按时间慢慢走；装完才到 100
//   缓存里都有（以前装过）：没有下载行，查完缓存 4 秒没动静就算收尾
// 百分比只增不减；elapsed 由服务器算（网页和电脑的钟可能不一样）
const PH_TXT = { resolve: '正在查依赖', fetch: '正在下载', finish: '正在收尾（解压、编译）…' };
function progress(j, now = Date.now()) {
  const E = j.expect || { meta: 600, pkgs: 600 };
  const total = Math.max(j.pkgs.size, j.got.size) || E.pkgs, seen = j.pkgs.size || j.got.size;
  let phase = seen ? 'fetch' : 'resolve', pct = seen ? 35 + 57 * Math.min(1, j.got.size / total) : 2 + 33 * Math.min(1, j.meta / E.meta);
  if (seen && (j.got.size >= total || now - j.lastPkg > (j.got.size ? 20000 : 4000))) { phase = 'finish'; j.finishAt ||= now; pct = 92 + Math.min(7, (now - j.finishAt) / 2500); }
  j.pct = Math.max(j.pct || 0, Math.round(pct));
  j.phase = phase;
  j.tail = phase === 'resolve' ? PH_TXT.resolve + '（' + j.meta + ' / 约 ' + E.meta + '）'
    : phase === 'fetch' ? PH_TXT.fetch + '（' + j.got.size + ' / ' + total + ' 个包）' : PH_TXT.finish;
}
const view = j => {
  if (!j) return j;
  if (j.status === 'running' && j.pkgs) progress(j);
  return { claw: j.claw, label: j.label, status: j.status, tail: j.tail, error: j.error, startedAt: j.startedAt, pct: j.status === 'ok' ? 100 : j.pct || 0, phase: j.phase || '', elapsed: (j.endAt || Date.now()) - j.startedAt };
};
export const installState = () => view(job);
export const installing = () => job?.status === 'running' ? job.claw : '';
export const installReset = () => { if (job?.status !== 'running') job = null; };   // 测试用

// 输出的最后一句有内容的（给网页看进度）
const lastLine = t => String(t).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split(/[\r\n]+/).map(x => x.trim()).filter(Boolean).pop() || '';

// 跑 npm install -g <包>；npmBin / spawnImpl 给测试用
export function installStart(claw, { log, npmBin, spawnImpl = spawn, timeoutMs = 20 * 60e3 } = {}) {
  const s = INSTALLS[claw];
  if (!s) throw new Error('这个 Claw 不能在这里安装');
  if (job?.status === 'running' || (job?.status === 'ok' && job.claw === claw)) return view(job);   // 正在装 / 刚装好：只回进度，不重复装
  const args = ['install', '-g', '--no-fund', '--no-audit', '--loglevel', 'http', ...pkgArgs(s)];
  // 优先用当前 Node 自带的 npm-cli.js 直接跑（Windows 官方安装包的 npm.cmd 不是标准 shim，走 cmd.exe 又会被 Program Files 的空格坑）
  const cli = !npmBin && npmCli();
  const npm = npmBin || (!cli && findBin('npm'));
  if (!cli && !npm) throw new Error('没找到 npm：先装好 Node.js（https://nodejs.org），再回来点安装');
  const c = cli ? { cmd: process.execPath, args: [cli, ...args] } : binCall(npm, args);
  const j = job = { claw, label: s.label, status: 'running', tail: '正在开始…', error: '', startedAt: Date.now(), out: '', expect: s.expect, meta: 0, pkgs: new Set(), got: new Set(), lastPkg: 0, pct: 0, buf: '' };
  const done = (ok, error = '') => {
    if (j.status !== 'running') return;
    clearTimeout(j.timer);
    j.status = ok ? 'ok' : 'fail'; j.error = error; j.tail = ok ? '安装完成' : ''; j.endAt = Date.now();
    log?.('install', claw, ok ? 'ok' : 'fail', error.slice(0, 160));
    setTimeout(() => { if (job === j) job = null; }, 10 * 60e3).unref?.();
  };
  let p;
  try { p = spawnImpl(c.cmd, c.args, { env: binEnv(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); }
  catch (e) { done(false, 'npm 起不来：' + e.message); return view(j); }
  log?.('install start', claw, s.pkg);
  // 按行看：`npm http` 行只拿来数进度（不进 out，免得把出错信息挤掉）；包按文件名去重（查缓存和下载两行的地址写法不一样）
  const onData = d => {
    const lines = (j.buf + d).split(/\r?\n/); j.buf = lines.pop().slice(-4000);
    for (const l of lines) {
      if (/^npm http /.test(l)) { const t = /([^/\s]+\.tgz)\b/.exec(l); if (t) { (/^npm http fetch /.test(l) ? j.got : j.pkgs).add(t[1]); j.lastPkg = Date.now(); } else if (/^npm http fetch /.test(l)) j.meta++; continue; }
      j.out = (j.out + l + '\n').slice(-8000);
    }
  };
  p.stdout?.on('data', onData); p.stderr?.on('data', onData);
  p.on('error', e => done(false, 'npm 起不来：' + e.message));
  p.on('exit', code => {
    if (j.buf) { j.out = (j.out + j.buf).slice(-8000); j.buf = ''; }
    if (code === 0) return done(true);
    // 没权限写全局目录（Mac / Linux 用系统自带的 Node 时常见）：说清楚怎么办
    if (/EACCES|EPERM|permission denied/i.test(j.out)) return done(false, '没有权限安装到全局目录。请在电脑终端里运行：sudo npm install -g ' + pkgArgs(s).join(' ') + '，装好回来刷新');
    done(false, 'npm 安装失败（退出码 ' + code + '）：' + (lastLine(j.out.replace(/^npm (warn|notice).*$/gim, '')) || '没有输出'));
  });
  j.timer = setTimeout(() => { try { p.kill(); } catch {} done(false, '安装超过 ' + Math.round(timeoutMs / 60e3) + ' 分钟没完成，已停止（检查网络后再试）'); }, timeoutMs);
  j.timer.unref?.();
  return view(j);
}
