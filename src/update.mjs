// 应用内更新：脚本装的 claclaw（程序目录是 git 仓库、跟踪着远端分支）在网页里点一下就能更新
//   - 检查：启动 2 分钟后一次，之后每天一次，也能手动点「检查更新」。git fetch 跟踪的远端分支；
//     GitHub 连不上、且是从中继转发的安装脚本装的（data/install-origin.json 记着代码包镜像地址）：改取镜像上的 claclaw.bundle（按 .sha256 校验）
//   - 只提示，不自动装：用户点「更新」才 git merge --ff-only → 依赖有变才 npm install → npm run check → 等所有会话空闲后重启（tools/restart-when-idle.mjs）
//   - 中间哪一步失败：退回原来的版本（git reset --keep，本机没提交的改动不动；依赖装过就按原来的再装一遍），不重启
//   - 不支持的情况：不是 git 仓库（桌面安装包）、没跟踪远端分支、本机有自己的提交（分叉了）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const DAY = 24 * 3600 * 1000;
const WIN = process.platform === 'win32';

export function makeUpdater({ ROOT, DATA, log = () => {}, restart, fetch: get = globalThis.fetch, firstDelay = 120000, interval = DAY, git: gitBin = 'git', npm: npmCmd } = {}) {
  const st = { supported: false, reason: '', running: '', runningAt: 0, latest: null, checkedAt: 0, checking: false, via: '', error: '', phase: '', phaseError: '', to: '' };
  let upstream = '', target = '';

  function run(cmd, args, { timeout = 60000, cwd = ROOT, env = { ...process.env, GIT_TERMINAL_PROMPT: '0' }, shell = false } = {}) {
    return new Promise((ok, no) => {
      execFile(cmd, args, { cwd, timeout, windowsHide: true, maxBuffer: 16 << 20, shell, env }, (e, out, err) => {
        if (e) { e.detail = String(err || out || e.message).trim().split('\n').slice(-3).join(' ').slice(0, 300); return no(e); }
        ok(String(out).trim());
      });
    });
  }
  const git = (args, o) => run(gitBin, ['-C', ROOT, ...args], o);

  const ready = (async () => {
    if (!fs.existsSync(path.join(ROOT, '.git'))) { st.reason = '这份 claclaw 不是从代码仓库装的（比如桌面安装包），不能在这里更新'; return; }
    try {
      const [h, ct] = (await git(['log', '-1', '--format=%H %ct'])).split(' ');
      st.running = h; st.runningAt = Number(ct) * 1000;
    } catch { st.reason = '找不到 git'; return; }
    try { upstream = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']); }
    catch { st.reason = '当前分支没跟踪远端分支，不能自动更新'; return; }
    st.supported = true;
  })();

  function mirror() {
    try { const m = JSON.parse(fs.readFileSync(path.join(DATA, 'install-origin.json'), 'utf8')).relay; return /^https:\/\/[^\s"'<>]+$/.test(m || '') ? m.replace(/\/+$/, '') : ''; } catch { return ''; }
  }

  // 从代码包镜像取：下载 claclaw.bundle，校验，git fetch 进来；返回新版本的 commit
  async function fromMirror(base, branch) {
    const dl = async u => { const r = await get(u, { signal: AbortSignal.timeout(300000) }); if (!r.ok) throw new Error(u + ' → HTTP ' + r.status); return Buffer.from(await r.arrayBuffer()); };
    const want = (await dl(base + '/claclaw.bundle.sha256')).toString().trim().split(/\s+/)[0].toLowerCase();
    const buf = await dl(base + '/claclaw.bundle');
    if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error('代码包校验没通过');
    const f = path.join(os.tmpdir(), 'claclaw-update-' + process.pid + '.bundle');
    fs.writeFileSync(f, buf);
    // 取跟踪的那个分支（代码包里不一定有 HEAD，只有 refs/heads/main）；没有这个分支再试 HEAD
    try {
      try { await git(['fetch', '--quiet', f, 'refs/heads/' + branch], { timeout: 120000 }); }
      catch { await git(['fetch', '--quiet', f, 'HEAD'], { timeout: 120000 }); }
      return await git(['rev-parse', 'FETCH_HEAD']);
    }
    finally { fs.rmSync(f, { force: true }); }
  }

  async function check() {
    await ready;
    if (!st.supported || st.checking || ['pull', 'deps', 'check'].includes(st.phase)) return view();
    st.checking = true; st.error = '';
    try {
      const [remote, ...rest] = upstream.split('/');
      try {
        await git(['-c', 'http.lowSpeedLimit=1000', '-c', 'http.lowSpeedTime=20', 'fetch', '--quiet', remote, rest.join('/')], { timeout: 120000 });
        target = await git(['rev-parse', upstream]); st.via = 'git';
      } catch (e) {
        const m = mirror();
        if (!m) throw new Error('连不上代码仓库：' + (e.detail || e.message));
        log('update: git fetch 失败，改用代码包镜像', e.detail || e.message);
        target = await fromMirror(m, rest.join('/')); st.via = 'mirror';
      }
      const behind = Number(await git(['rev-list', '--count', 'HEAD..' + target]));
      if (!behind) { st.latest = null; target = ''; }
      else {
        const ahead = Number(await git(['rev-list', '--count', target + '..HEAD']));
        const lines = (await git(['log', '--format=%h%x09%ct%x09%s', '-n', '30', 'HEAD..' + target])).split('\n').filter(Boolean);
        const [, tct] = (await git(['log', '-1', '--format=%h %ct', target])).split(' ');
        st.latest = {
          commit: target.slice(0, 7), at: Number(tct) * 1000, count: behind,
          log: lines.map(l => { const [h, ct, ...s] = l.split('\t'); return { h, at: Number(ct) * 1000, s: s.join('\t') }; }),
          diverged: ahead > 0,
        };
        if (st.phase === 'failed' && st.to !== target.slice(0, 7)) { st.phase = ''; st.phaseError = ''; }   // 又出了更新的版本：上次失败的提示不再显示
      }
      st.checkedAt = Date.now();
    } catch (e) { st.error = e.message; log('update: 检查失败', e.message); }
    finally { st.checking = false; }
    return view();
  }

  function npmBin() {
    if (npmCmd) return npmCmd;
    const f = path.join(path.dirname(process.execPath), WIN ? 'npm.cmd' : 'npm');
    return fs.existsSync(f) ? f : WIN ? 'npm.cmd' : 'npm';
  }
  async function npmInstall() {
    // 跑 claclaw 的这个 node 放在 PATH 最前面（npm 装原生模块时会调 node）；Windows 环境变量名不分大小写，沿用原来那个键
    const env = { ...process.env }, k = Object.keys(env).find(x => x.toLowerCase() === 'path') || 'PATH';
    env[k] = path.dirname(process.execPath) + path.delimiter + (env[k] || '');
    const args = ['install', '--no-audit', '--no-fund'];
    if (st.via === 'mirror' && !Object.keys(process.env).some(k => k.toLowerCase() === 'npm_config_registry')) args.push('--registry', 'https://registry.npmmirror.com');   // GitHub 都连不上，npm 官方源多半也慢
    const b = npmBin();
    await run(WIN && /\.cmd$/i.test(b) ? '"' + b + '"' : b, args, { timeout: 20 * 60000, env, shell: WIN && /\.cmd$/i.test(b) });
  }

  async function apply() {
    await ready;
    if (!st.supported) throw new Error(st.reason);
    if (['pull', 'deps', 'check', 'restart'].includes(st.phase)) return view();
    if (!st.latest || !target) throw new Error('已经是最新');
    if (st.latest.diverged) throw new Error('本机有自己的提交，和新版本分叉了，不能自动更新');
    const old = await git(['rev-parse', 'HEAD']), to = target;
    st.to = to.slice(0, 7); st.phaseError = '';
    let depsTouched = false;
    (async () => {
      try {
        st.phase = 'pull';
        await git(['merge', '--ff-only', '--quiet', to]);
        const changed = await git(['diff', '--name-only', old, to, '--', 'package.json', 'package-lock.json']);
        if (changed) { st.phase = 'deps'; depsTouched = true; await npmInstall(); }
        st.phase = 'check';
        await run(process.execPath, [path.join(ROOT, 'tools', 'check.mjs')], { timeout: 180000 });
        st.phase = 'restart';
        log('update: 已更新', old.slice(0, 7), '→', st.to, '，等空闲重启');
        try { fs.writeFileSync(path.join(DATA, 'update-last.json'), JSON.stringify({ from: old.slice(0, 7), to: st.to, at: Date.now() })); } catch {}
        st.latest = null; target = '';
        await restart('更新到 ' + st.to);
      } catch (e) {
        const step = { pull: '取新版本', deps: '安装组件', check: '自检', restart: '排重启' }[st.phase] || st.phase;
        log('update: 失败', step, e.detail || e.message);
        if (st.phase === 'restart') { st.phaseError = '新版本已装好，但没能排上重启：重启电脑后生效'; return; }
        // 退回原来的版本：本机没提交的改动保留（--keep）
        try { if ((await git(['rev-parse', 'HEAD'])) !== old) await git(['reset', '--keep', old]); if (depsTouched) await npmInstall().catch(() => {}); } catch (e2) { log('update: 退回失败', e2.detail || e2.message); }
        st.phase = 'failed'; st.phaseError = step + '这一步没成：' + (e.detail || e.message);
      }
    })();
    return view();
  }

  function view() {
    let last = null;
    try { last = JSON.parse(fs.readFileSync(path.join(DATA, 'update-last.json'), 'utf8')); } catch {}
    return {
      supported: st.supported, reason: st.reason, running: st.running.slice(0, 7), runningAt: st.runningAt,
      latest: st.latest, checkedAt: st.checkedAt, checking: st.checking, via: st.via, error: st.error,
      phase: st.phase, phaseError: st.phaseError, to: st.to,
      last: last && last.to === st.running.slice(0, 7) && Date.now() - last.at < 7 * DAY ? last : null,   // 刚更新完、重启好了：网页提示一次
    };
  }

  let timer = null;
  function start() {
    ready.then(() => {
      if (!st.supported) { log('update: 不检查更新：' + st.reason); return; }
      timer = setTimeout(function tick() { check().finally(() => { timer = setTimeout(tick, interval); timer.unref?.(); }); }, firstDelay);
      timer.unref?.();
    });
  }
  const stop = () => clearTimeout(timer);

  return { ready, check, apply, view, start, stop };
}
