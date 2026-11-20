// 纯音频播放（claw-music 技能）：聊天里的 <audio> 播 /api/aud?bv=BV…&p=1、?ne=歌曲ID 等，只有声音、没有画面。
// - B 站：不登录也能拿到视频单独的音轨（DASH audio，最高 320kbps AAC）。CDN 地址是 B 站自己签的、带时限，
//   而且要 Referer 是 B 站，手机直接放不了，所以服务器带上来源页去取、原样转给手机（支持 Range，能拖进度）。
// - 网易云：官方外链 music.163.com/song/media/outer/url?id=… 只对免费歌有效（VIP 歌会 302 到 /404）；
//   跳到的 mp3 是 http 的，https 页面里放不了，也由服务器转。
// - Free-Stock-Music、ccMixter（CC 授权的免费音乐站）：mp3 直链要求来源页是它们自己（防盗链），也由服务器带上来源页转；
//   只认这两个站固定目录下的 .mp3（u=完整地址），别的地址一律不转，不当通用代理。
// - 5sing（fs=yc:ID，原创 / 翻唱 / 伴奏）、酷我（kw=ID，命令行只挑它标了免费的歌）：播放地址带时效，按 ID 现取再转。
// - Bandcamp（bc=艺人/曲目）：音乐人开放的免费试听流（全曲 128k）；曲目页要出墙才打得开（走本机代理），音频本身直连。
// - Incompetech（Kevin MacLeod，CC BY）：mp3 回的类型是 octet-stream，iPhone 放不了，转一下改成 audio/mpeg。
// 解析出的地址缓存 20 分钟（B 站的签名约 2 小时过期）；上游回 403 / 404 / 410 就重新解析一次。
import { Readable } from 'node:stream';
import net from 'node:net';
import { spawn } from 'node:child_process';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const BILI_REF = 'https://www.bilibili.com/';
const TTL = 20 * 60_000;
const cache = new Map();   // key → { at, url, type, referer }

