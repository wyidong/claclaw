#!/usr/bin/env node
// claclaw-tv：电视直播入口。先平台、再频道（和电影技能一样）：
//   platforms.json 是平台表（央视网、各省台的官方平台、YouTube……），每个平台下面挂它能看的台；
//   YouTube 平台下面是各台的官方频道，正在播哪几场用的时候现查。
// 输出 ```tv 代码块：claclaw 画成频道卡片（点了去官网看；YouTube 直播、CGTN 官方流在聊天里直接播）。
//   claclaw-tv "四川卫视"            找台（模糊匹配：湖南台、央视五套、CCTV5、凤凰、TVBS……）
//   claclaw-tv platforms             有哪些平台、各有几个台
//   claclaw-tv list [分组|平台名]     列出全部（按平台分组），或某一类台 / 某个平台的台
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLATFORMS = JSON.parse(fs.readFileSync(path.join(HERE, 'platforms.json'), 'utf8'));
const GROUPS = ['央视', '卫视', '少儿', '地方', '香港', '澳门', '台湾', '海外', '国际'];   // 海外：华人台（中文）；国际：外语台
const ALL = PLATFORMS.flatMap(p => p.channels.map(c => ({ ...c, site: p.site, pnote: p.note })));
const argv = process.argv.slice(2), cmd = argv[0] || '';
const gi = c => { const i = GROUPS.indexOf(c.group); return i < 0 ? 99 : i; };

const ABBR = { 北京: '京', 天津: '津', 河北: '冀', 山西: '晋', 内蒙古: '蒙', 辽宁: '辽', 吉林: '吉', 黑龙江: '黑', 上海: '沪', 江苏: '苏', 浙江: '浙', 安徽: '皖', 福建: '闽',
  江西: '赣', 山东: '鲁', 河南: '豫', 湖北: '鄂', 湖南: '湘', 广东: '粤', 广西: '桂', 海南: '琼', 重庆: '渝', 四川: '川', 贵州: '贵', 云南: '云', 西藏: '藏', 陕西: '陕', 甘肃: '甘', 青海: '青',
  宁夏: '宁', 新疆: '新', 深圳: '深', 厦门: '厦' };
function label(c) {
  if (c.label) return c.label;
  const m = /^CCTV-?(\d+\+?)/i.exec(c.name); if (m) return m[1];
  if (c.group === '卫视' && ABBR[c.region]) return ABBR[c.region];
  return c.name.replace(/[\s·].*$/, '').replace(/(卫视|电视台|频道)$/, '').slice(0, 4);
}
// YouTube：有能嵌入的那场 → watch 地址（claclaw 里直接播）；台主不让嵌入的 → 频道的 /live；现在没在播的 → 频道的直播页（点了去 YouTube）
const ytPlay = c => !!(c.yt && c.id && !c.noembed);
const urlOf = c => !c.yt ? c.url : ytPlay(c) ? 'https://www.youtube.com/watch?v=' + c.id : 'https://www.youtube.com/' + c.yt + (c.id ? '/live' : '/streams');
const playable = c => ytPlay(c) || /\.m3u8(\?|$)/.test(c.url || '');
// 卡片下面那行小字：单找一个台时带上平台名；按平台列表时平台已经是小标题，只写补充说明
const noteOf = (c, inSite) => c.yt ? (c.off ? (inSite ? '' : 'YouTube · ') + '现在没在播 · 点了看它的直播页' : c.noembed ? (inSite ? '' : 'YouTube · ') + '台方不让嵌入 · 点了去 YouTube 看' : inSite ? '聊天里直接播' : 'YouTube 官方直播 · 聊天里直接播（要翻墙）')
  : inSite ? (c.note || c.pnote || c.group) : [c.site, c.note || c.pnote].filter(Boolean).join(' · ');
const line = (c, inSite) => [c.group, label(c), c.name, urlOf(c), noteOf(c, inSite)].map(x => String(x).replace(/\|/g, '｜')).join(' | ');
// 并发查，最多同时 16 个（YouTube 台多，一下子全发出去容易被限）
async function pool(list, fn, n = 16) { const out = new Array(list.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => { while (i < list.length) { const k = i++; out[k] = await fn(list[k]); } })); return out; }
const block = (list, inSite) => '```tv\n' + list.map(c => line(c, inSite)).join('\n') + '\n```';

// ---------- 匹配：台名 / 别名完全一样最先，其次前缀、包含，再次同一地区 ----------
const CN = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15, 十六: 16, 十七: 17 };
const norm = s => String(s || '').toLowerCase().replace(/[\s\-_·．.()（）「」]/g, '')
  .replace(/^(打开|播放|放|看看|看|我要看|我想看|来个)/, '').replace(/(直播|在线看|在线|频道|电视台|台)$/, '')
  .replace(/央视(十[一二三四五六七]?|[一二三四五六七八九])套?/, (_, n) => 'cctv' + CN[n]).replace(/中央(\d+)/, 'cctv$1');
