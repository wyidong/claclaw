// 纯音频播放（claw-music 技能）：聊天里的 <audio> 播 /api/aud?bv=BV…&p=1 或 /api/aud?ne=歌曲ID，只有声音、没有画面。
// - B 站：不登录也能拿到视频单独的音轨（DASH audio，最高 320kbps AAC）。CDN 地址是 B 站自己签的、带时限，
//   而且要 Referer 是 B 站，手机直接放不了，所以服务器带上来源页去取、原样转给手机（支持 Range，能拖进度）。
// - 网易云：官方外链 music.163.com/song/media/outer/url?id=… 只对免费歌有效（VIP 歌会 302 到 /404）；
//   跳到的 mp3 是 http 的，https 页面里放不了，也由服务器转。
// 解析出的地址缓存 20 分钟（B 站的签名约 2 小时过期）；上游回 403 / 404 / 410 就重新解析一次。
import { Readable } from 'node:stream';

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

// 查询参数 → 缓存键；不合格返回 ''
export function audKey(q) {
  const bv = q.get('bv') || '', ne = q.get('ne') || '', p = Math.max(1, Math.min(999, +q.get('p') || 1));
  if (/^BV[0-9A-Za-z]{10}$/.test(bv)) return 'bv:' + bv + ':' + p;
  if (/^\d{1,15}$/.test(ne)) return 'ne:' + ne;
  return '';
}
// 给命令行（claw-music get 下载）用：解析出真正的音频地址和要带的 Referer
export async function audSource(key) { return resolve(key, true); }
async function resolve(key, fresh) {
  const c = cache.get(key);
  if (!fresh && c && Date.now() - c.at < TTL) return c;
  const [k, id, p] = key.split(':');
  const r = { at: Date.now(), ...(k === 'bv' ? await biliAudio(id, +p) : await neAudio(id)) };
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