async function getJson(url, referer) {
  const r = await fetch(url, { headers: { 'user-agent': UA, ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// B 站音轨：码率最高的那条；CDN 优先 upos（mcdn 那种带端口的节点常常连不上）
async function biliAudio(bv, p) {
  const v = await getJson('https://api.bilibili.com/x/web-interface/view?bvid=' + bv, BILI_REF);
  if (v.code !== 0) throw new Error('B 站：' + (v.message || v.code));
  const cid = (v.data.pages || [])[p - 1]?.cid || v.data.cid;
  const j = await getJson(`https://api.bilibili.com/x/player/playurl?bvid=${bv}&cid=${cid}&fnval=16&fourk=1`, BILI_REF);
  if (j.code !== 0) throw new Error('B 站：' + (j.message || j.code));
  const d = j.data?.dash || {};
  const list = [...(d.audio || []), ...(d.flac?.audio ? [d.flac.audio] : []), ...(d.dolby?.audio || [])].filter(a => a?.baseUrl || a?.base_url);
  if (!list.length) throw new Error('这个视频没有单独的音轨');
  list.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
  const a = list[0], urls = [a.baseUrl || a.base_url, ...(a.backupUrl || a.backup_url || [])];
  return { url: urls.find(u => !/mcdn\.bilivideo/.test(u)) || urls[0], type: 'audio/mp4', referer: BILI_REF };
}

// 网易云外链：跟一次跳转看落到哪；落到 /404 = VIP 或下架
async function neAudio(id) {
  const r = await fetch(`https://music.163.com/song/media/outer/url?id=${id}.mp3`, { redirect: 'manual', headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  const loc = r.headers.get('location') || '';
  if (!/^https?:\/\//.test(loc) || /music\.163\.com\/404/.test(loc)) throw new Error('网易云这首不能免费播（VIP 或已下架）');
  return { url: loc, type: 'audio/mpeg', referer: '' };
}

// 5sing：手机版接口不登录给播放地址，sq 320k > hq 192k > lq 128k
async function fsAudio(type, id) {
  const j = await getJson(`http://mobileapi.5sing.kugou.com/song/getSongUrl?songid=${id}&songtype=${type}`);
  const d = j.data || {}, url = d.squrl || d.hqurl || d.lqurl;
  if (!url) throw new Error('5sing 这首放不了（已删除或不公开）');
  return { url, type: 'audio/mpeg', referer: '' };
}
// 酷我：按歌曲 ID 换一个带时效的 mp3 地址（128k）
async function kwAudio(id) {
  const r = await fetch(`http://antiserver.kuwo.cn/anti.s?type=convert_url&rid=MUSIC_${id}&format=mp3&response=url`, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(8000) });
  const url = (await r.text()).trim();
  if (!/^https?:\/\/\S+\.mp3/.test(url)) throw new Error('酷我这首放不了');
  return { url, type: 'audio/mpeg', referer: '' };
}
// 要出墙的页面：先直连，不通再走本机代理（环境变量或 Clash 7890 / 7897）
const portOpen = port => new Promise(ok => { const s = net.connect({ host: '127.0.0.1', port }); s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); s.setTimeout(400, () => { s.destroy(); ok(false); }); });
export async function proxyUrl() {
  const e = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.ALL_PROXY || process.env.all_proxy || process.env.HTTP_PROXY || process.env.http_proxy;
  if (e) return e;
  for (const p of [7890, 7897]) if (await portOpen(p)) return 'http://127.0.0.1:' + p;
  return '';
}
async function getText(url) {
  try { const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) }); if (r.ok) return r.text(); } catch {}
  const px = await proxyUrl();
  if (!px) throw new Error('打不开（要代理）');
  return new Promise((ok, no) => {
    const p = spawn('curl', ['-sSL', '--compressed', '-m', '12', '-x', px, '-A', UA, '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', no);
    p.on('exit', () => { const s = Buffer.concat(bufs).toString('utf8'), nl = s.lastIndexOf('\n'); +s.slice(nl + 1) === 200 ? ok(s.slice(0, nl)) : no(new Error('HTTP ' + (s.slice(nl + 1) || '超时'))); });
  });
}
const unesc = s => s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
// Bandcamp：曲目页里的 data-tralbum 就是它自己播放器用的数据，mp3-128 是音乐人开放的试听流
async function bcAudio(path) {
  const [artist, slug] = path.split('/');
  const h = await getText(`https://${artist}.bandcamp.com/track/${slug}`);
  const m = /data-tralbum="([^"]+)"/.exec(h);
  const url = m && JSON.parse(unesc(m[1])).trackinfo?.[0]?.file?.['mp3-128'];
  if (!url) throw new Error('Bandcamp 这首没开放试听');
  return { url, type: 'audio/mpeg', referer: '' };
}

// 要带来源页才给放的 CC 音乐站：[地址规则, 来源页]
const REF_SITES = [
  [/^https:\/\/www\.free-stock-music\.com\/music\/[\w-]+\/mp3\/[\w-]+\.mp3$/, 'https://www.free-stock-music.com/'],
  [/^https:\/\/ccmixter\.org\/content\/[\w-]+\/[\w%()'!,~.-]+\.mp3$/, 'https://ccmixter.org/'],
  [/^https:\/\/incompetech\.com\/music\/royalty-free\/mp3-royaltyfree\/[\w%()'!,~.-]+\.mp3$/, 'https://incompetech.com/'],
];
const refSite = u => !/\.\.|%2e%2e|%2f/i.test(u) && REF_SITES.find(([re]) => re.test(u));

// 查询参数 → 缓存键；不合格返回 ''
export function audKey(q) {
  const bv = q.get('bv') || '', ne = q.get('ne') || '', p = Math.max(1, Math.min(999, +q.get('p') || 1));
  if (/^BV[0-9A-Za-z]{10}$/.test(bv)) return 'bv:' + bv + ':' + p;
  if (/^\d{1,15}$/.test(ne)) return 'ne:' + ne;
  const fs = q.get('fs') || '', kw = q.get('kw') || '', bc = q.get('bc') || '';
  if (/^(yc|fc|bz):\d{1,12}$/.test(fs)) return 'fs:' + fs;
  if (/^\d{1,12}$/.test(kw)) return 'kw:' + kw;
  if (/^[a-z0-9-]{1,60}\/[a-z0-9-]{1,150}$/.test(bc)) return 'bc:' + bc;
  const u = q.get('u') || '';
  if (u.length < 400 && refSite(u)) return 'u:' + u;
  return '';
}
// 给命令行（claw-music get 下载）用：解析出真正的音频地址和要带的 Referer
export async function audSource(key) { return resolve(key, true); }
async function resolve(key, fresh) {
  const c = cache.get(key);
  if (!fresh && c && Date.now() - c.at < TTL) return c;
  const k = key.slice(0, key.indexOf(':')), rest = key.slice(k.length + 1);
  const r = { at: Date.now(), ...(k === 'bv' ? await biliAudio(rest.split(':')[0], +rest.split(':')[1])
    : k === 'ne' ? await neAudio(rest)
    : k === 'fs' ? await fsAudio(...rest.split(':'))
    : k === 'kw' ? await kwAudio(rest)
    : k === 'bc' ? await bcAudio(rest)
    : { url: rest, type: 'audio/mpeg', referer: refSite(rest)[1] }) };
  cache.set(key, r);
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return r;
}

export async function serveAud(req, res, q, log = () => {}) {
  const key = audKey(q);
  if (!key) { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('参数不对'); }
  const ac = new AbortController();
  res.on('close', () => ac.abort());
  let up, info;
  try {
    for (const fresh of [false, true]) {
      info = await resolve(key, fresh);
      up = await fetch(info.url, { signal: ac.signal, headers: { 'user-agent': UA, ...(info.referer ? { referer: info.referer } : {}), ...(req.headers.range ? { range: req.headers.range } : {}) } });
      if (![403, 404, 410].includes(up.status)) break;
      up.body?.cancel().catch(() => {});
    }
  } catch (e) {
    if (ac.signal.aborted) return;
    log('aud', key, e.message);
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); return res.end(e.message.slice(0, 200));
  }
  if (!up.ok) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('上游 HTTP ' + up.status); }
  const h = { 'content-type': info.type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=600' };
  for (const k of ['content-length', 'content-range']) { const v = up.headers.get(k); if (v) h[k] = v; }
  res.writeHead(up.status, h);
  if (req.method === 'HEAD' || !up.body) { up.body?.cancel().catch(() => {}); return res.end(); }
  Readable.fromWeb(up.body).on('error', () => res.destroy()).pipe(res);
}