const pre = (a, b) => a.startsWith(b) && !(/\d$/.test(b) && /^\d/.test(a.slice(b.length)));   // cctv13 不算以 cctv1 开头
const inc = (a, b) => { for (let i = a.indexOf(b); i >= 0; i = a.indexOf(b, i + 1)) if (!(/\d$/.test(b) && /^\d/.test(a.slice(i + b.length)))) return true; return false; };
const short = k => /^[a-z0-9+]{1,4}$/.test(k);   // 很短的英文简称（ctv、set、dw）只认完全一样，免得 cctv5 匹配到 ctv
function score(c, q) {
  const keys = [c.name, ...(c.aliases || [])].map(norm).filter(Boolean);
  if (keys.includes(q)) return 100;
  if (keys.some(k => pre(k, q) || (!short(k) && pre(q, k)))) return 70;
  if (keys.some(k => !short(k) && (inc(k, q) || inc(q, k)))) return 60;
  if (c.region && q.includes(norm(c.region))) return 40;
  return 0;
}

// ---------- YouTube：正在播哪几场现查（走代理）；查不到就用存的那场 ----------
let pxP;
const portOpen = p => new Promise(ok => { const s = net.connect(p, '127.0.0.1'); s.on('connect', () => { s.destroy(); ok(true); }); s.on('error', () => ok(false)); setTimeout(() => { s.destroy(); ok(false); }, 400); });
const proxy = () => pxP ||= (async () => process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || ((await portOpen(7890)) ? 'http://127.0.0.1:7890' : (await portOpen(7897)) ? 'http://127.0.0.1:7897' : ''))();
async function get(u) {
  const px = await proxy();
  return new Promise(ok => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', '8', ...(px ? ['-x', px] : []), '-H', 'accept-language: zh-CN,zh;q=0.9', '-A', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36', '-e', 'https://claclaw.local/', u]);
    const b = []; p.stdout.on('data', d => b.push(d)); p.on('error', () => ok('')); p.on('exit', () => ok(Buffer.concat(b).toString()));
  });
}
const embedOk = async id => /previewPlayabilityStatus\\?":\{\\?"status\\?":\\?"OK/.test(await get('https://www.youtube.com/embed/' + id + '?hl=zh-CN'));
function* walk(o, key) { if (!o || typeof o !== 'object') return; if (o[key]) yield o[key]; for (const v of Object.values(o)) yield* walk(v, key); }
// 频道「直播」页里正在播的（带 LIVE 角标的）几场
async function lives(c) {
  const h = await get('https://www.youtube.com/' + c.yt + '/streams?hl=zh-CN');
  const m = /var ytInitialData = (\{.*?\});<\/script>/s.exec(h); if (!m) return [];
  let data; try { data = JSON.parse(m[1]); } catch { return []; }
  const out = [];
  for (const l of walk(data, 'lockupViewModel')) {
    const js = JSON.stringify(l);
    if (!l.contentId || !/BADGE_STYLE_LIVE|"直播"|"LIVE"/.test(js) || /UPCOMING|首播|已安排/.test(js)) continue;
    out.push({ id: l.contentId, title: l.metadata?.lockupMetadataViewModel?.title?.content || '' });
  }
  for (const v of walk(data, 'videoRenderer')) {
    if (!v.videoId || !/BADGE_STYLE_TYPE_LIVE_NOW|"LIVE"/.test(JSON.stringify(v.badges || v.thumbnailOverlays || ''))) continue;
    out.push({ id: v.videoId, title: v.title?.runs?.[0]?.text || '' });
  }
  return out.filter((x, i) => out.findIndex(y => y.id === x.id) === i);
}
// 列表里用：存的那场还能播就用它，不能播就到频道直播页找现在那一场
async function fresh(c) {
  if (!c.yt || c.noembed || (c.id && await embedOk(c.id))) return c;
  for (const x of await lives(c)) if (await embedOk(x.id)) return { ...c, id: x.id };
  return { ...c, id: null, off: true };
}
// 单找一个台时用：这个频道现在播着的几场都列出来（主频道那场在前），最多 4 场
async function allLives(c) {
  if (c.noembed) return [c];
  const ls = await lives(c), ids = [c.id, ...ls.map(x => x.id).filter(id => id !== c.id)].filter(Boolean).slice(0, 6);
  const ok = await Promise.all(ids.map(embedOk)), title = Object.fromEntries(ls.map(x => [x.id, x.title]));
  const out = ids.filter((_, i) => ok[i]).slice(0, 4).map((id, i) => i === 0 && id === c.id && c.id ? c : { ...c, id, name: c.name.replace(/\s*24 ?小时$/, '') + ' · ' + (title[id] || '直播').slice(0, 28), label: c.label });
  return out.length ? out : [{ ...c, id: null, off: true }];
}

