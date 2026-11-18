#!/usr/bin/env node
// claclaw-media：上网找视频 / 音频 / 图片，下载成手机能直接放、直接看的文件。用法见同目录 SKILL.md。
//
// 机制（三类共用一套）：
//   1. 来源都在 sources.mjs，每类多个来源（国内直连的 + 要出墙的），可随时加
//   2. 同一类的所有来源并发搜，每个有时限；够数就提前收（快的来源先回来就不干等慢的）
//   3. 合并、去重、打分（标题贴题 + 来源内排名 + 热度 + 时长合适），再按来源轮流排，结果天然多样
//   4. 下载时按排名逐个试，一个失败（下架、地区限制、防盗链）自动换下一个
//   5. 记每个来源的成败和耗时（~/.claclaw/media/health.json）：连续失败的冷却 30 分钟不再拖慢搜索
//   6. 搜索结果缓存 30 分钟，`get --pick 序号` 直接用上次列表里的那一个
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { SOURCES } from './sources.mjs';

const WIN = process.platform === 'win32';
const HOMEDIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
const TOOLS = path.join(HOMEDIR, 'tools'), STATE = path.join(HOMEDIR, 'media');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const KINDS = { video: '视频', audio: '音频', image: '图片' };

// ---------- 参数 ----------
const argv = process.argv.slice(2);
const cmd = argv.shift();
const opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) pos.push(argv[i]);
  else if (m[2] !== undefined) opt[m[1]] = m[2];
  else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) opt[m[1]] = true;
  else opt[m[1]] = argv[++i];
}
const die = (s, code = 1) => { console.error(s); process.exit(code); };
const USAGE = `用法：
  claclaw-media get    video|audio|image "关键词或网址" [--n 张数] [--max 秒] [--clip 秒] [--max-mb 45] [--src a,b] [--pick 序号]
  claclaw-media find   video|audio|image "关键词" [--n 10] [--max 秒] [--src a,b]
  claclaw-media sources                      来源列表和最近的成败
通用：[--out 目录] [--proxy URL] [--wait 秒]`;

// ---------- 小工具 ----------
const which = b => { const r = spawnSync(WIN ? 'where' : 'which', [b], { encoding: 'utf8' }); return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : ''; };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v)); } catch {} };
const portOpen = port => new Promise(ok => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
  s.setTimeout(500, () => { s.destroy(); ok(false); });
});
// 代理：--proxy > 环境变量 > 本机常见代理端口（Clash 7890 / 7897）。只有要出墙的来源用
let proxyP;
const proxy = () => proxyP ||= (async () => {
  if (opt.proxy) return opt.proxy === true ? '' : opt.proxy;
  const e = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (e) return e;
  for (const p of [7890, 7897]) if (await portOpen(p)) return 'http://127.0.0.1:' + p;
  return '';
})();
function run(bin, args, { quiet = true, timeout = 0 } = {}) {
  return new Promise(ok => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', t = timeout ? setTimeout(() => p.kill(), timeout) : null;
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (!quiet) process.stderr.write(d); });
    p.on('error', e => { clearTimeout(t); ok({ code: -1, out, err: err + e.message }); });
    p.on('exit', code => { clearTimeout(t); ok({ code, out, err }); });
  });
}
// HTTP：直连用 fetch；走代理用 curl（Node 的 fetch 不读代理设置）。binary=true 返回 Buffer
async function http(url, { proxy: viaProxy = false, binary = false, timeout = 8000, referer } = {}) {
  const px = viaProxy ? await proxy() : '';
  if (viaProxy && !px) throw new Error('没有代理');
  if (!px) {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
  }
  const r = await new Promise(ok => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', String(Math.ceil(timeout / 1000)), '-x', px, '-A', UA, '-H', 'accept-language: zh-CN,zh;q=0.9,en;q=0.6', ...(referer ? ['-e', referer] : []), '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', () => ok(null)); p.on('exit', () => ok(Buffer.concat(bufs)));
  });
  if (!r) throw new Error('curl 失败');
  const nl = r.lastIndexOf(10), code = +r.subarray(nl + 1).toString();
  if (code < 200 || code >= 300) throw new Error('HTTP ' + (code || '超时'));
  const body = r.subarray(0, nl);
  return binary ? body : body.toString('utf8');
}

