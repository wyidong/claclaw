#!/usr/bin/env node
// 影音技能共用的引擎：上网找视频 / 音频 / 图片 / 电影。不直接给 AI 用，由各技能的入口调用：
//   claw-video（视频）、claw-audio（歌 / 音频）、claw-movie（电影）、claw-image（图片），见 skills/_lib/media/cli.mjs。
// 入口把自己的命令翻译成下面 USAGE 里的形式（process.argv），再 import 这个文件。
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
import { SOURCES, embedded, walk } from './sources.mjs';

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
const USAGE = process.env.CLACLAW_MEDIA_USAGE || `用法：
  claclaw-media link   video|audio "关键词" [--n 1] [--max 秒] [--src a,b]   在线播放链接（聊天里直接播放，不下载）
  claclaw-media movies ["类型 / 片名 / 演员"] [--n 10] [--new] [--year 2026] [--since 2006] [--min 7] [--latest]   官方频道免费完整电影片单（带豆瓣分）；--pick 序号 出播放链接
  claclaw-media related "B 站 / YouTube 视频网址" [--n 20] [--json]   这个视频的相关视频（能在聊天里直接播的）
  claclaw-media stream "YouTube / Dailymotion / Archive 网址" [--height 1080]   投屏用：电视能播的流（JSON，claclaw 服务器调）
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
async function http(url, { proxy: viaProxy = false, binary = false, timeout = 8000, referer, curl = false, ua = UA, body } = {}) {   // body：POST 的 JSON 字符串
  const px = viaProxy ? await proxy() : '';
  if (viaProxy && !px) throw new Error('没有代理');
  if (!px && !curl) {   // curl=true：有的站（猫眼）认 Node fetch 的指纹、回验证页，改用 curl
    const r = await fetch(url, { ...(body ? { method: 'POST', body } : {}), headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.6', ...(body ? { 'content-type': 'application/json' } : {}), ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return binary ? Buffer.from(await r.arrayBuffer()) : r.text();
  }
  const r = await new Promise(ok => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', String(Math.ceil(timeout / 1000)), ...(px ? ['-x', px] : []), '-A', ua, '-H', 'accept-language: zh-CN,zh;q=0.9,en;q=0.6', ...(referer ? ['-e', referer] : []), ...(body ? ['-H', 'content-type: application/json', '--data-binary', body] : []), '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', () => ok(null)); p.on('exit', () => ok(Buffer.concat(bufs)));
  });
  if (!r) throw new Error('curl 失败');
  const nl = r.lastIndexOf(10), code = +r.subarray(nl + 1).toString();
  if (code < 200 || code >= 300) throw new Error('HTTP ' + (code || '超时'));
  const res = r.subarray(0, nl);
  return binary ? res : res.toString("utf8");
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
  if (r.code !== 0) throw new Error((opt.debug ? 'code=' + r.code + ' ' + r.err.slice(-300) + ' ' : '') + r.err.trim().split('\n').filter(l => /ERROR/.test(l)).pop() || r.err.trim().split('\n').pop() || 'yt-dlp 出错');
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
      let sc = rel * 3 + 1 / (1 + i * 0.3) + (x.plays ? Math.min(1, Math.log10(1 + x.plays) / 7) * 1.2 : 0);
      if (cjk && !SOURCES.find(s => s.id === id)?.proxy) sc += 0.4;
      if (kind !== 'image' && /系列\s*\d{2,}|第\s*(?:0*[2-9]\d*|0*1\d+|[二三四五六七八九]?十[一二三四五六七八九]?|百)\s*[集讲講回篇期课]|\bEP?\s*\d{2,}\b/i.test(x.title)) sc -= 0.8;   // 连续剧 / 系列课的中间一集：单看没头没尾
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
    // 长视频（讲座之类）码率低：音频降到 64k、画面按码率降到 480p / 360p，免得超过大小上限
    const ak = secs > 900 ? 64 : 96;
    const vk = Math.min(2500, secs ? Math.max(80, Math.floor(maxMb * 8192 * 0.85 / secs) - ak) : 1500);
    const hMax = vk < 350 ? 360 : vk < 700 ? 480 : 720;
    const dst = file.replace(/\.[^.]+$/, '') + '.m.mp4';
    const c = await run(ff, ['-y', '-v', 'error', '-i', file, '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', vk + 'k', '-maxrate', vk * 1.5 + 'k', '-bufsize', vk * 2 + 'k',
      '-vf', `scale=-2:min(${hMax}\\,ih)`, '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', ak + 'k', '-movflags', '+faststart', dst]);
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
  if (!cands.length) die('没找到合适的' + KINDS[kind] + '（换个关键词、放宽 --max，或 --src 指定来源）', 2);
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
  if (!done.length) die(KINDS[kind] + '都没下下来（换个关键词或 --src 换来源）', 2);
  for (const { x, f } of done) {
    const mb = fs.statSync(f).size / 1048576;
    // stdout 一行一个：文件路径 \t 大小 \t 来源 \t 时长 \t 标题 \t 出处
    console.log([f, mb.toFixed(1) + 'MB', label(x.src), kind === 'image' ? '' : fmtDur(x.dur), x.title, x.page || x.file].join('\t'));
    if (mb > 50) console.error('超过 50MB，send_file 发不了：加 --clip 截一段，或调小 --max-mb');
  }
}

// 在线播放：只要能嵌在 claclaw 聊天里直接播放的（网页播放器能嵌入的站点、或媒体文件直链）。不下载、不转码，画质就是原站的。
// 输出 Markdown 链接 [标题](网址)：claclaw 聊天里看到这种链接会在消息下面放一个播放卡片，点一下就在会话里播放
const EMBEDDABLE = /^https?:\/\/(?:www\.|m\.)?(?:nfb\.ca\/film\/|bilibili\.com\/video\/BV|youtube\.com\/watch|youtu\.be\/|dailymotion\.com\/video\/|vimeo\.com\/\d|archive\.org\/details\/|soundcloud\.com\/[\w-]+\/(?!sets\/)[\w-]+)/i;
const MEDIA_FILE = /\.(mp4|webm|m4v|mov|m3u8|mp3|m4a|aac|ogg|oga|opus|wav|flac)(?:[?#]|$)/i;
async function link(kind, q) {
  if (kind === 'image') die('图片要下载后发文件（claw-image）');
  const n = Math.min(+opt.n || 1, 5);
  const items = (await find(kind, q, { n: Math.max(10, n * 3), max: +opt.max || (kind === 'video' ? 1800 : 3600), src: opt.src }))
    .map(x => ({ ...x, url: x.page && EMBEDDABLE.test(x.page) ? x.page : x.file && MEDIA_FILE.test(x.file) ? x.file : '' })).filter(x => x.url);
  // 前几个并发核对能不能嵌入（来源有 embed 检查的才查，比如 YouTube 作者可能关了嵌入），按原排名取前 n 个
  const ctx = { get: (u, o) => http(u, o), json: async (u, o) => JSON.parse(await http(u, o)) };
  const head = items.slice(0, n + 4);
  const ok = await Promise.all(head.map(x => { const s = SOURCES.find(s => s.id === x.src); return s?.embed ? s.embed(x, ctx).then(r => { if (!r && opt.debug) console.error("不能嵌入", x.page); return r; }, () => false) : true; }));
  const out = head.filter((_, i) => ok[i]).slice(0, n);
  if (!out.length) die('没找到能在聊天里直接播放的' + KINDS[kind] + '（换个关键词，或 --src 换来源）', 2);
  // stdout 一行一个：Markdown 链接 \t 来源 \t 时长 \t 播放量。回复里原样贴 Markdown 链接即可
  for (const x of out) console.log([`[${x.title.replace(/[\[\]]/g, ' ').trim()}](${x.url})`, label(x.src), fmtDur(x.dur), fmtPlays(x.plays)].join('\t'));
}

// 电影：只要版权方官方频道（YouTube 认证标记，或爱奇艺 / 优酷 / 腾讯 WeTV / 芒果 / 华策 / 央视等官方影视频道）免费公开的完整版，
// 而且能嵌在 claclaw 聊天里直接播放。先给片单（不带链接），用户挑好再 --pick 出播放链接
const OFFICIAL = /爱奇艺|iQIYI|YOUKU|优酷|WeTV|腾讯视频|Tencent Video|企鹅影视|企鹅大影院|Mango ?TV|芒果|华策|Huace|CCTV|央视|中国电影频道|1905电影|Fandor|FilmRise|Popcornflix|Moviedome|Shout! ?Studios|Sony Pictures|Paramount|Lionsgate|Viki|緯來|Videoland|公視|PTS|東森|三立|民視|TVB|myTV SUPER|美亞|Mei Ah|寰宇|Universe Films|英皇|Emperor Motion|天映|Celestial|Fortune Star|星空華文|嘉禾|Golden Harvest|VSO|Q1Q2|CONtv|卫视|Мосфильм|Mosfilm|Киностудия Горького|Gorky Film|한국고전영화|Korean Classic Film|Korean Film Archive|Grjngo|National Film Board|\bNFB\b/i;   // 大小平台、电视台、片商的官方频道（另外 YouTube 认证频道都算）
const NOT_MOVIE = /预告|trailer|teaser|解说|速看|说电影|看电影|剪辑|混剪|合集|全集|集锦|专辑|小品|晚会|春晚|片段|花絮|reaction|review|recap|explained|episode|\bEP\s?\d|第\s*\d+\s*[集期]|MV\b|综艺|年代秀|精華|精华|完结|動漫|动漫|短剧|短劇|精编版|(?:^|[^\d])20\d{6}(?!\d)|直播港澳台|新闻|\d+期|hindi dubbed|】\s*[上下]\s|\bpart\s?\d/i;   // 上 / 下、Part 1：拆成几段的不算完整版
function movieName(t) {   // 片名：《》里的；没有就用不是「Multi Sub / 4K / 类型」的【】；再不行用 [] 或去掉修饰的标题
  let m = /《#?([^》]{1,30})》/.exec(t); if (m) return m[1].trim();
  m = /[｜|]\s*([^｜|(（]{1,20}?)\s*[(（][A-Za-z][^)）]*[)）]\s*[｜|]/.exec(t); if (m) return m[1].trim();   // 港片频道：…｜片名 (English Name)｜演员…
  for (const b of t.matchAll(/【([^】]{2,40})】/g)) if (!/multi ?sub|eng ?sub|movie|4k|1080p|完整版|电影|中字|抢先看|会员|独播|首播|新片|大片|喜剧|动作|爱情|悬疑|犯罪|冒险|剧情|奇幻|武侠|恐怖|惊悚/i.test(b[1])) return b[1].trim();
  m = /^\[([^\]]{2,40})\]/.exec(t); if (m && !/full ?movie|multi ?sub|eng ?sub|4k|1080p|movie/i.test(m[1])) return m[1].trim();
  if (!/[一-鿿]/.test(t)) {   // 外文标题：去掉年份、清晰度、「Full Movie」和后面的演员表
    const e = t.replace(/\{[^}]*\}|\([^)]*\)|\[[^\]]*\]/g, ' ').split(/\s[-–|｜:]\s|\s*[|｜]|:\s|\b(?:full\s+(?:\w+\s+)?movie|4k|hd|1080p|with english subtitles|english version)\b/i)[0].replace(/\s+/g, ' ').trim();
    if (e.length >= 2) return e.slice(0, 40);
  }
  return t.replace(/【[^】]*】|\[[^\]]*\]/g, '').replace(/[|｜#].*$/, '').trim().slice(0, 40) || t.slice(0, 40);
}
// 小而专的官方片库频道：关键词说到这些（苏联 / 韩国老片 / 西部片…）时直接翻它们的上传列表，一搜就是整部的正版老片
// Mosfilm、高尔基电影制片厂（苏联 / 俄罗斯官方，多带字幕）；韩国电影资料馆「韩国古典电影」（带英文字幕）；Grjngo（西部片片商）
const THEME_CHANNELS = [
  [/苏联|俄罗斯|俄国|前苏|soviet|russian|mosfilm/i, ['user/mosfilm', '@GorkyFilmStudio']],
  [/韩国|韩影|朝鲜|korean/i, ['@KoreanFilm']],
  [/西部|牛仔|western|cowboy/i, ['@GrjngoWesternMovies']],
];
// 官方影视频道（新片多先放这里）：--new 时直接翻它们最近上传的
const MOVIE_CHANNELS = ['@iQIYIMOVIETHEATER', '@youkumovie', '@TencentVideoMovie'];
// 频道最近上传的 n 条：直接取频道「视频」页（内嵌前 30 条）+ 接口翻页，不开 yt-dlp，十几个频道并发几秒取完。
// 会员专享、还没开播的首映、没有时长的跳过；ago = 上传了多久（秒，按「3天前」这种文字估算，排新旧用）
const AGO = { 秒: 1, 分钟: 60, 小时: 3600, 天: 86400, 周: 604800, 个月: 2592000, 月: 2592000, 年: 31536000, second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 };
async function channelLatest(h, n = 50) {
  const out = [];
  try {
    const page = () => http(`https://www.youtube.com/${h}/videos?hl=zh-CN`, { proxy: true, timeout: 15000 });
    const html = await page().catch(page);   // 偶尔超时：再试一次
    const ver = /"INNERTUBE_CLIENT_VERSION":"([^"]+)"/.exec(html)?.[1] || '2.20261116.00.00';
    let data = embedded(html, 'ytInitialData'), chName = /<meta property="og:title" content="([^"]+)"/.exec(html)?.[1] || h;
    for (let page = 0; data && out.length < n && page < 8; page++) {
      let token = null;
      for (const l of walk(data, 'lockupViewModel')) {
        const md = l.metadata?.lockupMetadataViewModel, js = JSON.stringify(l);
        const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).flatMap(r => r.metadataParts || []).map(p => p.text?.content || '');
        const dur = /"text":"(\d+(?::\d\d){1,2})"/.exec(js)?.[1];
        if (!l.contentId || !dur || /BADGE_MEMBERS_ONLY|UPCOMING|首播/.test(js)) continue;
        const ago = parts.map(t => /(\d+)\s*(秒|分钟|小时|天|周|个月|月|年|second|minute|hour|day|week|month|year)/.exec(t)).find(Boolean);
        out.push({ page: 'https://www.youtube.com/watch?v=' + l.contentId, title: md?.title?.content || '', dur: dur.split(':').reduce((a, x) => a * 60 + +x, 0),
          plays: num(parts.find(t => /^[\d.,]+\s*(万|亿|K|M|B)?(次观看)?$/i.test(t))), ago: ago ? +ago[1] * AGO[ago[2]] : undefined, channel: chName, verified: true });
      }
      // 下一页的口令在视频网格的最后一项里（页面上别的 continuation 是排序按钮的，不能用）
      const grid = [...walk(data, 'richGridRenderer')][0]?.contents || [...walk(data, 'appendContinuationItemsAction')][0]?.continuationItems || [];
      token = grid.at(-1)?.continuationItemRenderer?.continuationEndpoint?.continuationCommand?.token || null;
      if (!token || out.length >= n) break;
      data = JSON.parse(await http('https://www.youtube.com/youtubei/v1/browse?prettyPrint=false', { proxy: true, timeout: 15000, body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: ver, hl: 'zh-CN', gl: 'HK' } }, continuation: token }) }));
    }
  } catch (e) { if (opt.debug) console.error(h, e.message); }
  return out.slice(0, n);
}
const num = s => { const m = /([\d.,]+)\s*(万|亿|K|M|B)?/i.exec(String(s || '')); if (!m) return undefined; return Math.round(parseFloat(m[1].replace(/,/g, '')) * ({ 万: 1e4, 亿: 1e8, K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 }[m[2]] || 1)); };
// Dailymotion：只收这些官方账号（它的认证标记里机器人频道很多，不能当官方看）
const DM_OWNERS = ['chinahuacegroup', 'sztvofficial', 'MangoTV-Official'];
async function dmMovies(q, fresh) {
  const f = '&longer_than=60&limit=40&fields=id,title,duration,views_total,owner.screenname,owner.username,allow_embed,geoblocking';
  const urls = [`https://api.dailymotion.com/videos?owners=${DM_OWNERS.join(',')}${q ? '&search=' + encodeURIComponent(q) : ''}&sort=${fresh ? 'recent' : q ? 'relevance' : 'visited'}` + f];
  if (q) urls.push('https://api.dailymotion.com/videos?search=' + encodeURIComponent(q + ' 电影') + f);
  const js = await Promise.all(urls.map(u => http(u, { proxy: true, timeout: 12000 }).then(JSON.parse).catch(() => ({}))));
  return js.flatMap(j => j.list || []).filter(v => v.allow_embed !== false && !(v.geoblocking || []).includes('deny'))
    .filter(v => DM_OWNERS.includes(v['owner.username']) || OFFICIAL.test(v['owner.screenname'] || ''))
    .map(v => ({ src: 'dailymotion', page: 'https://www.dailymotion.com/video/' + v.id, title: v.title, dur: v.duration, plays: v.views_total, channel: v['owner.screenname'] + '（Dailymotion）', official: true }));
}
// Internet Archive 的公版老电影（feature_films 合集，版权已过期或权利人放出的，合法免费）：英文关键词，或下面这些中文类型词
const ARCHIVE_WORDS = { 喜剧: 'comedy', 恐怖: 'horror', 科幻: 'science fiction', 西部: 'western', 黑色: 'film noir', 悬疑: 'mystery', 惊悚: 'thriller', 爱情: 'romance', 战争: 'war', 犯罪: 'crime', 动画: 'animation', 默片: 'silent', 卓别林: 'chaplin', 希区柯克: 'hitchcock', 好莱坞: '', 欧美: '', 老片: '', 经典: '', 黑白: '', 公版: '' };
// NFB 加拿大国家电影局（nfb.ca）：公益片库，公开接口不用 key，纪录片、动画、剧情片都免费看，播放器允许嵌入。
// 只收公开（is_public）、不锁区、一小时以上的；英文关键词，或上面那些中文类型词 / 纪录片 / 加拿大
const NFB_WORDS = { ...ARCHIVE_WORDS, 纪录片: 'documentary', 记录片: 'documentary', 加拿大: '', 原住民: 'indigenous', 历史: 'history', 自然: 'nature' };
async function nfbMovies(q) {
  if (!q) return [];
  const hasCjk = /[一-鿿]/.test(q);
  if (hasCjk && !/加拿大|nfb/i.test(q) && !Object.keys(NFB_WORDS).some(k => q.includes(k))) return [];
  const w = q.replace(/[一-鿿]+/g, m => Object.entries(NFB_WORDS).filter(([k]) => m.includes(k)).map(([, v]) => v).join(' ')).replace(/\bnfb\b/ig, '').trim();
  const j = await http('https://publicapi.nfb.ca/api/v5/films?locale=en&subset=nfb%2Fpublished&safe_search=true&page=1&size=60&query=' + encodeURIComponent(w || 'feature'), { timeout: 12000 }).then(JSON.parse).catch(() => ({}));
  return (j.items || []).filter(f => f.availability?.is_public && !f.geoblocked && f.duration >= 3600 && f.slug)
    .map(f => ({ src: 'nfb', page: 'https://www.nfb.ca/film/' + f.slug + '/', title: f.title + (f.year ? ' (' + f.year + ')' : ''), dur: Math.round(f.duration), channel: 'NFB 加拿大国家电影局', official: true, rel: hasCjk, db: f.year ? { year: f.year } : undefined }));
}
async function archiveMovies(q) {
  let w = q.replace(/[一-鿿]+/g, m => Object.entries(ARCHIVE_WORDS).filter(([k]) => m.includes(k)).map(([, v]) => v).join(' ')).trim();
  if (q && /[一-鿿]/.test(q) && !Object.keys(ARCHIVE_WORDS).some(k => q.includes(k))) return [];   // 中文片名 / 演员：公版库里没有，不查
  if (!q) return [];
  const j = await http('https://archive.org/advancedsearch.php?q=' + encodeURIComponent('collection:feature_films AND mediatype:movies' + (w ? ` AND (${w})` : '')) + '&fl[]=identifier&fl[]=title&fl[]=runtime&fl[]=year&fl[]=downloads&sort[]=downloads+desc&rows=40&output=json', { proxy: true, timeout: 12000 }).then(JSON.parse).catch(() => ({}));
  const rt = s => { s = String(s || ''); const m = /(\d+)\s*min/i.exec(s); return m ? +m[1] * 60 : s.includes(':') ? s.split(':').reduce((a, x) => a * 60 + (+x || 0), 0) : 0; };
  return (j.response?.docs || []).filter(d => !/\bsex\b|nudist|burlesque/i.test([].concat(d.title)[0] || '')).map(d => ({ src: 'archive', page: 'https://archive.org/details/' + d.identifier, title: [].concat(d.title)[0] || d.identifier, dur: rt(d.runtime), plays: d.downloads, channel: 'Internet Archive 公版', official: true, rel: !!w, db: d.year ? { year: +String(d.year).slice(0, 4) } : undefined }));
}
// 片子资料：猫眼（年份、类型、是不是剧集、猫眼评分；不限流）+ 豆瓣评分（限流很紧：只给最后片单里的查，一个一个查，被拦就停）。
// 都存盘 30 天（~/.claclaw/media/filmmeta.json），查过的不再查
const FILMMETA = path.join(STATE, 'filmmeta.json');
const fmCache = readJson(FILMMETA, {});
const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
async function maoyan(name) {
  const c = fmCache['my:' + name];
  if (c && Date.now() - c.at < 30 * 86400000) return c.v;
  try {
    let d = null;
    for (let t = 0; t < 2 && !d; t++) {   // 偶尔回验证页（不是 JSON）：歇一下再试一次
      d = await http('https://m.maoyan.com/ajax/search?cityId=1&stype=-1&kw=' + encodeURIComponent(name), { curl: true, ua: MOBILE_UA, timeout: 6000 }).then(t => JSON.parse(t)).catch(() => null);
      if (!d) await new Promise(z => setTimeout(z, 800));
    }
    if (!d) return null;
    const m = (d.movies?.list || []).find(x => x.nm === name || x.nm?.replace(/[：:·\s]/g, '') === name.replace(/[：:·\s]/g, ''));
    const v = !m ? null : /剧/.test(m.movieTypeDesc || '') ? { tv: true }
      : { year: +String(m.rt || m.pubDesc || '').slice(0, 4) || undefined, genres: (m.cat || '').replace(/,/g, '/'), type: m.movieTypeDesc || '', my: m.sc > 0 ? m.sc : undefined };
    fmCache['my:' + name] = { at: Date.now(), v }; writeJson(FILMMETA, fmCache);
    return v;
  } catch { return null; }
}
const strip = t => String(t || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();
// IMDb 评分（经 Stremio 的 Cinemeta 公开接口，要出墙）：外文片、豆瓣查不到时用。存盘 30 天
async function imdbRate(name, year) {
  const c = fmCache['im:' + name];
  if (c && Date.now() - c.at < 30 * 86400000) return c.v;
  try {
    const norm = t => String(t || '').toLowerCase().replace(/[^a-z0-9一-鿿]/g, '');
    const j = await http('https://v3-cinemeta.strem.io/catalog/movie/top/search=' + encodeURIComponent(name) + '.json', { proxy: true, timeout: 8000 }).then(JSON.parse);
    const m = (j.metas || []).find(x => norm(x.name) === norm(name) && (!year || !+x.releaseInfo || Math.abs(+x.releaseInfo - year) <= 1));
    let v = null;
    if (m) {
      const d = (await http('https://v3-cinemeta.strem.io/meta/movie/' + m.imdb_id + '.json', { proxy: true, timeout: 8000 }).then(JSON.parse)).meta || {};
      if (+d.imdbRating) v = { r: +d.imdbRating, year: +String(d.releaseInfo || d.year || '').slice(0, 4) || undefined, genres: (d.genres || d.genre || []).join('/') };
    }
    fmCache['im:' + name] = { at: Date.now(), v }; writeJson(FILMMETA, fmCache);
    return v;
  } catch { return undefined; }
}
// 360 影视（api.so.360kan.com）：上映日期、地区、类型、豆瓣分、是不是剧集；国内直连、不限流（猫眼、豆瓣被拦时靠它）。存盘 30 天
async function kan360(name) {
  const c = fmCache['k3:' + name];
  if (c && Date.now() - c.at < 30 * 86400000) return c.v;
  try {
    const norm = t => String(t || '').toLowerCase().replace(/[\s：:·,，.!！?？\-—]/g, '');
    const d = JSON.parse(await http('https://api.so.360kan.com/index?force_v=1&kw=' + encodeURIComponent(name) + '&from=&pageno=1&v_ap=1&tab=all', { timeout: 8000 }));
    const m = (d.data?.longData?.rows || []).find(x => norm(x.titleTxt) === norm(name));
    let v = null;
    if (m && m.cat_name !== '电影') v = { tv: true };
    else if (m) {
      const t = JSON.parse(await http(`https://api.web.360kan.com/v1/detail?cat=1&id=${m.en_id}`, { timeout: 8000 })).data || {};
      const date = /^\d{4}-\d\d-\d\d/.test(t.pubdate || '') ? t.pubdate.slice(0, 10) : '';
      v = { year: +(date || m.year).slice(0, 4) || undefined, date, area: (t.area || m.area || []).join('/'), genres: (t.moviecategory || m.tag || []).join('/'), rating: +t.doubanscore || undefined };
    }
    fmCache['k3:' + name] = { at: Date.now(), v }; writeJson(FILMMETA, fmCache);
    return v;
  } catch { return undefined; }
}
let doubanBlocked = false;
// 豆瓣网页搜索（www.douban.com/search）：接口被限流时用它，目前不要登录。返回 [{ type, title, orig, year, r, n }]
async function doubanHtml(q) {
  const h = await http('https://www.douban.com/search?cat=1002&q=' + encodeURIComponent(q), { timeout: 8000 });
  return h.split('class="result"').slice(1).map(b => {
    const cast = strip(/subject-cast">([^<]*)/.exec(b)?.[1] || '');
    return { type: /<span>\[([^\]]+)\]<\/span>/.exec(b)?.[1] || '', title: strip(/<h3>[\s\S]*?<a [^>]*>([^<]*)<\/a>/.exec(b)?.[1] || ''),
      orig: /^原名:([^/]+)/.exec(cast)?.[1]?.trim() || '', year: +(/(\d{4})\s*$/.exec(cast)?.[1]) || undefined,
      r: +(/rating_nums">([\d.]+)/.exec(b)?.[1]) || undefined, n: +(/\((\d+)人评价\)/.exec(b)?.[1]) || 0 };
  });
}
async function doubanRate(name, year) {
  const c = fmCache['db:' + name];
  if (c && Date.now() - c.at < 30 * 86400000) return c.v;
  if (doubanBlocked) {   // 接口被拦：改查网页搜索
    try {
      const norm = t => String(t || '').toLowerCase().replace(/[\s：:·'’,.!?-]/g, '');
      const m = (await doubanHtml(name)).filter(x => x.type !== '电视剧' && (norm(x.title) === norm(name) || norm(x.orig) === norm(name)) && (!year || !x.year || Math.abs(x.year - year) <= 1))[0];
      const v = m?.r ? { r: m.r, n: m.n, year: m.year } : null;
      fmCache['db:' + name] = { at: Date.now(), v }; writeJson(FILMMETA, fmCache);
      return v;
    } catch { return undefined; }
  }
  try {
    const d = await fetch('https://m.douban.com/rexxar/api/v2/search/movie?count=5&q=' + encodeURIComponent(name), { headers: { 'user-agent': MOBILE_UA, referer: 'https://m.douban.com/search/' }, signal: AbortSignal.timeout(6000) }).then(r => r.json());
    if (d.code || d.msg) { doubanBlocked = true; return undefined; }   // need_login 之类：被限流了，这次不再查
    const m = (d.items || []).map(it => it.target || {}).find(x => x.title === name && (!year || !x.year || Math.abs(+x.year - year) <= 1));
    const v = m?.rating?.count ? { r: m.rating.value, n: m.rating.count } : null;
    fmCache['db:' + name] = { at: Date.now(), v }; writeJson(FILMMETA, fmCache);
    return v;
  } catch { return undefined; }
}
// 华语新片：翻这些官方频道最近上传的，按 360 影视的上映日期从新到旧排（只要大陆 / 香港 / 台湾的电影）
const LATEST_CHANNELS = ['@iQIYIMOVIETHEATER', '@youkumovie', '@youkumonstermovie', '@TencentVideoMovie', '@WeTVMovie', '@iQIYIEnglish', '@huaceglobal', '@8-hkmovie', '@CinemaMeiAh', '@EmperorMotionPicturesOfficial', '@MoxiMovie', '@JetsenFilm'];
async function latestMovies(LAST) {
  // 1. 各频道最近上传的前 50 部电影（并发）  2. 汇总去重  3. 查上映日期 / 地区 / 评分  4. 按上映日期倒序，核对能嵌入，取前 n 部
  const n = Math.min(+opt.n || 50, 80), per = +opt.per || 50, t0 = Date.now();
  const lists = await Promise.all(LATEST_CHANNELS.map(h => channelLatest(h, per * 2)));
  const best = new Map();
  for (const x of lists.flatMap(l => l.filter(x => x.dur >= 60 * 60 && x.dur <= 4 * 3600 && !NOT_MOVIE.test(x.title)).slice(0, per))) {
    x.src = 'youtube'; x.name = movieName(x.title);
    const k = x.name.split(/\s*[\/／]\s*|\s+(?=[A-Za-z])/)[0], o = best.get(k);
    if (!o || (x.ago ?? 9e9) < (o.ago ?? 9e9) || ((x.ago === o.ago) && (x.plays || 0) > (o.plays || 0))) best.set(k, { ...x, key: k });
  }
  const pool = [...best.values()].sort((a, b) => (a.ago ?? 9e9) - (b.ago ?? 9e9));
  if (opt.debug) console.error('频道', lists.map((l, i) => LATEST_CHANNELS[i] + ':' + l.length).join(' '), '去重后', pool.length, (Date.now() - t0) + 'ms');
  // 去重后的每部都查上映日期（360 影视，25 个并发；存盘 30 天，第二次起几乎不用查），没有日期的（片名认不出、剧集剪辑）不要
  for (let i = 0; i < pool.length; i += 25) await Promise.all(pool.slice(i, i + 25).map(async x => { x.db = await kan360(x.key); }));
  const dated = pool.filter(x => x.db?.date && !x.db.tv && /大陆|内地|香港|台湾/.test(x.db.area || '') && (!+opt.min || x.db.rating >= +opt.min))
    .sort((a, b) => b.db.date.localeCompare(a.db.date) || (a.ago ?? 9e9) - (b.ago ?? 9e9));
  if (opt.debug) console.error('有上映日期的', dated.length, (Date.now() - t0) + 'ms');
  // 按上映日期从新到旧核对能不能嵌入播放，够 n 部就停
  const yt = SOURCES.find(s => s.id === 'youtube'), ectx = { get: (u, o) => http(u, o) }, items = [];
  for (let i = 0; i < dated.length && items.length < n; i += 25) {
    const part = dated.slice(i, i + 25), ok = await Promise.all(part.map(x => yt.embed(x, ectx)));
    if (opt.debug) part.forEach((x, j) => ok[j] || console.error('不能嵌入', x.key, x.page, x.channel));
    items.push(...part.filter((_, j) => ok[j]));
  }
  items.length = Math.min(items.length, n);
  if (!items.length) die('没找到能直接播放的华语新片', 2);
  const when = x => x.db?.date || (x.db?.year ? x.db.year + '' : '');
  items.sort((a, b) => when(b).localeCompare(when(a)) || (a.ago ?? 9e9) - (b.ago ?? 9e9));
  writeJson(LAST, { q: '华语新片', at: Date.now(), items });
  if (opt.debug) console.error('用时', (Date.now() - t0) + 'ms');
  console.log('序号\t片名\t上映\t地区\t类型\t豆瓣\t时长\t播放\t官方频道');
  const ml = x => `[${x.key.replace(/[\[\]]/g, ' ')}](${x.page})`;   // 片名就是播放链接：claclaw 里点了在顶上的播放器播，列表留着随时换
  items.forEach((x, i) => console.log([i + 1, ml(x), when(x) || '?', x.db?.area || '?', x.db?.genres || '', x.db?.rating || '暂无', fmtDur(x.dur), fmtPlays(x.plays), (x.channel || '').replace(/\s*-\s*Get .*$/i, '')].join('\t')));
}
async function movies(q) {
  const LAST = path.join(STATE, 'movies-last.json');
  if (opt.pick) {
    const last = readJson(LAST, null), x = last?.items?.[+opt.pick - 1];
    if (!x) die('没有第 ' + opt.pick + ' 部（先搜片单）');
    // stdout：Markdown 链接 \t 时长 \t 播放 \t 频道 \t 豆瓣。回复里原样贴 Markdown 链接，claclaw 在消息下面放播放卡片
    console.log([`[${x.name}](${x.page})`, fmtDur(x.dur), fmtPlays(x.plays), x.channel, x.db?.rating ? '豆瓣 ' + x.db.rating : x.db?.imdb ? 'IMDb ' + x.db.imdb : x.db?.my ? '猫眼 ' + x.db.my : ''].join('\t'));
    return;
  }
  if (!(await proxy())) die('找官方电影要能上 YouTube（没找到代理：设 HTTPS_PROXY 或 --proxy）');
  if (opt.latest) return latestMovies(LAST);
  const yt = SOURCES.find(s => s.id === 'youtube'), ctx = { get: (u, o) => http(u, { timeout: 12000, ...o }) };
  const year = +opt.year || 0, minRate = +opt.min || 0, fresh = !!(opt.new || year);
  const base = q || '华语';
  const variants = [base + ' 电影 完整版', base + ' full movie', base + ' 电影 Full Movie Multi Sub'];
  const got = (await Promise.all([
    ...variants.map(v => yt.search(v, ctx).catch(() => [])),
    ...(fresh ? MOVIE_CHANNELS.map(h => channelLatest(h)) : []),   // 新片：官方频道最近上传的
    dmMovies(q, fresh), archiveMovies(q), nfbMovies(q),                // 其他能嵌入播放的：Dailymotion 官方账号、Archive 公版片、NFB 片库
    ...THEME_CHANNELS.filter(([re]) => re.test(q)).flatMap(([, hs]) => hs.map(h => channelLatest(h, 60).then(l => l.map(x => ({ ...x, rel: true }))))),   // 小片库频道整个翻
  ])).flat().map(x => ({ src: 'youtube', ...x }));
  const toks = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const seen = new Set(), list = [];
  for (const x of got) {
    if (seen.has(x.page)) continue; seen.add(x.page);
    if (!x.dur || x.dur < 60 * 60 || x.dur > 4 * 3600) continue;             // 完整电影：1～4 小时
    if (!(x.official || x.verified || OFFICIAL.test(x.channel || ''))) continue;          // 只要官方频道
    if (NOT_MOVIE.test(x.title)) continue;
    const t = x.title.toLowerCase();
    const sc = (toks.length ? x.rel ? 1 : toks.filter(k => t.includes(k)).length / toks.length * 2 : 0)   // rel：按中文类型词换成英文搜到的，标题里没有中文词，算半贴题 + (x.plays ? Math.min(1, Math.log10(1 + x.plays) / 7) : 0) + (x.official || OFFICIAL.test(x.channel || '') ? 0.3 : 0);
    const ty = +(/[(（](19[5-9]\d|20[0-4]\d)[)）]/.exec(x.title)?.[1]) || undefined;   // 标题里的（2019）
    list.push({ ...x, name: movieName(x.title), sc, ...(ty && !x.db ? { db: { year: ty } } : {}) });
  }
  list.sort((a, b) => b.sc - a.sc);
  // 同一部片在几个官方频道（各语种频道）都有：片名一样、或时长差不到 8 秒的，只留排在前面的（播放多的）
  const key = x => /^[^A-Za-z]*[一-鿿]/.test(x.name) ? x.name.split(/\s*[\/／]\s*|\s+(?=[A-Za-z])/)[0] : x.name;   // 中文片名去掉后面的英文名
  for (let i = list.length - 1; i > 0; i--) if (list.slice(0, i).some(y => Math.abs(y.dur - list[i].dur) <= 8 || (key(y) === key(list[i]) && Math.abs(y.dur - list[i].dur) < 180))) list.splice(i, 1);
  // 查猫眼：年份、类型；剧集剪成的「电影版」去掉。按年份 / 评分筛时多查一些
  const n = Math.min(+opt.n || 10, 20);
  const pool = list.slice(0, year || minRate ? 120 : n + 8);
  // 猫眼并发多了会回验证页：两个一批，英文片名（猫眼查不到）跳过
  const cjkPool = pool.filter(x => x.src !== 'archive' && x.src !== 'nfb' && /[一-鿿]/.test(key(x)));
  for (let i = 0; i < cjkPool.length; i += 2) { await Promise.all(cjkPool.slice(i, i + 2).map(async x => { x.db = (await kan360(key(x))) || await maoyan(key(x)); })); await new Promise(z => setTimeout(z, 150)); }
  if (opt.debug) for (const x of pool) console.error(x.db ? (x.db.tv ? 'TV' : x.db.year + ' ' + x.db.type) : 'null', x.name);
  let cand = pool.filter(x => !x.db?.tv);
  if (year) cand = cand.filter(x => x.db?.year === year);
  // 豆瓣评分：按排名一个一个查（间隔一点，被拦就停），有评分的按评分加权（评分人数少的打折）
  const since = +opt.since || 0;
  for (const x of cand.slice(0, since || minRate ? 60 : n + 6)) {   // 按评分 / 年份筛时多查一些
    if ((x.src === 'archive' || x.src === 'nfb') && !since) continue;   // 公版老片、NFB 片库豆瓣多半没有，不浪费查询额度
    if (!/[一-鿿]/.test(key(x))) {   // 外文片名：查 IMDb
      const im = await imdbRate(key(x), x.db?.year);
      if (im) { x.db = { ...(x.db || {}), imdb: im.r, year: x.db?.year || im.year, genres: x.db?.genres || im.genres }; x.sc += (im.r - 6) * 0.4; }
      continue;
    }
    const r = await doubanRate(key(x), x.db?.year);
    if (r) { x.db = { ...(x.db || {}), rating: r.r, votes: r.n, year: x.db?.year || r.year }; x.sc += (r.r - 6) * 0.5 * Math.min(1, Math.log10(1 + r.n) / 3); }
    if (r === undefined) continue;
    await new Promise(z => setTimeout(z, doubanBlocked ? 250 : 400));
  }
  if (since) cand = cand.filter(x => x.db?.year >= since);   // --since 2006：这一年以后上映的（年份查不到的去掉）
  if (minRate) cand = cand.filter(x => (x.db?.rating || x.db?.imdb || x.db?.my || 0) >= minRate);
  // 关键词是类型（爱情 / 喜剧…）时，查到类型的片子要对得上
  const GENRE = { 爱情: /爱情|romance/i, romance: /爱情|romance/i, romantic: /爱情|romance/i, 喜剧: /喜剧|comedy/i, comedy: /喜剧|comedy/i, 恐怖: /恐怖|horror/i, horror: /恐怖|horror/i, 科幻: /科幻|sci-fi|science/i, 动作: /动作|action/i, action: /动作|action/i, 悬疑: /悬疑|mystery|thriller/i, 动画: /动画|animation/i };
  const gre = toks.map(k => GENRE[k]).filter(Boolean);
  if (gre.length) cand = cand.filter(x => !x.db?.genres || gre.some(g => g.test(x.db.genres)));
  cand.sort((a, b) => b.sc - a.sc);
  const ectx = { get: (u, o) => http(u, o) };
  const head = cand.slice(0, n + 6);
  const ok = await Promise.all(head.map(x => x.src === 'youtube' ? yt.embed(x, ectx) : true));   // Dailymotion 搜的时候已按 allow_embed 筛过；Archive 都能嵌
  const items = head.filter((_, i) => ok[i]).slice(0, n);
  if (!items.length) die('没找到官方频道能直接播放的完整电影' + (year ? `（${year} 年的）` : '') + (minRate ? `（豆瓣 ${minRate} 分以上）` : '') + '：换个类型 / 片名 / 演员，或放宽条件', 2);
  writeJson(LAST, { q, at: Date.now(), items });
  // 片单里片名就是播放链接（claclaw 点了在聊天顶上的播放器里播，不跳走；列表留着随时换）；--pick 序号 也还能单独拿一部
  console.log('序号\t片名\t豆瓣\t年份\t类型\t时长\t播放\t官方频道\t原标题');   // 豆瓣「暂无」= 没评分或这次没查到（限流）
  items.forEach((x, i) => console.log([i + 1, `[${x.name.replace(/[\[\]]/g, ' ')}](${x.page})`, x.db?.rating ? x.db.rating + (x.db.votes < 100 ? '（' + x.db.votes + '人评）' : '') : x.db?.imdb ? 'IMDb ' + x.db.imdb : x.db?.my ? '猫眼 ' + x.db.my : '暂无', x.db?.year || '?', [x.db?.type, x.db?.genres].filter(Boolean).join(' '), fmtDur(x.dur), fmtPlays(x.plays), (x.channel || '').replace(/\s*-\s*Get .*$/i, ''), x.title].join('\t')));
}

// ---------- 相关推荐（claclaw 播放器里的「相关」：B 站 / YouTube 正在播的这个视频的相关视频，点了在 claclaw 里接着播） ----------
async function related(u) {
  let m, out = [];
  if ((m = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/.exec(u))) {
    const j = JSON.parse(await http('https://api.bilibili.com/x/web-interface/archive/related?bvid=' + m[1], { timeout: 8000, referer: 'https://www.bilibili.com/' }));
    out = (j.data || []).filter(x => x.bvid && x.title && !(x.state < 0) && !/视频已失效/.test(x.title)).map(x => ({ url: 'https://www.bilibili.com/video/' + x.bvid, title: x.title, dur: x.duration || 0, by: x.owner?.name || '', plays: x.stat?.view,
      pic: x.pic ? x.pic.replace(/^http:/, 'https:') + '@320w_180h_1c.jpg' : '' }));
  } else if ((m = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(u))) {
    const d = JSON.parse(await http('https://www.youtube.com/youtubei/v1/next?prettyPrint=false', { proxy: true, timeout: 12000,
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: '2.20261116.00.00', hl: 'zh-CN', gl: 'HK' } }, videoId: m[1] }) }));
    for (const l of walk(d, 'lockupViewModel')) {
      if (l.contentType !== 'LOCKUP_CONTENT_TYPE_VIDEO' || !l.contentId) continue;
      const md = l.metadata?.lockupMetadataViewModel, js = JSON.stringify(l);
      const dur = /"text":"(\d+(?::\d\d){1,2})"/.exec(js)?.[1];
      if (!dur || /BADGE_MEMBERS_ONLY|UPCOMING|首播/.test(js)) continue;   // 直播、会员专享、首播不要
      const parts = (md?.metadata?.contentMetadataViewModel?.metadataRows || []).map(r => (r.metadataParts || []).map(p => p.text?.content || ''));
      out.push({ url: 'https://www.youtube.com/watch?v=' + l.contentId, title: md?.title?.content || '', dur: dur.split(':').reduce((a, x) => a * 60 + +x, 0),
        by: parts[0]?.[0] || '', plays: num((parts[1] || [])[0]), pic: 'https://i.ytimg.com/vi/' + l.contentId + '/mqdefault.jpg' });
    }
    // 关了嵌入的（在 claclaw 里放不了）去掉
    const yt = SOURCES.find(s => s.id === 'youtube'), ectx = { get: (u, o) => http(u, o) };
    const ok = await Promise.all(out.map(x => yt.embed({ page: x.url }, ectx).catch(() => true)));
    out = out.filter((_, i) => ok[i]);
  } else die('只支持 B 站、YouTube 视频网址');
  out = out.slice(0, +opt.n || 20);
  if (opt.json) console.log(JSON.stringify(out));
  else out.forEach((x, i) => console.log([i + 1, `[${x.title.replace(/[\[\]]/g, ' ')}](${x.url})`, fmtDur(x.dur), fmtPlays(x.plays), x.by].join('\t')));
}

// ---------- 投屏：把视频网页换成电视能播的流（claclaw 服务器调，输出 JSON） ----------
// 电视（DLNA）不会解析网页，也多半上不了 YouTube：这里找出真正的视频地址，由 claclaw 在局域网里转发给电视（src/cast/）。
//   YouTube：音频、视频是分开的两路 HLS（分段一一对齐），kind=yt，由 claclaw 按段合成一路 TS；
//           mp4 直链（18 号格式）不行：不带 PO token 只给开头一两 MB
//   Dailymotion：音画合一的 HLS，kind=hls；Archive：mp4 直链，kind=file
// 视频地址绑定了取地址时的出口 IP，所以把用的代理也带上，转发时走同一个
async function stream(u) {
  const px = await proxy();
  const yt = /(?:youtube\.com\/(?:watch\?(?:[^#\s]*&)?v=|shorts\/|live\/|embed\/)|youtu\.be\/)([\w-]{11})/.test(u);
  if (/nfb\.ca|onf\.ca/.test(u)) die('NFB 的片子暂时投不了屏');
  if ((yt || /dailymotion\.com|dai\.ly/.test(u)) && !px) die('要能上 YouTube / Dailymotion 才能投屏（没找到代理）');
  const j = JSON.parse(await ytdlp(['-J', '--no-playlist', u], { proxy: !!px, timeout: 60000 }));
  const fs_ = j.formats || [], maxH = +opt.height || 1080;
  const base = { title: j.title || '', dur: Math.round(j.duration || 0), page: u, proxy: px || '' };
  const hls = f => /^m3u8/.test(f.protocol || '');
  let out;
  if (yt) {
    const vs = fs_.filter(f => hls(f) && /^avc1/.test(f.vcodec || '') && (!f.acodec || f.acodec === 'none') && f.height && f.height <= maxH).sort((a, b) => a.height - b.height || (a.tbr || 0) - (b.tbr || 0));
    const as = fs_.filter(f => hls(f) && f.vcodec === 'none');
    const a = as.find(f => f.format_id === '234') || as.find(f => /^mp4a\.40\.2/.test(f.acodec || '')) || as.at(-1);
    const v = vs.at(-1);
    if (!v || !a) die('这个视频没有能投屏的格式');
    out = { kind: 'yt', video: v.url, audio: a.url, height: v.height };
  } else {
    const both = fs_.filter(f => f.vcodec !== 'none' && f.acodec !== 'none' && (!f.height || f.height <= maxH) && (hls(f) || /^https?$/.test(f.protocol || '') && /mp4|m4v|mov/.test(f.ext || '')));
    both.sort((a, b) => (a.height || 0) - (b.height || 0) || (a.tbr || 0) - (b.tbr || 0));
    const f = both.at(-1) || (j.url && { url: j.url, protocol: j.protocol, ext: j.ext, height: j.height });
    if (!f) die('这个视频没有能投屏的格式');
    out = hls(f) ? { kind: 'hls', url: f.url, height: f.height || 0 } : { kind: 'file', url: f.url, mime: f.ext === 'mov' ? 'video/quicktime' : 'video/mp4', height: f.height || 0 };
  }
  console.log(JSON.stringify({ ...base, ...out }));
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
} else if (cmd === 'movies') {
  await movies(pos.join(' ').trim());
} else if (cmd === 'related' && pos[0]) {
  await related(pos[0]);
} else if (cmd === 'stream' && pos[0]) {
  await stream(pos[0]);
} else if (cmd === 'link' && KINDS[kind] && arg) {
  await link(kind, arg);
} else if ((cmd === 'find' || cmd === 'get') && KINDS[kind] && arg) {
  if (cmd === 'find') {
    const items = await find(kind, arg, { n: +opt.n || 10, max: +opt.max || 0, src: opt.src });
    if (!items.length) die('没找到（换个关键词、放宽 --max，或 --src 换来源）', 2);
    console.log(kind === 'image' ? '序号\t来源\t尺寸\t标题\t地址' : '序号\t来源\t时长\t播放\t标题\t网址');
    items.slice(0, Math.max(+opt.n || 10, 1)).forEach((x, i) => console.log(kind === 'image'
      ? [i + 1, label(x.src), x.w && x.h ? x.w + 'x' + x.h : '?', x.title, x.page || x.file].join('\t')
      : [i + 1, label(x.src), fmtDur(x.dur), fmtPlays(x.plays), x.title, x.page || x.file].join('\t')));
  } else await get(kind, arg);
} else die(USAGE);
process.exit(0);   // 不等还没回来的慢来源
