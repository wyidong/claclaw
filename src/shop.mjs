// 购物（claw-shopping 技能）：按关键词搜拼多多（多多进宝）的商品，给标题、券后价、主图、推广链接。
// claclaw 是开源的，谁装都能用：默认问公开的商品服务（clarelay 服务器上，钥匙只在服务器，不用加入 clarelay、不用注册拼多多）：
//   POST SHOP_API  {keyword, sort, n, min, max} → {ok, items:[{platform, sign, title, price, orig, coupon, sales, img, url}]}
//   服务器那边按来源 IP 限频、全局排队、同样的搜索缓存 15 分钟、碰到拼多多限用（40009）冷却。
// 开发者本机另有一条直连（DATA/shop-pdd.json 里有 { client_id, client_secret, pid }，0600，不进仓库），只用来调试。
// 本机也缓存 15 分钟，免得同一个问题反复问服务器。
// 商品图：GET /api/shop/img?u=<图片地址>，只代理拼多多的图片域名，存 ~/.claclaw/media/shop/（聊天里外站图片不自动加载）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://gw-api.pinduoduo.com/api/router';
export const SHOP_API = process.env.CLACLAW_SHOP_API || 'https://relay.165i.com/_svc/shop/pdd/search';
const CACHE_MS = 15 * 60e3, GAP_MS = 2000, COOL_MS = 30 * 60e3;
const IMG_DIR = path.join(process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw'), 'media', 'shop');
export const SORTS = { '综合': 0, '价格': 9, '价格低': 9, '价格高': 10, '销量': 6 };   // 拼多多 sort_type：0 综合、9 券后价升序、10 券后价降序、6 销量降序

export function sign(params, secret) {
  return crypto.createHash('md5').update(secret + Object.keys(params).sort().map(k => k + params[k]).join('') + secret).digest('hex').toUpperCase();
}
// 拼多多返回 → 统一的商品条目（价格单位是分；券后价 = 拼团价 - 券面额）
export function pddItem(g) {
  const group = Number(g.min_group_price) || 0, coupon = Number(g.coupon_discount) || 0;
  return {
    platform: '拼多多', sign: g.goods_sign || '', title: String(g.goods_name || '').trim(),
    price: Math.max(0, group - coupon) / 100, orig: group / 100, coupon: coupon / 100,
    sales: String(g.sales_tip || ''), shop: String(g.mall_name || ''),
    img: g.goods_thumbnail_url || g.goods_image_url || '',
  };
}

// 拼多多的排序只是大致的（销量按近期、价格偶有乱序）：多取一些，本机再排一次
export const salesNum = t => { const m = /([\d.]+)\s*(万)?/.exec(String(t || '')); return m ? parseFloat(m[1]) * (m[2] ? 1e4 : 1) : 0; };
export function resort(items, sort) {
  const by = sort === 9 ? (a, b) => a.price - b.price : sort === 10 ? (a, b) => b.price - a.price : sort === 6 ? (a, b) => salesNum(b.sales) - salesNum(a.sales) : null;
  return by ? items.slice().sort(by) : items;
}

export function makeShop({ DATA, log = () => {} }) {
  const cache = new Map();   // 词|排序 → { at, items }
  let last = 0, coolUntil = 0, chain = Promise.resolve();
  const keys = () => { try { const j = JSON.parse(fs.readFileSync(path.join(DATA, 'shop-pdd.json'), 'utf8')); return j.client_id && j.client_secret && j.pid ? j : null; } catch { return null; } };

  // 直连：一个接一个调（间隔 GAP_MS），40009 进冷却
  function direct(type, params) {
    const run = async () => {
      const k = keys(); if (!k) throw new Error('本机没有拼多多钥匙');
      const wait = last + GAP_MS - Date.now(); if (wait > 0) await new Promise(r => setTimeout(r, wait));
      last = Date.now();
      const p = { type, client_id: k.client_id, timestamp: Math.floor(Date.now() / 1000), data_type: 'JSON', ...params };
      for (const x in p) if (p[x] && typeof p[x] === 'object') p[x] = JSON.stringify(p[x]);
      p.sign = sign(p, k.client_secret);
      const r = await fetch(API, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(p), signal: AbortSignal.timeout(15000) });
      const j = await r.json();
      if (j.error_response) {
        const e = j.error_response, code = String(e.sub_code || e.error_code || '');
        if (code.includes('40009') || /限用|限流/.test(e.sub_msg || e.error_msg || '')) coolUntil = Date.now() + COOL_MS;
        throw new Error('拼多多：' + (e.sub_msg || e.error_msg || code));
      }
      return j;
    };
    const p = chain.then(run, run); chain = p.catch(() => {}); return p;
  }

  async function searchDirect(keyword, sort, n, min, max) {
    const k = keys(), range = min || max ? { range_list: [{ range_id: 1, range_from: Math.round((min || 0) * 100), range_to: Math.round((max || 1e6) * 100) }] } : {};   // range_id 1 = 券后价（分）
    const j = await direct('pdd.ddk.goods.search', { keyword, pid: k.pid, page_size: sort ? 20 : Math.max(10, n), sort_type: sort, with_coupon: false, ...range });
    const items = resort((j.goods_search_response?.goods_list || []).map(pddItem).filter(x => x.sign && x.title), sort).slice(0, n);
    if (!items.length) return items;
    const L = await direct('pdd.ddk.goods.promotion.url.generate', { p_id: k.pid, goods_sign_list: items.map(x => x.sign), generate_short_url: true });
    const urls = L.goods_promotion_url_generate_response?.goods_promotion_url_list || [];
    items.forEach((x, i) => { const u = urls[i] || {}; x.url = u.mobile_short_url || u.short_url || u.mobile_url || u.url || ''; });
    return items.filter(x => x.url);
  }
  // 公开的商品服务：它自己生成链接，返回同样的条目
  async function searchPublic(keyword, sort, n, min, max) {
    let r;
    try { r = await fetch(SHOP_API, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyword, sort, n, min, max }), signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Error('连不上商品服务（' + (e.cause?.code || e.message) + '）'); }
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || j.ok === false) throw new Error(j?.error || (r.status === 429 ? '查得太频繁，过一分钟再试' : '商品服务出错（' + r.status + '）'));
    return (j.items || []).filter(x => x && x.title && /^https:\/\//.test(x.url || '')).slice(0, n);
  }

  async function search({ keyword, sort = '综合', n = 6, min, max } = {}) {
    keyword = String(keyword || '').trim().slice(0, 60);
    if (!keyword) return { ok: false, error: '没有关键词' };
    const st = SORTS[sort] ?? 0; n = Math.max(1, Math.min(Number(n) || 6, 10));
    min = Math.max(0, Number(min) || 0); max = Math.max(0, Number(max) || 0);
    const ck = [keyword, st, n, min, max].join('|'), hit = cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, items: hit.items, cached: true };
    if (Date.now() < coolUntil) return { ok: false, error: '拼多多暂时限制了查询，' + Math.ceil((coolUntil - Date.now()) / 60e3) + ' 分钟后再试' };
    try {
      const items = keys() ? await searchDirect(keyword, st, n, min, max) : await searchPublic(keyword, sort, n, min, max);
      for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
      cache.set(ck, { at: Date.now(), items });
      log('shop', keyword, sort, '→', items.length);
      return { ok: true, items };
    } catch (e) { log('shop', keyword, 'error', e.message); return { ok: false, error: e.message }; }
  }
  return { search };
}

