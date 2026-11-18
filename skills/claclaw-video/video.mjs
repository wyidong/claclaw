#!/usr/bin/env node
// claclaw-video：上网找视频、下载成手机能放的 mp4（H.264 + AAC）。用法见同目录 SKILL.md。
//   search "关键词" [--n 8] [--max 600] [--site bili|yt|all] [--proxy URL]
//   get <网址> [--out 目录] [--clip 秒] [--max-mb 45] [--proxy URL]
// 靠 yt-dlp 下载（找不到就自动下一个放到 ~/.claclaw/tools/）；B 站视频要 ffmpeg 合并音视频。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const WIN = process.platform === 'win32';
const TOOLS = path.join(process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw'), 'tools');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const argv = process.argv.slice(2);
const cmd = argv.shift();
const opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (m) opt[m[1]] = m[2] ?? argv[++i]; else pos.push(argv[i]);
}
const die = (s, code = 1) => { console.error(s); process.exit(code); };

const which = b => {
  const r = spawnSync(WIN ? 'where' : 'which', [b], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : '';
};
const portOpen = port => new Promise(ok => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); ok(true); });
  s.once('error', () => ok(false));
  s.setTimeout(800, () => { s.destroy(); ok(false); });
});
// 代理：--proxy > 环境变量 > 本机常见代理端口（Clash 7890 / 7897）。只在要出墙（YouTube、GitHub）时用
async function proxy() {
  if (opt.proxy) return opt.proxy;
  const e = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (e) return e;
  for (const p of [7890, 7897]) if (await portOpen(p)) return 'http://127.0.0.1:' + p;
  return '';
}

function run(bin, args, { quiet = true } = {}) {
  return new Promise(ok => {
    const p = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; if (!quiet) process.stderr.write(d); });
    p.on('error', e => ok({ code: -1, out, err: err + e.message }));
    p.on('exit', code => ok({ code, out, err }));
  });
}

async function ytdlp() {
  const local = path.join(TOOLS, WIN ? 'yt-dlp.exe' : 'yt-dlp');
  const found = which('yt-dlp') || [path.join(os.homedir(), '.local', 'bin', 'yt-dlp'), local].find(f => fs.existsSync(f));
  if (found) return found;
  // 没装：下官方单文件版（macOS 通用版 / Windows exe）
  fs.mkdirSync(TOOLS, { recursive: true });
  const name = WIN ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp_linux';
  const url = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/' + name;
  const px = await proxy();
  console.error('没找到 yt-dlp，正在下载 ' + url + (px ? '（经代理 ' + px + '）' : ''));
  const r = await run('curl', ['-fsSL', '--max-time', '180', ...(px ? ['-x', px] : []), '-o', local + '.part', url]);
  if (r.code !== 0) die('yt-dlp 下载失败：' + r.err.trim() + '\n可以自己装：brew install yt-dlp / pip install yt-dlp / winget install yt-dlp');
  fs.renameSync(local + '.part', local);
  if (!WIN) fs.chmodSync(local, 0o755);
  return local;
}

const fmtDur = s => { s = Math.round(+s || 0); if (!s) return '?'; return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// B 站：直接读搜索页 HTML 里内嵌的结果（bvid、title、play、duration）。它的搜索接口要登录态 cookie，yt-dlp 的 bilisearch 常报 412；
// 页面上的时长筛选参数服务端不认，所以多取几页、自己按时长过滤
async function searchBili(q, n, max) {
  const out = [], seen = new Set();
  const re = /bvid:"(BV[0-9A-Za-z]{10})",title:"((?:[^"\\]|\\.)*)"((?:(?!bvid:)[\s\S]){0,1500}?)duration:(?:"(\d+(?::\d+){1,2})"|[A-Za-z_$][\w$]*)/g;
  for (let page = 1; page <= 3 && out.length < n; page++) {
    const html = await fetch('https://search.bilibili.com/video?keyword=' + encodeURIComponent(q) + (page > 1 ? '&page=' + page : ''), { headers: { 'user-agent': UA } }).then(r => r.text()).catch(() => '');
    re.lastIndex = 0;
    for (let m; (m = re.exec(html)) && out.length < n;) {
      if (seen.has(m[1])) continue; seen.add(m[1]);
      const dur = m[4] ? m[4].split(':').reduce((a, x) => a * 60 + +x, 0) : 0;   // 时长是压缩后的变量引用时取不到，记 0（不按时长过滤）
      if (dur > max) continue;
      let title = m[2]; try { title = JSON.parse('"' + title + '"'); } catch {}
      title = title.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      const plays = /(?:^|,)play:(\d+)/.exec(m[3])?.[1];
      out.push({ site: 'bili', dur, title, plays: plays ? +plays : undefined, url: 'https://www.bilibili.com/video/' + m[1] });
    }
  }
  return out;
}
async function searchYt(q, n) {
  const yt = await ytdlp(), px = await proxy();
  const r = await run(yt, ['--no-warnings', '--flat-playlist', '--socket-timeout', '15', ...(px ? ['--proxy', px] : []), '--print', '%(duration)s\t%(title)s\t%(id)s', `ytsearch${n}:${q}`]);
  return r.out.trim().split('\n').filter(Boolean).map(l => { const [d, t, id] = l.split('\t'); return { site: 'yt', dur: +d || 0, title: t, url: 'https://www.youtube.com/watch?v=' + id }; });
}