let ytP;
const ytdlpBin = () => ytP ||= (async () => {
  const local = path.join(TOOLS, WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const found = which('yt-dlp') || [path.join(os.homedir(), '.local', 'bin', 'yt-dlp'), local].find(f => fs.existsSync(f));
  if (found) return found;
  fs.mkdirSync(TOOLS, { recursive: true });
  const name = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + name;
  const px = await proxy();
  console.error('没找到 yt-dlp，正在下载 ' + url);
  const r = await run('curl', ['-fsSL', '--max-time', '180', ...(px ? ['-x', px] : []), '-o', local + '.part', url]);
  if (r.code !== 0) die('yt-dlp 下载失败：' + r.err.trim() + '\n可以自己装：brew install yt-dlp / pip install yt-dlp / winget install yt-dlp');
  fs.renameSync(local + '.part', local);
  if (!WIN) fs.chmodSync(local, 0o755);
  return local;
})();
async function ytdlp(args, { proxy: viaProxy = false, timeout = 0, quiet = true } = {}) {
  const px = viaProxy ? await proxy() : '';
  if (viaProxy && !px) throw new Error('没有代理');
  const r = await run(await ytdlpBin(), ['--no-warnings', '--socket-timeout', '15', ...(px ? ['--proxy', px] : []), ...args], { timeout, quiet });
  if (r.code !== 0) throw new Error(r.err.trim().split('\n').filter(l => /ERROR/.test(l)).pop() || r.err.trim().split('\n').pop() || 'yt-dlp 出错');
  return r.out;
}

// ---------- 来源健康 ----------
const HEALTH = path.join(STATE, 'health.json');
const health = readJson(HEALTH, {});
const cooling = id => { const h = health[id]; return h && h.streak >= 3 && Date.now() - h.lastFail < 30 * 60000; };
function note(id, ok, ms) {
  const h = health[id] ||= { ok: 0, fail: 0, streak: 0 };
  if (ok) { h.ok++; h.streak = 0; h.ms = Math.round(h.ms ? h.ms * 0.7 + ms * 0.3 : ms); } else { h.fail++; h.streak++; h.lastFail = Date.now(); }
}

// ---------- 搜索：并发、限时、够数提前收 ----------
async function find(kind, q, { n = 10, max = 0, src = '' } = {}) {
  const want = src ? new Set(String(src).split(',')) : null;
  const hasProxy = !!(await proxy());
  const list = SOURCES.filter(s => s.kinds.includes(kind) && (!want || want.has(s.id)) && (!s.proxy || hasProxy) && (want || !cooling(s.id)));
  if (!list.length) die(`没有能用的${KINDS[kind]}来源` + (hasProxy ? '' : '（没有代理，要出墙的来源都跳过了）'));
  const key = crypto.createHash('sha1').update([kind, q, max, list.map(s => s.id).join(',')].join('\n')).digest('hex').slice(0, 16);
  const cacheF = path.join(STATE, 'cache', key + '.json');
  const cached = readJson(cacheF, null);
  if (cached && Date.now() - cached.at < 30 * 60000 && !opt.fresh) return cached.items;

  const wait = (+opt.wait || (want ? 20 : 10)) * 1000, t0 = Date.now();
  const KV = path.join(STATE, 'kv.json'), kvd = readJson(KV, {});
  const kv = { get: k => kvd[k], set: (k, v) => { kvd[k] = v; writeJson(KV, kvd); } };
  const ctx = { kind, n, max, kv, get: (u, o) => http(u, o), json: async (u, o) => JSON.parse(await http(u, o)), ytdlp: (a, o) => ytdlp(a, { timeout: wait, ...o }) };
  const got = new Map();
  let timedOut = false;
  await new Promise(done => {
    let left = list.length;
    const finish = () => { clearTimeout(timer); clearInterval(tick); done(); };
    const check = () => {
      const have = [...got.values()].filter(v => v.length);
      // 全回来了；或已过 3 秒、六成来源回来了且至少两个有结果、总数够了 —— 不再等慢的
      if (!left || (Date.now() - t0 > 3000 && got.size >= Math.ceil(list.length * 0.6) && have.length >= 2 && have.flat().length >= n * 2)) finish();
    };
    const timer = setTimeout(() => { timedOut = true; finish(); }, wait);
    const tick = setInterval(check, 250);
    for (const s of list) {
      const t = Date.now();
      s.search(q, ctx).then(items => { items = items.filter(x => x && x.title && (x.page || x.file)); got.set(s.id, items); note(s.id, items.length > 0, Date.now() - t); },
        e => { got.set(s.id, []); note(s.id, false, Date.now() - t); if (opt.debug) console.error(s.id, e.message); })
        .finally(() => { left--; check(); });
    }
  });
  if (timedOut) for (const s of list) if (!got.has(s.id)) note(s.id, false, wait);   // 等满时限都没回来的记一次失败（提前收的不算）
  writeJson(HEALTH, health);

  // 打分：贴题（关键词 / 中文两字词命中比例）× 3 + 来源内排名 + 热度（播放量取对数，千万封顶）+ 国内来源 − 合集 / 长直播 / 小图
  const toks = q.toLowerCase().split(/\s+/).filter(Boolean).flatMap(t => /[一-鿿]/.test(t) && t.length > 2 ? [...Array(t.length - 1)].map((_, i) => t.slice(i, i + 2)) : [t]);
  // 中文关键词：国内来源（不用出墙的）略加分，中文内容多、下载也稳
  const cjk = /[一-鿿]/.test(q), scored = [];
  for (const [id, items] of got) {
    items.forEach((x, i) => {
      if (max && x.dur && x.dur > max) return;
      const t = x.title.toLowerCase();
      const rel = toks.length ? toks.filter(k => t.includes(k)).length / toks.length : 0;
      let sc = rel * 3 + 1 / (1 + i * 0.3) + (x.plays ? Math.min(1, Math.log10(1 + x.plays) / 7) * 0.8 : 0.2);
      if (cjk && !SOURCES.find(s => s.id === id)?.proxy) sc += 0.4;
      if (kind !== 'image' && /合集|全集|大合集|完整版|\d+\s*小时|hours?\b|直播|预告|trailer/i.test(x.title)) sc -= 1;
      if (kind === 'image' && x.w && x.h && Math.min(x.w, x.h) < 300) sc -= 1;
      scored.push({ ...x, src: id, sc });
    });
  }
  // 去重（同一个网址 / 同一个文件）
  const seen = new Set(), uniq = scored.sort((a, b) => b.sc - a.sc).filter(x => { const k = x.file || x.page; if (seen.has(k)) return false; seen.add(k); return true; });
  // 多样性：依次挑「分数 − 0.35 × 这个来源已经挑了几个」最高的，好的照样在前，但不会一个来源霸屏
  const picked = new Map(), pool = uniq.slice(), items = [];
  while (pool.length) {
    let bi = 0, bs = -Infinity;
    pool.forEach((x, i) => { const v = x.sc - 0.35 * (picked.get(x.src) || 0); if (v > bs) { bs = v; bi = i; } });
    const [x] = pool.splice(bi, 1);
    picked.set(x.src, (picked.get(x.src) || 0) + 1);
    items.push(x);
  }
  if (items.length) writeJson(cacheF, { at: Date.now(), items });   // 空结果不缓存
  return items;
}

const fmtDur = s => { s = Math.round(+s || 0); if (!s) return '?'; return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtPlays = p => p == null ? '-' : p >= 1e8 ? (p / 1e8).toFixed(1) + '亿' : p >= 1e4 ? (p / 1e4).toFixed(1) + '万' : String(p);
const label = id => SOURCES.find(s => s.id === id)?.id || id;

// ---------- 下载 ----------
const outDir = () => { const d = opt.out || path.join(os.tmpdir(), 'claclaw-media'); fs.mkdirSync(d, { recursive: true }); return d; };
const safeName = s => String(s || 'media').replace(/[\\/:*?"<>|\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 50) || 'media';
const ffmpeg = () => which('ffmpeg');
const ffprobe = (f, entries, sel = []) => { const ff = ffmpeg(); if (!ff) return ''; return spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', ...sel, '-show_entries', entries, '-of', 'csv=p=0', f], { encoding: 'utf8' }).stdout?.trim() || ''; };
const needProxy = x => SOURCES.find(s => s.id === x.src)?.proxy || !/bilibili\.com|b23\.tv/.test(x.page || x.file || '');

async function getVideo(x) {
  const clip = +opt.clip || 0, maxMb = +opt['max-mb'] || 45, budget = Math.max(5, maxMb - 6);
  // 手机都能放：H.264 + AAC 的 mp4。按大小挑 720p → 480p → 360p 里第一个估计不超过上限的；截一段时只下那一段
  const avc = h => `bv*[vcodec^=avc][height<=${h}]` + (clip ? '' : `[filesize_approx<=?${budget}M]`);
  const fmt = [720, 480, 360].map(h => `${avc(h)}+ba[acodec^=mp4a]/${avc(h)}+ba`).join('/') + '/b[vcodec^=avc][height<=720]/bv*[height<=480]+ba/b';
  const o = await ytdlp(['--no-playlist', ...(clip ? ['--download-sections', '*0-' + clip] : []), '-f', fmt, '--merge-output-format', 'mp4',
    '-o', path.join(outDir(), '%(title).50B.%(ext)s'), '--print', 'after_move:filepath', x.page], { proxy: needProxy(x) && !!(await proxy()), timeout: 300000 });
  let file = o.trim().split('\n').pop();
  if (!file || !fs.existsSync(file)) throw new Error('没下到文件');
  const ff = ffmpeg(), codec = ffprobe(file, 'stream=codec_name', ['-select_streams', 'v:0']);
  if (ff && (fs.statSync(file).size / 1048576 > maxMb || (codec && codec !== 'h264') || !/\.mp4$/i.test(file))) {
    // 还是太大 / 不是 H.264：按大小上限算码率转一遍
    const secs = +ffprobe(file, 'format=duration') || 0;
    const vk = Math.min(2500, secs ? Math.max(200, Math.floor(maxMb * 8192 * 0.9 / secs) - 96) : 1500);
    const dst = file.replace(/\.[^.]+$/, '') + '.m.mp4';
    const c = await run(ff, ['-y', '-v', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', vk + 'k', '-maxrate', vk * 1.5 + 'k', '-bufsize', vk * 2 + 'k',
      '-vf', 'scale=-2:min(720\\,ih)', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst]);
    if (c.code !== 0) throw new Error('转码失败');
    fs.rmSync(file, { force: true }); file = dst;
  }
  return file;
}
const PLAYABLE_AUDIO = /\.(mp3|m4a|aac)$/i;   // iPhone / 安卓都能放的；ogg、opus、flac、wav 转成 m4a
async function getAudio(x) {
  const clip = +opt.clip || 0, ff = ffmpeg();
  let file;
  if (x.file && !x.page?.includes('soundcloud.com')) {
    const ext = (/\.(\w{2,4})(?:\?|$)/.exec(x.file)?.[1] || 'mp3').toLowerCase();
    const b = await http(x.file, { binary: true, proxy: needProxy(x) && !!(await proxy()), timeout: 120000 });
    file = path.join(outDir(), safeName(x.title) + '.' + ext);
    fs.writeFileSync(file, b);
  } else {
    const o = await ytdlp(['--no-playlist', ...(clip ? ['--download-sections', '*0-' + clip] : []), '-f', 'ba[acodec^=mp4a]/ba/b', '-x', '--audio-format', 'm4a',
      '-o', path.join(outDir(), '%(title).50B.%(ext)s'), '--print', 'after_move:filepath', x.page], { proxy: needProxy(x) && !!(await proxy()), timeout: 300000 });
    file = o.trim().split('\n').pop();
  }
  if (!file || !fs.existsSync(file)) throw new Error('没下到文件');
  if (ff && (!PLAYABLE_AUDIO.test(file) || (clip && x.file))) {
    const dst = file.replace(/\.[^.]+$/, '') + '.m.m4a';
    const c = await run(ff, ['-y', '-v', 'error', '-i', file, ...(clip ? ['-t', String(clip)] : []), '-vn', '-c:a', 'aac', '-b:a', '128k', dst]);
    if (c.code !== 0) throw new Error('转码失败');
    fs.rmSync(file, { force: true }); file = dst;
  }
  return file;
}
// 只留聊天里能直接显示的格式：jpg / png / gif / webp
const IMG_MAGIC = [['jpg', b => b[0] === 0xff && b[1] === 0xd8], ['png', b => b[0] === 0x89 && b[1] === 0x50], ['gif', b => b.subarray(0, 3).toString() === 'GIF'], ['webp', b => b.subarray(8, 12).toString() === 'WEBP']];
async function getImage(x, i) {
  const px = !!(await proxy());
  const tries = [[x.file, false], ...(px ? [[x.file, true]] : []), ...(x.thumb ? [[x.thumb, false]] : [])];
  for (const [u, viaProxy] of tries) {
    try {
      const b = await http(u, { binary: true, proxy: viaProxy, timeout: 6000, referer: x.page });
      const ext = IMG_MAGIC.find(([, f]) => f(b))?.[0];
      if (!ext || b.length < 3000 || b.length > 20 * 1048576) continue;
      const file = path.join(outDir(), `${safeName(x.title).slice(0, 30)}_${i}.${ext}`);
      fs.writeFileSync(file, b);
      return file;
    } catch {}
  }
  throw new Error('图片下不来');
}

const isUrl = s => /^https?:\/\//i.test(s || '');
async function get(kind, arg) {
  const n = kind === 'image' ? Math.min(+opt.n || 1, 10) : 1;
  let cands;
  if (isUrl(arg)) cands = [kind === 'image' ? { title: 'image', file: arg, src: 'url' } : { title: '', page: arg, src: 'url' }];
  else {
    const items = await find(kind, arg, { n: Math.max(10, n * 3), max: +opt.max || (kind === 'video' ? 600 : kind === 'audio' ? 1800 : 0), src: opt.src });
    if (opt.pick) { const x = items[+opt.pick - 1]; if (!x) die('没有第 ' + opt.pick + ' 个（先 find 看列表）'); cands = [x]; } else cands = items;
  }
  if (!cands.length) die('没找到合适的' + KINDS[kind] + '（换个关键词、放宽 --max，或 --src 指定来源）');
  const done = [];
  if (kind === 'image') {
    // 图片：按排名一批 6 个并发下，够数就停
    for (let i = 0; i < cands.length && done.length < n; i += 6) {
      const r = await Promise.all(cands.slice(i, i + 6).map((x, j) => getImage(x, i + j + 1).then(f => ({ x, f }), () => null)));
      for (const y of r) if (y && done.length < n) done.push(y);
    }
  } else {
    // 视频 / 音频：按排名逐个试，最多 4 个
    for (const x of cands.slice(0, 4)) {
      try { done.push({ x, f: await (kind === 'video' ? getVideo : getAudio)(x) }); break; }
      catch (e) { console.error(`跳过（${label(x.src)}）${x.title.slice(0, 40)}：${e.message.slice(0, 120)}`); }
    }
  }
  if (!done.length) die(KINDS[kind] + '都没下下来（换个关键词或 --src 换来源）');
  for (const { x, f } of done) {
    const mb = fs.statSync(f).size / 1048576;
    // stdout 一行一个：文件路径 \t 大小 \t 来源 \t 时长 \t 标题 \t 出处
    console.log([f, mb.toFixed(1) + 'MB', label(x.src), kind === 'image' ? '' : fmtDur(x.dur), x.title, x.page || x.file].join('\t'));
    if (mb > 50) console.error('超过 50MB，send_file 发不了：加 --clip 截一段，或调小 --max-mb');
  }
}

// ---------- 命令 ----------
const kind = pos[0], arg = pos.slice(1).join(' ').trim();
if (cmd === 'sources') {
  const hasProxy = !!(await proxy());
  console.log('来源\t类型\t出墙\t成功/失败\t平均耗时\t状态');
  for (const s of SOURCES) {
    const h = health[s.id] || {};
    console.log([s.id, s.kinds.map(k => KINDS[k]).join('/'), s.proxy ? '要' : '', `${h.ok || 0}/${h.fail || 0}`, h.ms ? (h.ms / 1000).toFixed(1) + 's' : '-',
      s.proxy && !hasProxy ? '没代理，跳过' : cooling(s.id) ? '连续失败，冷却中' : '可用'].join('\t'));
  }
} else if ((cmd === 'find' || cmd === 'get') && KINDS[kind] && arg) {
  if (cmd === 'find') {
    const items = await find(kind, arg, { n: +opt.n || 10, max: +opt.max || 0, src: opt.src });
    if (!items.length) die('没找到（换个关键词、放宽 --max，或 --src 换来源）');
    console.log(kind === 'image' ? '序号\t来源\t尺寸\t标题\t地址' : '序号\t来源\t时长\t播放\t标题\t网址');
    items.slice(0, Math.max(+opt.n || 10, 1)).forEach((x, i) => console.log(kind === 'image'
      ? [i + 1, label(x.src), x.w && x.h ? x.w + 'x' + x.h : '?', x.title, x.page || x.file].join('\t')
      : [i + 1, label(x.src), fmtDur(x.dur), fmtPlays(x.plays), x.title, x.page || x.file].join('\t')));
  } else await get(kind, arg);
} else die(USAGE);
process.exit(0);   // 不等还没回来的慢来源
