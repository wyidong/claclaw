#!/usr/bin/env node
// claw-music：听歌，只要声音（纯音频，不带 MV 画面）。用法见 SKILL.md。
// 来源（并发查）：
//   ne        网易云免费歌：官方外链 mp3（VIP 歌外链打不开，不收）
//   bili      B 站视频的单独音轨（官方 MV、CD 音轨上传）：不登录最高 320kbps AAC，claclaw 服务器转给手机，只放声音
//   openverse CC 授权音乐（Jamendo、Freesound、ccMixter…），mp3 直链（要出墙）
//   archive   Internet Archive 公版音乐 / 老唱片，mp3 直链（要出墙）
// 输出的链接：网易云是外链地址、B 站是视频网址后面加 #audio，claclaw 认得这两种，点了只放声音；别处打开也能听 / 看。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { SOURCES } from '../_lib/media/sources.mjs';
import { audSource } from '../../src/audproxy.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const STATE = path.join(process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw'), 'music');
const USAGE = `用法：
  claw-music "歌名 歌手" [--n 1]          纯音频链接（聊天里直接放，只有声音）
  claw-music find "歌名 歌手" [--n 10]    候选列表（换个版本时）
  claw-music get "歌名 歌手" [--pick 序号]  下载成音频文件（mp3 / m4a）
选项：--src ne,bili,openverse,archive  只用这些来源；--proxy URL；--json`;

// ---------- 参数 ----------
const argv = process.argv.slice(2), opt = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const m = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
  if (!m) pos.push(argv[i]);
  else if (m[2] !== undefined) opt[m[1]] = m[2];
  else if (argv[i + 1] === undefined || argv[i + 1].startsWith('--')) opt[m[1]] = true;
  else opt[m[1]] = argv[++i];
}
const die = (s, code = 1) => { console.error(s); process.exit(code); };
const sub = ['find', 'get'].includes(pos[0]) ? pos.shift() : '';
const query = pos.join(' ').trim();
if (!query && !(sub === 'get' && opt.pick)) die(USAGE);
const want = opt.src ? String(opt.src).split(',') : ['ne', 'bili', 'openverse', 'archive'];

// ---------- 网络 ----------
const portOpen = port => new Promise(ok => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); s.setTimeout(400, () => { s.destroy(); ok(false); }); });
let proxyP;
const proxy = () => proxyP ||= (async () => {
  if (opt.proxy) return opt.proxy === true ? '' : opt.proxy;
  const e = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (e) return e;
  for (const p of [7890, 7897]) if (await portOpen(p)) return 'http://127.0.0.1:' + p;
  return '';
})();
async function get(url, { viaProxy = false, referer, timeout = 8000 } = {}) {
  const px = viaProxy ? await proxy() : '';
  if (viaProxy && !px) throw new Error('没有代理');
  if (!px) {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  return new Promise((ok, no) => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', String(Math.ceil(timeout / 1000)), '-x', px, '-A', UA, ...(referer ? ['-e', referer] : []), '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', no);
    p.on('exit', () => { const s = Buffer.concat(bufs).toString('utf8'), nl = s.lastIndexOf('\n'), code = +s.slice(nl + 1); code >= 200 && code < 300 ? ok(s.slice(0, nl)) : no(new Error('HTTP ' + (code || '超时'))); });
  });
}
const json = async (u, o) => JSON.parse(await get(u, o));
const enc = encodeURIComponent;

