// 片单封面（claw-movie 的电视卡片）：GET /api/cover?u=<电影播放页>，按播放页算出来源自带的缩略图，服务器去取（直连不通走本机代理）、
// 存到 ~/.claclaw/media/covers/，和 claw-movie 命令下载的封面同一个目录、同一种文件名（缩略图地址的 md5 前 12 位），谁先取到另一边直接用。
// 只认 YouTube、Dailymotion、Internet Archive、NFB 的电影页，不当通用图片代理；取不到的记 10 分钟，前端没图就保持电视黑屏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { proxyUrl } from './audproxy.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DIR = path.join(process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw'), 'media', 'covers');
const MAGIC = [['jpg', b => b[0] === 0xff && b[1] === 0xd8], ['png', b => b[0] === 0x89 && b[1] === 0x50], ['gif', b => b.subarray(0, 3).toString() === 'GIF'], ['webp', b => b.subarray(8, 12).toString() === 'WEBP']];
const TYPE = { jpg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
const miss = new Map(), busy = new Map();

// 播放页 → 缩略图地址（和 skills/_lib/media/engine.mjs 的 coverUrl 一致）；NFB 要读页面里的 og:image，返回 {page}
export function coverSrc(u) {
  let x; try { x = new URL(u); } catch { return null; }
  if (x.protocol !== 'https:' && x.protocol !== 'http:') return null;
  const h = x.hostname.replace(/^(www|m)\./, '');
  let m;
  if (h === 'youtube.com' && x.pathname === '/watch' && /^[\w-]{11}$/.test(x.searchParams.get('v') || '')) return { img: `https://i.ytimg.com/vi/${x.searchParams.get('v')}/mqdefault.jpg` };
  if (h === 'youtu.be' && (m = /^\/([\w-]{11})$/.exec(x.pathname))) return { img: `https://i.ytimg.com/vi/${m[1]}/mqdefault.jpg` };
  if (h === 'dailymotion.com' && (m = /^\/video\/(\w{3,20})$/.exec(x.pathname))) return { img: `https://www.dailymotion.com/thumbnail/video/${m[1]}` };
  if (h === 'archive.org' && (m = /^\/(?:details|embed)\/([\w.-]{1,120})\/?$/.exec(x.pathname))) return { img: `https://archive.org/services/img/${m[1]}` };
  if (h === 'nfb.ca' && (m = /^\/film\/([\w-]{1,120})\/?$/.exec(x.pathname))) return { page: `https://www.nfb.ca/film/${m[1]}/` };
  return null;
}

function curl(url, binary) {
  return proxyUrl().then(px => new Promise((ok, no) => {
    if (!px) return no(new Error('要代理'));
    const p = spawn('curl', ['-sSL', '-m', '12', '-x', px, '-A', UA, '-w', '\n%{http_code}', url]);
    const bufs = []; p.stdout.on('data', d => bufs.push(d)); p.on('error', no);
    p.on('exit', () => { const b = Buffer.concat(bufs), nl = b.lastIndexOf(10), code = +b.subarray(nl + 1).toString(); code === 200 ? ok(binary ? b.subarray(0, nl) : b.subarray(0, nl).toString('utf8')) : no(new Error('HTTP ' + code)); });
  }));
}
async function get(url, binary) {
  try { const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) }); if (r.ok) return binary ? Buffer.from(await r.arrayBuffer()) : r.text(); } catch {}
  return curl(url, binary);
}

const base = img => path.join(DIR, crypto.createHash('md5').update(img).digest('hex').slice(0, 12));
const cached = img => { const b = base(img); return ['jpg', 'png', 'webp', 'gif'].map(e => `${b}.${e}`).find(f => fs.existsSync(f)) || ''; };

async function fetchCover(src) {
  let img = src.img;
  if (!img) {
    const h = await get(src.page, false);
    img = (/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i.exec(h) || /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i.exec(h) || [])[1] || '';
    if (!/^https:\/\/\S+$/.test(img)) throw new Error('没有封面');
  }
  const hit = cached(img); if (hit) return hit;
  const b = await get(img, true), ext = MAGIC.find(([, f]) => f(b))?.[0];
  if (!ext || b.length < 1500 || b.length > 5 * 1048576) throw new Error('不是图片');
  fs.mkdirSync(DIR, { recursive: true });
  const f = `${base(img)}.${ext}`; fs.writeFileSync(f, b); return f;
}

// 找本地封面文件（没有就去取）；取不到返回 ''
export async function coverFile(u) {
  const src = coverSrc(u); if (!src) return '';
  if (src.img) { const hit = cached(src.img); if (hit) return hit; }
  const k = src.img || src.page, t = miss.get(k);
  if (t && Date.now() - t < 10 * 60_000) return '';
  if (!busy.has(k)) busy.set(k, fetchCover(src).catch(() => { miss.set(k, Date.now()); return ''; }).finally(() => busy.delete(k)));
  return busy.get(k);
}

export async function serveCover(req, res, u) {
  const f = await coverFile(u || '');
  if (!f) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
  const st = fs.statSync(f);
  res.writeHead(200, { 'content-type': TYPE[path.extname(f).slice(1)] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'private, max-age=604800' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}