async function search() {
  const q = pos.join(' ').trim();
  if (!q) die('用法：claclaw-video search "关键词" [--n 8] [--max 600] [--site bili|yt|all]');
  const n = Math.min(+opt.n || 8, 20), max = +opt.max || 600, site = opt.site || 'all';
  const jobs = [];
  if (site !== 'yt') jobs.push(searchBili(q, n, max).catch(() => []));
  if (site !== 'bili') jobs.push(searchYt(q, n).catch(() => []));
  const all = (await Promise.all(jobs)).flat().filter(v => !v.dur || v.dur <= max);
  if (!all.length) die('没搜到（时长上限 ' + max + ' 秒；可以换关键词、放宽 --max，或 --site 换来源）');
  const fmtPlays = p => p == null ? '-' : p >= 10000 ? (p / 10000).toFixed(1) + '万' : String(p);
  console.log('序号\t来源\t时长\t播放\t标题\t网址');
  all.forEach((v, i) => console.log(`${i + 1}\t${v.site}\t${fmtDur(v.dur)}\t${fmtPlays(v.plays)}\t${v.title}\t${v.url}`));
}

async function get() {
  const url = pos[0];
  if (!/^https?:\/\//.test(url || '')) die('用法：claclaw-video get <网址> [--out 目录] [--clip 秒] [--max-mb 45]');
  const out = opt.out || path.join(os.tmpdir(), 'claclaw-video');
  fs.mkdirSync(out, { recursive: true });
  const yt = await ytdlp();
  const px = /bilibili\.com|b23\.tv/.test(url) ? '' : await proxy();
  if (!which('ffmpeg')) console.error('提示：没找到 ffmpeg，B 站等音视频分开的网站可能下不了；装一个：brew install ffmpeg / winget install ffmpeg');
  const maxMb = +opt['max-mb'] || 45;
  // 手机都能放：优先 H.264（avc）+ AAC 的 mp4，720p 以内；不行再退到任意格式
  // 截一段时只下那一段（--download-sections，要 ffmpeg），不用管整片大小；
  // 否则按大小挑：720p → 480p → 360p 里第一个估计不超过上限的（大小未知的也算），省得下完再慢慢转码
  const clip = +opt.clip || 0, budget = Math.max(5, maxMb - 6);
  const avc = h => `bv*[vcodec^=avc][height<=${h}]` + (clip ? '' : `[filesize_approx<=?${budget}M]`);
  const fmt = [720, 480, 360].map(h => `${avc(h)}+ba[acodec^=mp4a]/${avc(h)}+ba`).join('/') + '/b[vcodec^=avc][height<=720]/bv*[height<=480]+ba/b';
  const r = await run(yt, ['--no-warnings', '--no-playlist', '--socket-timeout', '20', ...(px ? ['--proxy', px] : []),
    ...(clip ? ['--download-sections', '*0-' + clip] : []), '-f', fmt, '--merge-output-format', 'mp4', '-o', path.join(out, '%(title).60B.%(ext)s'), '--print', 'after_move:filepath', url], { quiet: false });
  let file = r.out.trim().split('\n').pop();
  if (r.code !== 0 || !file || !fs.existsSync(file)) die('下载失败：' + r.err.trim().split('\n').slice(-3).join('\n'));
  const ff = which('ffmpeg');
  // 截取前 N 秒 / 太大或不是 H.264：用 ffmpeg 转一遍
  const probe = ff ? spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout?.trim() : 'h264';
  const size = fs.statSync(file).size / 1048576;
  if (ff && (size > maxMb || (probe && probe !== 'h264') || !/\.mp4$/i.test(file))) {
    const dur = +spawnSync(ff.replace(/ffmpeg(\.exe)?$/, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], { encoding: 'utf8' }).stdout || 0;
    const secs = clip ? Math.min(clip, dur || clip) : dur;
    // 码率按大小上限算（留 10% 余量，音频 96k）
    const vk = secs ? Math.max(200, Math.floor((maxMb * 8192 * 0.9) / secs) - 96) : 1500;
    const dst = file.replace(/\.[^.]+$/, '') + (clip ? `.前${clip}秒` : '') + '.m.mp4';
    const args = ['-y', '-v', 'error', '-i', file, ...(clip ? ['-t', String(clip)] : []), '-c:v', 'libx264', '-preset', 'veryfast', '-b:v', Math.min(vk, 2500) + 'k', '-maxrate', Math.min(vk, 2500) * 1.5 + 'k', '-bufsize', Math.min(vk, 2500) * 2 + 'k',
      '-vf', 'scale=-2:min(720\\,ih)', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', dst];
    const c = await run(ff, args);
    if (c.code !== 0) die('转码失败：' + c.err.trim().split('\n').slice(-2).join('\n'));
    fs.rmSync(file, { force: true });
    file = dst;
  }
  const mb = fs.statSync(file).size / 1048576;
  console.log(file);
  console.error(`${mb.toFixed(1)}MB` + (mb > 50 ? '（超过 50MB，send_file 发不了：加 --clip 截一段，或调小 --max-mb）' : ''));
}

if (cmd === 'search') await search();
else if (cmd === 'get') await get();
else die('用法：\n  claclaw-video search "关键词" [--n 8] [--max 600] [--site bili|yt|all]\n  claclaw-video get <网址> [--out 目录] [--clip 秒] [--max-mb 45]');
