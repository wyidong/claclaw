#!/usr/bin/env node
// claw-music：听歌，只要声音（纯音频，不带 MV 画面）。用法见 SKILL.md。
// 来源（并发查）：
//   ne        网易云免费歌：官方外链 mp3（VIP 歌外链打不开，不收）
//   bili      B 站视频的单独音轨（官方 MV、CD 音轨上传）：不登录最高 320kbps AAC，claclaw 服务器转给手机，只放声音
//   openverse CC 授权音乐（Jamendo、Freesound、ccMixter…），mp3 直链（要出墙）
//   archive   Internet Archive 公版音乐 / 老唱片，mp3 直链（要出墙）
//   kw        酷我：只收它标了免费的（会员、付费、单曲付费、只能听片段的都不要），128k mp3
//   fs        5sing：原创 / 翻唱 / 伴奏（古风、原创圈子多），最高 320k mp3
//   bc        Bandcamp：音乐人开放的免费试听（全曲 128k，独立音乐多，要出墙）
//   inc       Incompetech（Kevin MacLeod 的 1400 多首配乐，CC BY），曲目表缓存一周
// 相声 / 评书 / 有声书 / 播客这类（节目模式）：
//   nedj      网易云免费电台的节目（付费电台不要），走网易云外链
// 国风 / 纯音乐 / 古筝二胡这类「按风格找」的关键词（风格模式）另外查：
//   nepl      网易云高播放的风格歌单里的免费歌（歌单不登录只给 10 首，按歌曲 ID 再批量查）
//   fsm       Free-Stock-Music 中国风分类（CC BY，320k mp3，要带来源页，claclaw 服务器转）
//   ccmixter  ccMixter（CC 授权的独立音乐，mp3 要带来源页，服务器转）
// 输出的链接：网易云是外链地址、B 站是视频网址后面加 #audio、5sing / 酷我是歌曲页、Bandcamp 是曲目页加 #audio、CC 站是 mp3 直链，
// claclaw 认得这些（都由服务器 /api/aud 转），点了只放声音；别处打开也能听 / 看。
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
选项：--src ne,nepl,nedj,kw,fs,bili,bc,inc,fsm,ccmixter,openverse,archive  只用这些来源；--proxy URL；--json；--song 强制按「歌名 歌手」找
关键词是风格（国风、古风、纯音乐、古筝、二胡…）时自动按风格找，是节目（相声、评书、有声书…）时找节目，默认给 5 首`;

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
// 风格模式：「国风 纯音乐」「古筝」「兰亭序 古筝」——不按歌名歌手对，按风格 / 乐器挑，给几首不同的
const GENRE_RE = /国风|古风|中国风|纯音乐|轻音乐|民乐|器乐|独奏|古筝|二胡|琵琶|竹笛|笛子|笛箫|箫|古琴|扬琴|葫芦丝|唢呐|编钟|instrumental|guzheng|erhu|pipa|guqin|dizi/gi;
const INSTR = { 古筝: 'guzheng', 二胡: 'erhu', 琵琶: 'pipa', 古琴: 'guqin', 竹笛: 'dizi', 笛子: 'dizi', 笛箫: 'dizi', 箫: 'xiao', 扬琴: 'yangqin', 葫芦丝: 'hulusi', 唢呐: 'suona', 编钟: 'bianzhong' };
// 节目模式：「郭德纲 相声」「三体 有声书」「单田芳 评书」——节目一集几十分钟，按人名 / 书名对，不按歌名歌手
const TALK_RE = /相声|评书|小品|有声书|有声小说|广播剧|播客|脱口秀|单口|对口|鬼故事|讲故事|讲座|朗读|评弹|快板|戏曲|京剧|越剧|黄梅戏|昆曲|豫剧|粤剧/g;
const talk = !opt.song && new RegExp(TALK_RE.source).test(query);
const genreTerms = query.match(GENRE_RE) || [];
const genre = genreTerms.length > 0 && !opt.song && !talk;
const instr = [...new Set(genreTerms.map(w => INSTR[w] || (Object.values(INSTR).includes(w.toLowerCase()) ? w.toLowerCase() : '')).filter(Boolean))];
const enQuery = instr.length ? instr.join(' ') : 'chinese traditional';
const want = opt.src ? String(opt.src).split(',')
  : talk ? ['nedj', 'kw', 'bili', 'ne']
  : genre ? ['ne', 'nepl', 'kw', 'fs', 'bili', 'fsm', 'ccmixter', 'inc', 'bc', 'openverse', 'archive']
  : ['ne', 'kw', 'fs', 'bili', 'bc', 'inc', 'openverse', 'archive'];

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
// curl: true = 用 curl 取（ccMixter 的响应头太长，Node 的 fetch 直接报错）
async function get(url, { viaProxy = false, referer, timeout = 8000, curl = false, body } = {}) {
  const px = viaProxy ? await proxy() : '';
  if (viaProxy && !px) throw new Error('没有代理');
  if (!px && !curl && !body) {
    const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'zh-CN,zh;q=0.9', ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(timeout) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }
  return new Promise((ok, no) => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', String(Math.ceil(timeout / 1000)), ...(px ? ['-x', px] : []), '-A', UA, ...(referer ? ['-e', referer] : []), ...(body ? ['-H', 'content-type: application/json', '--data-binary', body] : []), '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', no);
    p.on('exit', () => { const s = Buffer.concat(bufs).toString('utf8'), nl = s.lastIndexOf('\n'), code = +s.slice(nl + 1); code >= 200 && code < 300 ? ok(s.slice(0, nl)) : no(new Error('HTTP ' + (code || '超时'))); });
  });
}
const json = async (u, o) => JSON.parse(await get(u, o));
const enc = encodeURIComponent;
const ent = s => String(s || '').replace(/<[^>]+>/g, '').replace(/\\+u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\/g, '').replace(/&nbsp;/g, ' ').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
// 酷我搜索回的是单引号的「类 JSON」：自己把单引号字符串转成 JSON 字符串再解析（不 eval 远端内容）
function pyjson(src) {
  let o = '', i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c !== "'") { o += c; i++; continue; }
    let t = ''; i++;
    while (i < src.length && src[i] !== "'") {
      if (src[i] === '\\') { t += src[i + 1] === "'" ? "'" : src[i] + (src[i + 1] ?? ''); i += 2; continue; }
      t += src[i] === '"' ? '\\"' : src[i] < ' ' ? ' ' : src[i]; i++;
    }
    o += '"' + t + '"'; i++;
  }
  return JSON.parse(o);
}

// ---------- 打分 ----------
// 「晴天 周杰伦」：第一个词当歌名，其余当歌手
const norm = s => String(s || '').toLowerCase().replace(/[\s·・\-—_()（）【】\[\]《》<>"'“”‘’!！?？,，.。:：|/\\]+/g, '');
const words = query.split(/\s+/).filter(Boolean), song = norm(words[0]), artist = norm(words.slice(1).join(''));
const BAD = /翻唱|cover|鼓谱|吉他|钢琴谱|教学|教程|伴奏|karaoke|dj|remix|reaction|解说|合集|串烧|混剪|片段|抖音|cut|舞蹈|翻跳|女声版|男声版|变速|倍速|加速|降调|铃声|试听|30秒|一小时|循环|纯享|demo/i;
const GOOD = /官方|official|mv|cd音轨|无损|hi-?res|flac|原唱|完整版|高音质|音质|4k|母带|lyrics|歌词/i;
const qBad = BAD.test(query);   // 用户自己要伴奏 / 现场 / DJ 版就不扣分
let refDur = 0;   // 原曲时长（网易云搜到的原唱，VIP 歌也有）：时长对得上的才是完整版
const gRest = query.replace(GENRE_RE, ' ').split(/\s+/).map(norm).filter(Boolean);   // 「兰亭序 古筝」→ 兰亭序
const GBAD = /翻唱|cover|dj|remix|reaction|解说|合集|串烧|混剪|片段|抖音|小时|\d\s*h\b|循环|铃声|试听|教学|教程|谱|考级|练习|示范|演示|demo/i;
const SUNG = /歌词|lyrics|主题曲|演唱|歌曲|原唱|翻唱|唱/i;   // 要纯音乐时，带人声的往后放
const wantInstr = /纯音乐|器乐|独奏|轻音乐|instrumental/i.test(query) || instr.length > 0;
function genreScore(x) {
  const t = norm(x.title + ' ' + (x.tags || ''));
  if (gRest.length && !gRest.every(w => t.includes(w))) return -1;
  let s = 40;
  if (instr.length) s += instr.some(e => t.includes(e) || Object.keys(INSTR).some(k => INSTR[k] === e && t.includes(k))) ? 20 : x.src === 'nepl' ? 0 : -15;
  if (/纯音乐|instrumental|独奏|器乐|轻音乐|bgm/i.test(x.title + ' ' + (x.tags || ''))) s += 8;
  if (GBAD.test(x.title)) s -= 60;
  if (/伴奏/.test(x.title) && !/伴奏/.test(query)) s -= 30;   // 歌的伴奏不算纯音乐
  if (x.src === 'fs' && /国风|古风|中国风|民乐/.test(query) && !/古风|民族|戏腔/.test(x.tags || '')) s -= 40;   // 5sing 按风格标签对
  if (x.vocal || (wantInstr && SUNG.test(x.title) && !/纯音乐|伴奏|instrumental/i.test(x.title))) s -= 25;
  if (x.dur && (x.dur < 60 || x.dur > 900)) s -= 40;
  if (x.plays) s += Math.min(10, Math.log10(x.plays + 1) * 2);
  if (/freesound/i.test(x.note)) s -= 10;   // Freesound 多是采样、音效
  s += { ne: 12, nepl: 12, kw: 8, fs: 6, bili: 0, fsm: 4, inc: 2, ccmixter: 0, openverse: 0, archive: 0, bc: -5 }[x.src] || 0;
  return s + Math.random() * 12;   // 同样的关键词每次给几首不一样的
}
const tRest = query.replace(TALK_RE, ' ').split(/\s+/).map(norm).filter(Boolean);   // 「郭德纲 相声」→ 郭德纲
function talkScore(x) {
  const t = norm(x.title + ' ' + (x.artist || '') + ' ' + (x.tags || ''));
  if (tRest.length && !tRest.every(w => t.includes(w))) return -1;
  let s = 40;
  if (new RegExp(TALK_RE.source).test(x.title + ' ' + (x.tags || ''))) s += 10;
  if (/片段|预告|广告|搜索|关注|公众|功众|上传|下架|抖音|reaction|解说|翻唱|cover|伴奏/i.test(x.title)) s -= 60;
  if (x.dur && x.dur < 120) s -= 40;
  if (x.dur > 4 * 3600) s -= 20;
  if (x.plays) s += Math.min(15, Math.log10(x.plays + 1) * 3);
  s += { nedj: 8, kw: 8, ne: 4, bili: 0 }[x.src] || 0;
  if (x.src === 'nedj') return s + Math.max(0, 12 - x.ep);   // 电台节目按集数从前往后
  return s + Math.random() * 8;
}
function score(x) {
  if (talk) return talkScore(x);
  if (genre) return genreScore(x);
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
  if (refDur && x.dur) { const d = Math.abs(x.dur - refDur); s += d <= (x.durEst ? 15 : 8) ? 20 : d <= (x.durEst ? 30 : 20) ? 5 : -25; }
  s += { ne: 8, kw: 6, bili: 5, fs: 3, openverse: 0, archive: 0 }[x.src] || 0;
  return s;
}

// ---------- 来源 ----------
const SRC = {
  async ne() {
    const j = await json(`https://music.163.com/api/search/get/web?s=${enc(query)}&type=1&limit=${genre ? 40 : 20}`, { referer: 'https://music.163.com/' });
    const all = j.result?.songs || [];
    const orig = all.find(s => norm(s.name) === song && (!artist || norm((s.artists || []).map(a => a.name).join('')).includes(artist)) && !/live|伴奏|dj/i.test(s.name));
    if (orig?.duration) refDur = Math.round(orig.duration / 1000);
    const songs = all.filter(s => s.fee === 0 || s.fee === 8);   // 1 = VIP、4 = 付费专辑：外链打不开
    const ok = await Promise.all(songs.map(s => fetch(`https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) })
      .then(r => !/\/404/.test(r.headers.get('location') || '/404')).catch(() => false)));
    return songs.filter((_, i) => ok[i]).map(s => ({ src: 'ne', name: s.name, artist: (s.artists || []).map(a => a.name).join('、'), title: s.name + ' - ' + (s.artists || []).map(a => a.name).join('、'),
      url: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, dur: Math.round((s.duration || 0) / 1000), note: '网易云 · mp3' }));
  },
  // 风格歌单：搜歌单 → 播放最多的两个 → 歌曲 ID 批量查 → 免费的随机挑 30 首验外链
  async nepl() {
    const ref = { referer: 'https://music.163.com/' };
    const j = await json(`https://music.163.com/api/search/get/web?s=${enc(query)}&type=1000&limit=6`, ref);
    const pls = (j.result?.playlists || []).sort((a, b) => (b.playCount || 0) - (a.playCount || 0)).slice(0, 2);
    const ids = (await Promise.all(pls.map(p => json(`https://music.163.com/api/v6/playlist/detail?id=${p.id}&n=1000`, ref).then(d => (d.playlist?.trackIds || []).slice(0, 150).map(x => x.id)).catch(() => []))))
      .flat().filter((x, i, a) => a.indexOf(x) === i);
    const songs = [];
    for (let i = 0; i < ids.length; i += 100) songs.push(...((await json(`https://music.163.com/api/song/detail?ids=${enc('[' + ids.slice(i, i + 100).join(',') + ']')}`, ref).catch(() => ({}))).songs || []));
    const free = songs.filter(s => s.fee === 0 || s.fee === 8).sort(() => Math.random() - 0.5).slice(0, 30);
    const ok = await Promise.all(free.map(s => fetch(`https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) })
      .then(r => !/\/404/.test(r.headers.get('location') || '/404')).catch(() => false)));
    const pl = pls.map(p => p.name).join(' / ');
    return free.filter((_, i) => ok[i]).map(s => ({ src: 'nepl', name: s.name, artist: (s.artists || []).map(a => a.name).join('、'), title: s.name + ' - ' + (s.artists || []).map(a => a.name).join('、'),
      tags: pl, url: `https://music.163.com/song/media/outer/url?id=${s.id}.mp3`, dur: Math.round((s.duration || 0) / 1000), note: '网易云 · mp3（歌单）' }));
  },
  // Free-Stock-Music：中国风分类页 + 乐器关键词搜索（站里中文歌少，只在风格模式查）
  async fsm() {
    const pages = ['https://www.free-stock-music.com/chinese.html', ...instr.map(e => 'https://www.free-stock-music.com/search.php?keyword=' + enc(e))];
    const htmls = await Promise.all(pages.map(u => get(u, { timeout: 10000 }).catch(() => '')));
    const out = [];
    for (const h of htmls) for (const b of h.split("class='mName'").slice(1)) {
      const t = /class='mTitle[^']*' title='([^']*)'/.exec(b), a = /class='mAuthor' title='([^']*)'/.exec(b), u = /<audio[^>]*?src='(\/music\/[\w-]+\/mp3\/[\w-]+\.mp3)'/.exec(b), d = /durationCont'>(\d+):(\d+)/.exec(b);
      if (t && u) out.push({ src: 'fsm', title: t[1] + (a ? ' - ' + a[1] : ''), artist: a?.[1], tags: 'chinese instrumental', url: 'https://www.free-stock-music.com' + u[1], dur: d ? +d[1] * 60 + +d[2] : 0, note: 'Free-Stock-Music · CC BY · 320k' });
    }
    return out;
  },
  // ccMixter：按标签 / 乐器搜，带人声的、采样片段排后
  async ccmixter() {
    const qs = ['tags=chinese', ...instr.map(e => 'search=' + enc(e) + '&search_type=all')];
    const lists = await Promise.all(qs.map(q => json(`https://ccmixter.org/api/query?f=json&limit=40&${q}`, { timeout: 10000, curl: true }).catch(() => [])));
    return lists.flat().map(x => {
      const f = (x.files || []).find(f => /\.mp3$/i.test(f.download_url || '')), ps = /(\d+):(\d+)/.exec(f?.file_format_info?.ps || ''), tags = x.upload_extra?.usertags || '';
      return f && { src: 'ccmixter', title: x.upload_name + ' - ' + x.user_name, artist: x.user_name, tags, url: f.download_url.replace(/\(/g, '%28').replace(/\)/g, '%29'), dur: ps ? +ps[1] * 60 + +ps[2] : 0,
        vocal: /vocal|spoken|rap/i.test(tags) && !/instrumental/i.test(x.upload_name), note: 'ccMixter · ' + (x.license_name || 'CC').replace(/\s+/g, ' ').trim() };
    }).filter(Boolean);
  },
  // 酷我：只收标了免费、能整首在线听的
  async kw() {
    const j = pyjson(await get(`http://search.kuwo.cn/r.s?all=${enc(query)}&ft=music&itemset=web_2013&client=kt&pn=0&rn=30&rformat=json&encoding=utf8`));
    const free = x => { const p = x.payInfo || {}, f = p.feeType || {}; return p.play === '0000' && p.cannotOnlinePlay === '0' && p.listen_fragment === '0' && f.vip === '0' && f.song === '0' && f.album === '0' && f.bookvip === '0'; };
    return (j.abslist || []).filter(free).map(x => {
      const name = ent(x.SONGNAME), ar = ent(x.ARTIST).replace(/&/g, '、');
      return { src: 'kw', name, artist: ar, title: name + ' - ' + ar, tags: ent(x.ALBUM), url: 'https://www.kuwo.cn/play_detail/' + /\d+/.exec(x.MUSICRID)[0], dur: +x.DURATION || 0, note: '酷我 · mp3 128k' };
    });
  },
  // 5sing：yc 原创 / fc 翻唱 / bz 伴奏；搜索结果只有文件大小，按 320k 估时长
  async fs() {
    const j = await json(`http://search.5sing.kugou.com/home/json?keyword=${enc(query)}&sort=1&page=1&filter=0&type=0`);
    const KIND = { yc: '原创', fc: '翻唱', bz: '伴奏' };
    return (j.list || []).filter(x => KIND[x.typeEname] && x.songId).slice(0, 20).map(x => {
      const name = ent(x.songName).replace(/_并轨_\w+$/, ''), ar = ent(x.singer || x.nickName);
      return { src: 'fs', name, artist: ar, title: name + (x.typeEname === 'yc' ? '' : '（' + KIND[x.typeEname] + '）') + ' - ' + ar, tags: x.style || '', url: `https://5sing.kugou.com/${x.typeEname}/${x.songId}.html`,
        dur: x.songSize ? Math.round(x.songSize / 40000) : 0, durEst: 1, plays: x.playCnt, note: '5sing ' + KIND[x.typeEname] + ' · mp3' };
    });
  },
  // 网易云电台：免费电台（radioFeeType 0）里的节目，订阅多的电台优先
  async nedj() {
    const ref = { referer: 'https://music.163.com/' };
    const j = await json(`https://music.163.com/api/search/get/web?s=${enc(query)}&type=1009&limit=10`, ref);
    const radios = (j.result?.djRadios || []).filter(r => !r.radioFeeType && !r.feeScope).sort((a, b) => (b.subCount || 0) - (a.subCount || 0)).slice(0, 3);
    const progs = (await Promise.all(radios.map(r => json(`https://music.163.com/api/dj/program/byradio?radioId=${r.id}&limit=30&asc=true`, ref).then(d => (d.programs || []).map(p => ({ p, r }))).catch(() => [])))).flat()
      .filter(({ p }) => p.mainSong?.id).slice(0, 40);   // 每个电台从第 1 集往后；免费电台的节目都能放，不再逐个验外链（网易云会限流）
    return progs.map(({ p, r }) => ({ src: 'nedj', title: p.name + ' - ' + r.name, artist: r.dj?.nickname || '', tags: r.name + ' ' + (r.category || ''),
      url: `https://music.163.com/song/media/outer/url?id=${p.mainSong.id}.mp3`, dur: Math.round((p.duration || 0) / 1000), plays: p.listenerCount, ep: p.serialNum || 0, radio: r.id, note: '网易云电台 · mp3' }));
  },
  // Bandcamp：站内搜索接口（曲目），链接是曲目页加 #audio，放的时候服务器去曲目页取试听流
  async bc() {
    const j = await json('https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic', { viaProxy: true, timeout: 10000, body: JSON.stringify({ search_text: genre ? enQuery : query, search_filter: 't', full_page: false, fan_id: null }) });
    return (j.auto?.results || []).map(x => ({ x, m: /^https:\/\/([a-z0-9-]+)\.bandcamp\.com\/track\/([a-z0-9-]+)$/.exec(x.item_url_path || '') })).filter(({ m }) => m)
      .map(({ x, m }) => ({ src: 'bc', name: x.name, artist: x.band_name, title: x.name + ' - ' + x.band_name, tags: x.album_name || '', url: m[0] + '#audio', dur: 0, note: 'Bandcamp · 试听流 128k' }));
  },
  // Incompetech：整张曲目表（名字、乐器、风格、描述）缓存一周，本地按词筛
  async inc() {
    const f = path.join(STATE, 'incompetech.json');
    let list;
    try { if (Date.now() - fs.statSync(f).mtimeMs < 7 * 864e5) list = JSON.parse(fs.readFileSync(f, 'utf8')); } catch {}
    if (!list) { list = await json('https://incompetech.com/music/royalty-free/pieces.json', { timeout: 15000 }); fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(f, JSON.stringify(list)); }
    const terms = (genre ? enQuery : query).toLowerCase().split(/\s+/).filter(Boolean);
    const hms = t => String(t || '').split(':').reduce((a, b) => a * 60 + +b, 0);
    return list.filter(p => { const h = [p.title, p.instruments, p.feel, p.description].join(' ').toLowerCase(); return terms.every(t => h.includes(t)); }).slice(0, 40)
      .map(p => ({ src: 'inc', title: p.title + ' - Kevin MacLeod', artist: 'Kevin MacLeod', tags: [p.instruments, p.feel, p.description].join(' '),
        url: 'https://incompetech.com/music/royalty-free/mp3-royaltyfree/' + enc(p.filename).replace(/\(/g, '%28').replace(/\)/g, '%29'), dur: hms(p.length), note: 'Incompetech · CC BY' }));
  },
  async bili() {
    const b = SOURCES.find(s => s.id === 'bili');
    const list = await b.search(query + (qBad ? '' : ''), { get: (u, o = {}) => get(u, { referer: 'https://www.bilibili.com/', ...o }) });
    return list.map(x => ({ src: 'bili', title: x.title, url: x.page + '#audio', dur: x.dur, plays: x.plays, note: 'B 站音轨 · 最高 320k' }));
  },
  async openverse() {
    const j = await json(`https://api.openverse.org/v1/audio/?q=${enc(genre ? enQuery : query)}&page_size=20`, { viaProxy: true, timeout: 12000 });
    return (j.results || []).filter(r => /\.(mp3|ogg|m4a|wav|flac)(\?|$)/i.test(r.url || '')).map(r => ({ src: 'openverse', title: r.title + (r.creator ? ' - ' + r.creator : ''), artist: r.creator, url: r.url, dur: r.duration ? Math.round(r.duration / 1000) : 0,
      note: 'CC 授权（' + (r.license || '').toUpperCase() + '）· ' + (r.source || 'openverse') }));
  },
  async archive() {
    // 风格模式只要标了 CC / 公版授权的（别人上传的商业唱片不要）
    const q = genre ? `(${instr.length ? instr.join(' OR ') : 'guzheng OR erhu OR pipa OR guqin'}) AND licenseurl:*` : query;
    const j = await json(`https://archive.org/advancedsearch.php?q=${enc(q)}+AND+mediatype:audio&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&sort[]=downloads+desc&rows=6&output=json`, { viaProxy: true });
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
  const res = await Promise.all(want.filter(k => SRC[k]).map(k => Promise.race([SRC[k](), new Promise(ok => setTimeout(() => ok([]), 10000))]).catch(e => { if (opt.debug) console.error(k, e.message); return []; })
    .then(r => { if (opt.debug) console.error(k, r.length, '条', Date.now() - t0, 'ms'); return r; })));
  // B 站搜索页常常没有时长：前几个去查一下（顺便拿准确的时长），再按原曲时长打分
  let all = res.flat().map(x => ({ ...x, score: score(x) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const need = all.filter(x => x.src === 'bili').slice(0, 10);
  await Promise.all(need.map(x => json('https://api.bilibili.com/x/web-interface/view?bvid=' + /BV[0-9A-Za-z]{10}/.exec(x.url)[0], { referer: 'https://www.bilibili.com/', timeout: 5000 })
    .then(j => { if (j.code === 0) { x.dur = j.data.pages?.[0]?.duration || j.data.duration; x.plays = j.data.stat?.view || x.plays; if ((j.data.pages || []).length > 1) x.multi = 1; } }).catch(() => {})));
  // 5sing 搜索结果的大小常常是 0：前几个查一下播放地址，按文件大小算时长、标音质
  await Promise.all(all.filter(x => x.src === 'fs').slice(0, 8).map(x => json(`http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=${/(\d+)\.html/.exec(x.url)[1]}&songtype=${/\/(yc|fc|bz)\//.exec(x.url)[1]}`, { timeout: 5000 })
    .then(j => { const d = j.data || {}, [sz, kbps] = +d.sqsize ? [+d.sqsize, 320] : +d.hqsize ? [+d.hqsize, 192] : [+d.lqsize, 128]; if (sz) { x.dur = Math.round(sz * 8 / kbps / 1000); x.note = x.note.replace(/mp3.*/, 'mp3 ' + kbps + 'k'); } else x.dead = 1; }).catch(() => {})));
  all = all.filter(x => !x.dead).map(x => ({ ...x, score: score(x) - (x.multi ? 30 : 0) })).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
  const seen = new Set(), items = [];
  for (const x of all) {
    const k = (genre ? '' : x.src + ':') + norm(x.title).slice(0, 30);
    if (seen.has(k) || seen.has(x.url)) continue; seen.add(k); seen.add(x.url); items.push(x);
  }
  if (opt.debug) console.error('用时', Date.now() - t0, 'ms', '原曲', refDur, 's');
  return genre ? mix(items) : items;
}
// 风格模式：网易云、B 站、CC 音乐站轮着排（网易 B 站 网易 B 站 CC …），一次给的几首来源、风格不重样
function mix(items) {
  const fam = x => /^(ne|kw|fs)/.test(x.src) ? 'ne' : x.src === 'bili' ? 'bili' : 'cc', g = { ne: [], bili: [], cc: [] };
  for (const x of items) g[fam(x)].push(x);
  const out = [], order = ['ne', 'bili', 'ne', 'bili', 'cc'];
  for (let i = 0; out.length < items.length; i++) { const q = g[order[i % order.length]]; if (q.length) out.push(q.shift()); else if (!g.ne.length && !g.bili.length && !g.cc.length) break; }
  return out;
}
const fmtDur = s => s ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : '?';
const clean = s => String(s).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d)).replace(/[\[\]]/g, ' ').replace(/\s+/g, ' ').trim();
const lastFile = path.join(STATE, 'last.json');
// 链接 → /api/aud 的缓存键（下载时解析真正的音频地址）；openverse / archive 是直链，返回 ''
function audKeyOf(u) {
  let m;
  if ((m = /bilibili\.com\/video\/(BV[0-9A-Za-z]{10})/.exec(u))) return 'bv:' + m[1] + ':1';
  if ((m = /music\.163\.com\/song\/media\/outer\/url\?id=(\d+)/.exec(u))) return 'ne:' + m[1];
  if ((m = /5sing\.kugou\.com\/(yc|fc|bz)\/(\d+)\.html/.exec(u))) return 'fs:' + m[1] + ':' + m[2];
  if ((m = /kuwo\.cn\/play_detail\/(\d+)/.exec(u))) return 'kw:' + m[1];
  if ((m = /^https:\/\/([a-z0-9-]+)\.bandcamp\.com\/track\/([a-z0-9-]+)/.exec(u))) return 'bc:' + m[1] + '/' + m[2];
  if (/^https:\/\/(www\.free-stock-music\.com|ccmixter\.org|incompetech\.com)\//.test(u)) return 'u:' + u;
  return '';
}

if (sub === 'get') {
  let items;
  if (opt.pick && !query) items = (() => { try { return JSON.parse(fs.readFileSync(lastFile, 'utf8')); } catch { return []; } })();
  else items = await search();
  const x = items[(+opt.pick || 1) - 1];
  if (!x) die('没找到能下载的（换个关键词）', 2);
  let url = x.url, referer = '', ext = 'mp3';
  const key = audKeyOf(x.url);
  if (key) { const s = await audSource(key); url = s.url; referer = s.referer; if (key.startsWith('bv:')) ext = 'm4a'; }
  else ext = (/\.(\w+)(\?|$)/.exec(url)?.[1] || 'mp3').toLowerCase();
  const px = !key && (x.src === 'openverse' || x.src === 'archive') ? await proxy() : '';
  const dir = opt.out || path.join(os.tmpdir(), 'claclaw-media'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, clean(x.title).replace(/[\\/:*?"<>|]/g, ' ').slice(0, 60) + '.' + ext);
  const code = await new Promise(ok => spawn('curl', ['-sSL', '-m', '300', '-A', UA, ...(referer ? ['-e', referer] : []), ...(px ? ['-x', px] : []), '-o', file, '-w', '%{http_code}', url]).on('exit', ok));
  if (code !== 0 || !fs.existsSync(file) || fs.statSync(file).size < 50_000) die('下载失败（换一个：--pick 2）');
  console.log([file, (fs.statSync(file).size / 1048576).toFixed(1) + 'MB', x.note, fmtDur(x.dur), x.title].join('\t'));
} else {
  const items = await search();
  if (!items.length) die('没找到能直接放的纯音频（多半是 VIP 歌，网易云不免费、B 站也没有官方上传）：换个关键词，或用 claw-audio 找 MV 版', 2);
  fs.mkdirSync(STATE, { recursive: true }); fs.writeFileSync(lastFile, JSON.stringify(items.slice(0, 20)));
  const n = Math.max(1, +opt.n || (sub === 'find' ? 10 : genre || talk ? 5 : 1));
  const top = items.slice(0, n);
  if (opt.json) console.log(JSON.stringify(top));
  else top.forEach((x, i) => console.log((sub === 'find' ? (i + 1) + '\t' : '') + [`[${clean(x.title)}](${x.url})`, x.note, fmtDur(x.dur)].join('\t')));
}
process.exit(0);