// ---------- 打分 ----------
// 「晴天 周杰伦」：第一个词当歌名，其余当歌手
const norm = s => String(s || '').toLowerCase().replace(/[\s·・\-—_()（）【】\[\]《》<>"'“”‘’!！?？,，.。:：|/\\]+/g, '');
const words = query.split(/\s+/).filter(Boolean), song = norm(words[0]), artist = norm(words.slice(1).join(''));
const BAD = /翻唱|cover|鼓谱|吉他|钢琴谱|教学|教程|伴奏|karaoke|dj|remix|reaction|解说|合集|串烧|混剪|片段|抖音|cut|舞蹈|翻跳|女声版|男声版|变速|倍速|加速|降调|铃声|试听|30秒|一小时|循环|纯享|demo/i;
const GOOD = /官方|official|mv|cd音轨|无损|hi-?res|flac|原唱|完整版|高音质|音质|4k|母带|lyrics|歌词/i;
const qBad = BAD.test(query);   // 用户自己要伴奏 / 现场 / DJ 版就不扣分
let refDur = 0;   // 原曲时长（网易云搜到的原唱，VIP 歌也有）：时长对得上的才是完整版
function score(x) {
  const t = norm(x.title), a = norm(x.artist || '');
  if (song && !t.includes(song)) return -1;   // 歌名对不上的不要
  let s = 40;
  if (artist) s += (t.includes(artist) || a.includes(artist)) ? 25 : -25;   // 歌手对不上多半是翻唱
  if (x.src === 'ne' && norm(x.name) === song) s += 15;
  if (!qBad && BAD.test(x.title + ' ' + (x.artist || ''))) s -= 60;
  if (GOOD.test(x.title)) s += 12;
  if (/live|现场/i.test(x.title) && !/live|现场/i.test(query)) s -= 15;
  if (x.plays) s += Math.min(25, Math.log10(x.plays + 1) * 4);
  if (x.dur && (x.dur < 90 || x.dur > 900)) s -= 40;   // 太短是片段，太长是合集
  if (refDur && x.dur) { const d = Math.abs(x.dur - refDur); s += d <= 8 ? 20 : d <= 20 ? 5 : -25; }
  s += { ne: 8, bili: 5, openverse: 0, archive: 0 }[x.src] || 0;
  return s;
}

// ---------- 来源 ----------
const SRC = {
  async ne() {
    const j = await json(`https://music.163.com/api/search/get/web?s=${enc(query)}&type=1&limit=20`, { referer: 'https://music.163.com/' });
    const all = j.result?.songs || [];
    const orig = all.find(s => norm(s.name) === song && (!artist || norm((s.artists || []).map(a => a.name).join('')).includes(artist)) && !/live|伴奏|dj/i.test(s.name));
    if (orig?.duration) refDur = Math.round(orig.duration / 1000);
    const songs = all.filter(s => s.fee === 0 || s.fee === 8);   // 1 = VIP、4 = 付费专辑：外链打不开
    const ok = await Promise.all(songs.map(s => fetch(`https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) })
      .then(r => !/\/404/.test(r.headers.get('location') || '/404')).catch(() => false)));
    return songs.filter((_, i) => ok[i]).map(s => ({ src: 'ne', name: s.name, artist: (s.artists || []).map(a => a.name).join('、'), title: s.name + ' - ' + (s.artists || []).map(a => a.name).join('、'),
      url: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, dur: Math.round((s.duration || 0) / 1000), note: '网易云 · mp3' }));
  },
  async bili() {
    const b = SOURCES.find(s => s.id === 'bili');
    const list = await b.search(query + (qBad ? '' : ''), { get: (u, o = {}) => get(u, { referer: 'https://www.bilibili.com/', ...o }) });
    return list.map(x => ({ src: 'bili', title: x.title, url: x.page + '#audio', dur: x.dur, plays: x.plays, note: 'B 站音轨 · 最高 320k' }));
  },
  async openverse() {
    const j = await json(`https://api.openverse.org/v1/audio/?q=${enc(query)}&page_size=20`, { viaProxy: true, timeout: 12000 });
    return (j.results || []).filter(r => /\.(mp3|ogg|m4a|wav|flac)(\?|$)/i.test(r.url || '')).map(r => ({ src: 'openverse', title: r.title + (r.creator ? ' - ' + r.creator : ''), artist: r.creator, url: r.url, dur: r.duration ? Math.round(r.duration / 1000) : 0,
      note: 'CC 授权（' + (r.license || '').toUpperCase() + '）· ' + (r.source || 'openverse') }));
  },
  async archive() {
    const j = await json(`https://archive.org/advancedsearch.php?q=${enc(query)}+AND+mediatype:audio&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&sort[]=downloads+desc&rows=6&output=json`, { viaProxy: true });
    const docs = j.response?.docs || [];
    const files = await Promise.all(docs.map(d => json('https://archive.org/metadata/' + d.identifier + '/files', { viaProxy: true }).catch(() => null)));
    const out = [];
    docs.forEach((d, i) => {
      const f = (files[i]?.result || []).find(f => /mp3/i.test(f.format || '') && /\.mp3$/i.test(f.name));
      if (f) out.push({ src: 'archive', title: (f.title || [].concat(d.title)[0]) + (d.creator ? ' - ' + [].concat(d.creator)[0] : ''), artist: [].concat(d.creator || '')[0], url: 'https://archive.org/download/' + d.identifier + '/' + f.name.split('/').map(enc).join('/'),
        dur: Math.round(+f.length || 0), plays: d.downloads, note: 'Internet Archive · 公版' });
    });
    return out;
  },
};

async function search() {
  const t0 = Date.now();
  const res = await Promise.all(want.filter(k => SRC[k]).map(k => Promise.race([SRC[k](), new Promise(ok => setTimeout(() => ok([]), 10000))]).catch(e => { if (opt.debug) console.error(k, e.message); return []; })));
  // B 站搜索页常常没有时长：前几个去查一下（顺便拿准确的时长），再按原曲时长打分
  let all = res.flat().map(x => ({ ...x, score: score(x) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const need = all.filter(x => x.src === 'bili').slice(0, 10);
  await Promise.all(need.map(x => json('https://api.bilibili.com/x/web-interface/view?bvid=' + /BV[0-9A-Za-z]{10}/.exec(x.url)[0], { referer: 'https://www.bilibili.com/', timeout: 5000 })
    .then(j => { if (j.code === 0) { x.dur = j.data.pages?.[0]?.duration || j.data.duration; x.plays = j.data.stat?.view || x.plays; if ((j.data.pages || []).length > 1) x.multi = 1; } }).catch(() => {})));
  all = all.map(x => ({ ...x, score: score(x) - (x.multi ? 30 : 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const seen = new Set(), items = [];
  for (const x of all) {
    const k = x.src + ':' + norm(x.title).slice(0, 30);
    if (seen.has(k)) continue; seen.add(k); items.push(x);
  }
  if (opt.debug) console.error('用时', Date.now() - t0, 'ms', '原曲', refDur, 's');
  return items;
}
const fmtDur = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '?';
const clean = s => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const lastFile = path.join(STATE, 'last.json');

if (sub === 'get') {
  let items;
  if (opt.pick && !query) items = (() => { try { return JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { return []; } })();
  else items = await search();
  const x = items[(+opt.pick || 1) - 1];
  if (!x) die('没找到能下载的（换个关键词）', 2);
  let url = x.url, referer = '', ext = 'mp3';
  if (x.src === 'bili') { const s = await audSource('bv:' + /BV[0-9A-Za-z]{10}/.exec(x.url)[0] + ':1'); url = s.url; referer = s.referer; ext = 'm4a'; }
  else if (x.src === 'ne') { const s = await audSource('ne:' + /id=(\d+)/.exec(x.url)[1]); url = s.url; }
  else ext = (/\.(\w+)(\?|$)/.exec(url)?.[1] || 'mp3').toLowerCase();
  const px = x.src === 'openverse' || x.src === 'archive' ? await proxy() : '';
  const dir = opt.out || path.join(os.tmpdir(), 'claclaw-media'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, clean(x.title).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60) + '.' + ext);
  const code = await new Promise(ok => spawn('curl', ['-sSL', '-m', '300', '-A', UA, ...(referer ? ['-e', referer] : []), ...(px ? ['-x', px] : []), '-o', file, '-w', '%{http_code}', url]).on('exit', ok));
  if (code !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 50_000) die('下载失败（换一个：--pick 2）');
  console.log([file, (fs.statSync(file).size / 1048576).toFixed(1) + 'MB', x.note, fmtDur(x.dur), x.title].join('\t'));
} else {
  const items = await search();
  if (!items.length) die('没找到能直接放的纯音频（多半是 VIP 歌，网易云不免费、B 站也没有官方上传）：换个关键词，或用 claw-audio 找 MV 版', 2);
  fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(lastFile, JSON.stringify(items.slice(0, 20)));
  const n = Math.max(1, +opt.n || (sub === 'find' ? 10 : 1));
  const top = items.slice(0, n);
  if (opt.json) console.log(JSON.stringify(top));
  else top.forEach((x, i) => console.log((sub === 'find' ? (i + 1) + '\t' : '') + [`[${clean(x.title)}](${x.url})`, x.note, fmtDur(x.dur)].join('\t')));
}
process.exit(0);