// ---- 商品图代理 ----
const IMG_HOST = /(^|\.)(pddpic\.com|yangkeduo\.com)$/i;
const MAGIC = [['jpg', b => b[0] === 0xff && b[1] === 0xd8], ['png', b => b[0] === 0x89 && b[1] === 0x50], ['webp', b => b.subarray(8, 12).toString() === 'WEBP'], ['gif', b => b.subarray(0, 3).toString() === 'GIF']];
const TYPE = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif' };
const imgBusy = new Map();
export function shopImgOk(u) { try { const x = new URL(u); return x.protocol === 'https:' && IMG_HOST.test(x.hostname); } catch { return false; } }
async function imgFile(u) {
  const b = path.join(IMG_DIR, crypto.createHash('md5').update(u).digest('hex').slice(0, 16));
  const hit = Object.keys(TYPE).map(e => `${b}.${e}`).find(f => fs.existsSync(f)); if (hit) return hit;
  const r = await fetch(u, { signal: AbortSignal.timeout(10000) }); if (!r.ok) throw new Error('HTTP ' + r.status);
  const buf = Buffer.from(await r.arrayBuffer()), ext = MAGIC.find(([, f]) => f(buf))?.[0];
  if (!ext || buf.length > 5 * 1048576) throw new Error('不是图片');
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const f = `${b}.${ext}`; fs.writeFileSync(f, buf); return f;
}
export async function serveShopImg(req, res, u) {
  let f = '';
  if (shopImgOk(u || '')) {
    if (!imgBusy.has(u)) imgBusy.set(u, imgFile(u).catch(() => '').finally(() => imgBusy.delete(u)));
    f = await imgBusy.get(u);
  }
  if (!f) { res.writeHead(404, { 'cache-control': 'no-store' }); return res.end(); }
  const st = fs.statSync(f);
  res.writeHead(200, { 'content-type': TYPE[path.extname(f).slice(1)], 'content-length': st.size, 'cache-control': 'private, max-age=604800' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(f).pipe(res);
}