// ---------- 命令 ----------
const siteMatch = g => PLATFORMS.find(p => norm(p.site) === norm(g));
if (cmd === 'platforms') {
  // 平台卡片：点了去平台首页；说明里列出几个台名
  const cards = PLATFORMS.map(p => {
    const cs = [...p.channels].sort((a, b) => gi(a) - gi(b)), g = cs[0]?.group || '地方';
    return [g, p.label || p.site.replace(/[\s·].*$/, '').slice(0, 4), p.site + ' · ' + cs.length + ' 个台', p.home || urlOf(cs[0]), cs.slice(0, 4).map(c => c.name).join('、') + (cs.length > 4 ? '……' : '')].map(x => String(x).replace(/\|/g, '｜')).join(' | ');
  });
  console.log('```tv\n' + cards.join('\n') + '\n```');
} else if (cmd === 'list') {
  const g = argv.slice(1).join(' ').trim(), sp = g && siteMatch(g);
  if (g && !sp && !GROUPS.includes(g)) { console.error('分组只有：' + GROUPS.join(' ') + '；或者写平台名：' + PLATFORMS.map(p => p.site).join('、')); process.exit(1); }
  const list = ALL.filter(c => !g || (sp ? c.site === sp.site : c.group === g)).sort((a, b) => gi(a) - gi(b));
  // 按平台分组（中文台多的平台在前）；只有一个台的网站（各省台自己的官网）合成一组「各台官网」
  const n = {}; list.forEach(c => { n[c.site] = (n[c.site] || 0) + 1; });
  // YouTube 台多：按地区再分（YouTube · 台湾……）；现在没在播的不列，只在小标题里说一声
  const siteOf = c => c.yt ? 'YouTube · ' + c.group : n[c.site] > 1 || sp || playable(c) ? c.site : c.group === '卫视' ? '各省卫视官网' : '各台官网 · ' + c.group;
  const all = await pool(list, fresh);
  for (const st of [...new Set(list.map(siteOf))]) {
    const cs = all.filter(c => siteOf(c) === st), on = cs.filter(c => !c.off), off = cs.length - on.length;
    if (!on.length) continue;
    const p = PLATFORMS.find(x => x.site === st);
    console.log('### ' + st + ' · ' + on.length + ' 个台' + (/^YouTube/.test(st) ? '（官方直播，聊天里直接播，要翻墙' + (off ? '；另有 ' + off + ' 个现在没在播' : '') + '）' : on.every(c => !playable(c)) ? '（点了去官网看' + (p?.note ? '，' + p.note : '') + '）' : ''));
    console.log(block(on, !/^各/.test(st)));
  }
} else if (cmd && cmd !== '--help' && cmd !== '-h') {
  const q = norm(argv.join(' '));
  const sp = siteMatch(argv.join(' '));
  if (sp) { console.log('### ' + sp.site + ' · ' + sp.channels.length + ' 个台'); console.log(block(await pool(ALL.filter(c => c.site === sp.site), fresh), true)); process.exit(0); }
  // 同一个台可能在几个平台都能看（CCTV 在央视网、央视频……）：每个平台一张卡，能在聊天里直接播的排前面
  const hits = ALL.map(c => ({ c, s: score(c, q) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s || playable(b.c) - playable(a.c) || gi(a.c) - gi(b.c));
  if (!hits.length) { console.error('频道表里没有「' + argv.join(' ') + '」。可以 platforms 看有哪些平台，list 看全部台'); process.exit(2); }
  const top = hits[0].s, pick = hits.filter(x => x.s >= Math.min(top, 60) || (top < 60 && x.s === top)).slice(0, 10).map(x => x.c);
  // 只找一个台、它在 YouTube 上：这个频道现在播着的几场都给（凤凰有资讯台、中文台、突发直播……）
  const one = new Set(pick.map(c => c.name)).size === 1;
  const out = (await Promise.all(pick.map(c => one && c.yt ? allLives(c) : fresh(c).then(x => [x])))).flat();
  console.log(block(out, false));
} else {
  console.log('用法：claclaw-tv "台名"              找台（四川卫视、湖南台、CCTV5、央视五套、凤凰、TVBS……）\n      claclaw-tv platforms            有哪些平台\n      claclaw-tv list [分组|平台名]    全部台（按平台分组）；分组：' + GROUPS.join(' '));
}
