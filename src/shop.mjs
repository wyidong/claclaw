// 购物（claw-shopping 技能）：按关键词搜拼多多（多多进宝）的商品，给标题、券后价、主图、推广链接；
// 也能搜转转的二手在售商品（转转开放平台的 MCP 工具，凭证在 ~/.zz/ZZ_MCP_TOKEN 或环境变量 ZZ_MCP_TOKEN，30 天过期）。
// claclaw 是开源的，谁装都能用：默认问公开的商品服务（clarelay 服务器上，钥匙只在服务器，不用加入 clarelay、不用注册拼多多）：
//   POST SHOP_API  {keyword, sort, n, min, max} → {ok, items:[{platform, sign, title, price, orig, coupon, sales, img, url}]}
//   服务器那边按来源 IP 限频、全局排队、同样的搜索缓存 15 分钟、碰到拼多多限用（40009）冷却。
// 开发者本机另有一条直连（DATA/shop-pdd.json 里有 { client_id, client_secret, pid }，0600，不进仓库），只用来调试。
// 本机也缓存 15 分钟，免得同一个问题反复问服务器。
// 商品图：GET /api/shop/img?u=<图片地址>，只代理拼多多、转转的图片域名，存 ~/.claclaw/media/shop/（聊天里外站图片不自动加载）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const API = 'https://gw-api.pinduoduo.com/api/router';
export const SHOP_API = process.env.CLACLAW_SHOP_API || 'https://relay.165i.com/_svc/shop/pdd/search';
export const ZZ_MCP = process.env.CLACLAW_ZZ_MCP || 'https://mcp.zhuanzhuan.com/zai/zai-transfer';
const ZZ_UPLOAD = process.env.CLACLAW_ZZ_UPLOAD || 'https://app.zhuanzhuan.com/api/zaimcp/imageUpLoad';   // 估价用的本地图片上传（免登录）
const ZZ_SORTS = { '综合': 0, '销量': 0, '最新': 1, '价格': 2, '价格低': 2, '价格高': 3 };   // 转转 priceOrder：0 默认、1 最新、2 最低价、3 最高价（没有销量排序）
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

// 转转：凭证、价格区间（「最低_最高」，只给一头时另一头空着）、商品条目（标题里带成色，如「95A 苹果 …」；图默认 160 宽，要 400 的）
export function zzToken() {
  if (process.env.ZZ_MCP_TOKEN) return process.env.ZZ_MCP_TOKEN.trim();
  try { return fs.readFileSync(path.join(os.homedir(), '.zz', 'ZZ_MCP_TOKEN'), 'utf8').trim(); } catch { return ''; }
}
export const zzRange = (min, max) => min || max ? (min ? Math.round(min) : 0) + '_' + (max ? Math.round(max) : '') : '';
export function zzItem(g) {
  return {
    platform: '转转', sign: String(g.infoId || ''), title: String(g.title || '').trim(), price: Number(g.price) || 0, orig: 0, coupon: 0, sales: '',
    cond: String(g.chengSe || ''), labels: (g.serviceLabelsInfo || []).filter(Boolean).map(String),
    img: String(g.infoImage || '').replace(/([?&]w=)\d+/, '$1400'), url: String(g.jumpUrl || ''),
  };
}

// 转转回收估价结果 → 几行给 AI 读的话（金额是分，换成元；内部编码只在要用户确认时给出，好带回 --params）
export function zzValuation(d) {
  const y = c => c == null || c === '' ? '' : String(Math.round(Number(c)) / 100), out = [];
  const ask = (d.clarificationOptions || []).filter(o => o && o.paramName);
  if (d.needClarification || (!d.priceHit && ask.length)) {
    out.push('还要用户确认这些条件（让用户选，不要替他选；选好后加 --params \'{"参数ID":选项ID}\' 再估一次）：');
    for (const o of ask) out.push('- ' + o.paramName + '（' + o.paramId + '）：' + (o.options || []).map(x => x.optionName + '=' + x.optionId).join('、'));
  }
  const src = v => v === 1 ? '（参考近 30 天成交）' : '';
  if (d.priceHit && d.tiers?.length) {   // 有分档就只讲分档（主区间口径不同，和分档对不上，别混着说）
    out.push('回收参考价（按成色分档，以上门质检为准）：');
    for (const t of d.tiers) out.push('- ' + t.desc + '：' + (t.isSingle ? (t.singlePrice ? '约 ' + y(t.singlePrice) + ' 元' : t.noPriceDesc || '以质检为准') : '约 ' + y(t.minPrice) + '～' + y(t.maxPrice) + ' 元') + src(t.priceSource));
  } else if (d.priceHit && (d.minPrice || d.maxPrice)) out.push('回收参考价：约 ' + y(d.minPrice) + '～' + y(d.maxPrice) + ' 元' + src(d.priceSource) + '，以上门质检为准');
  if (d.matchedParams?.length) out.push('已按这些条件估：' + d.matchedParams.map(p => p.paramName + ' ' + p.optionName).join('、'));
  if (d.unmatchedTexts?.length) out.push('描述里没用上的：' + d.unmatchedTexts.join('、') + '（容量、成色、电池、维修情况说清楚，估得更准）');
  if (!out.length) out.push('暂时估不出价格' + (d.statusMessage ? '（' + d.statusMessage + '）' : '') + '：请用户补充容量、成色、功能、维修情况。');
  if (/^https:\/\//.test(d.jumpUrl || '')) out.push('估价 / 回收入口：' + d.jumpUrl);
  return out.join('\n');
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

  // 转转 MCP（Streamable HTTP）：initialize 一次拿会话，之后 tools/call；会话失效重连一次
  let zzSid = null;
  async function zzRpc(tok, method, params, notify) {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer ' + tok };
    if (zzSid) headers['mcp-session-id'] = zzSid;
    const body = { jsonrpc: '2.0', method, params }; if (!notify) body.id = Date.now();
    let r;
    try { r = await fetch(ZZ_MCP, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) }); }
    catch (e) { throw new Error('连不上转转（' + (e.cause?.code || e.message) + '）'); }
    if (r.status === 401 || r.status === 403) throw new Error('转转凭证失效或过期（30 天有效），要到 open.zhuanzhuan.com 登录后重新拿凭证');
    zzSid = r.headers.get('mcp-session-id') || zzSid;
    const txt = await r.text();
    if (!r.ok) throw Object.assign(new Error('转转出错（' + r.status + '）'), { retry: true });
    if (notify) return null;
    const line = /^\s*[{[]/.test(txt) ? txt : txt.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5)).pop() || '';
    let j; try { j = JSON.parse(line); } catch { throw Object.assign(new Error('转转返回看不懂'), { retry: true }); }
    if (j.error) throw Object.assign(new Error('转转：' + (j.error.message || j.error.code)), { retry: true });
    return j.result;
  }
  async function zzCall(name, args) {
    const tok = zzToken(); if (!tok) throw new Error('这台电脑没有接转转（没有转转凭证）');
    for (let i = 0; ; i++) {
      try {
        if (!zzSid) {
          await zzRpc(tok, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claclaw', version: '1' } });
          await zzRpc(tok, 'notifications/initialized', {}, true);
        }
        const res = await zzRpc(tok, 'tools/call', { name, arguments: args });
        const text = (res?.content || []).map(c => c.text || '').join('');
        if (res?.isError) throw new Error('转转：' + (text.slice(0, 200) || '出错'));
        return text;
      } catch (e) { zzSid = null; if (!e.retry || i) throw e; }
    }
  }
  async function searchZz(keyword, sort, n, min, max) {
    const text = await zzCall('search', { keyword, priceOrder: ZZ_SORTS[sort] ?? 0, priceRange: zzRange(min, max) });
    let j; try { j = JSON.parse(text || '{}'); } catch { throw new Error('转转：' + text.slice(0, 200)); }
    for (const g of j.items || []) if (g.infoId && g.jumpUrl) zzRemember(g);
    const items = (j.items || []).map(zzItem).filter(x => x.title && x.price > 0 && /^https:\/\//.test(x.url));
    return resort(items, ZZ_SORTS[sort] === 2 ? 9 : ZZ_SORTS[sort] === 3 ? 10 : 0).slice(0, n);   // 转转的价格排序也不严格，本机再排一次
  }

  // 搜过的转转商品记下内部参数（查详情要原样带回），按卡片链接或商品 ID 找
  const zzRefs = new Map();
  function zzRemember(g) {
    const ref = { infoId: String(g.infoId), metric: String(g.metric || ''), businessType: String(g.businessType || '') };
    zzRefs.delete(g.jumpUrl); zzRefs.set(g.jumpUrl, ref); zzRefs.set(ref.infoId, ref);
    while (zzRefs.size > 600) zzRefs.delete(zzRefs.keys().next().value);
  }
  // 本地图片先传到转转的免登录上传口，拿 fileIdStr（字符串，64 位 ID 不能转数字）
  async function zzUpload(file) {
    let buf; try { buf = fs.readFileSync(file); } catch { throw new Error('读不到图片：' + path.basename(file)); }
    const ext = MAGIC.find(([, f]) => f(buf))?.[0];
    if (!ext) throw new Error('不是图片：' + path.basename(file));
    if (buf.length > 10 * 1048576) throw new Error('图片超过 10MB：' + path.basename(file));
    const fd = new FormData(); fd.append('multipartFile', new Blob([buf], { type: TYPE[ext] }), path.basename(file).replace(/\.[^.]*$/, '') + '.' + ext);
    let j; try { j = await (await fetch(ZZ_UPLOAD, { method: 'POST', body: fd, signal: AbortSignal.timeout(30000) })).json(); } catch { j = null; }
    const id = j && (j.respCode ?? j.code) === 0 ? (j.respData || j.data || {}).fileIdStr : '';
    if (!id || typeof id !== 'string') throw new Error('图片传不上转转：' + path.basename(file));
    return id;
  }
  const zzJson = t => { const i = t.indexOf('{', Math.max(0, t.indexOf('Original Response'))); try { return JSON.parse(t.slice(i)); } catch { return null; } };
  const zzTidy = t => String(t || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 9000);
  // 转转的其他能力：行情（market）、商品详情（detail）、回收估价（recycle）、业务问答（ask）。返回给 AI 读的说明文字
  async function zz({ action, text = '', link = '', images = [], params } = {}) {
    text = String(text || '').trim().slice(0, 500);
    try {
      if (action === 'market' || action === 'ask') {
        if (!text) return { ok: false, error: action === 'market' ? '没有型号' : '没有问题' };
        const ck = ['zz-' + action, text].join('|'), hit = cache.get(ck);
        if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, text: hit.items, cached: true };
        const out = zzTidy(action === 'market' ? await zzCall('market_price', { keyword: text, userIntent: text }) : await zzCall('knowledge_search', { query: text.slice(0, 200) }));
        cache.set(ck, { at: Date.now(), items: out });
        return { ok: true, text: out };
      }
      if (action === 'detail') {
        const k = String(link || text).trim(), ref = zzRefs.get(k) || zzRefs.get((/infoId=(\d+)/.exec(k) || [])[1] || '');
        if (!ref) return { ok: false, error: '找不到这件商品：先用 --platform 转转 搜一次，再拿卡片上的链接查详情' };
        return { ok: true, text: zzTidy(await zzCall('product_detail', ref)) };
      }
      if (action === 'recycle') {
        const urls = [], ids = [];
        for (const im of (Array.isArray(images) ? images : []).slice(0, 10)) /^https?:\/\//.test(im) ? urls.push(im) : ids.push(await zzUpload(im));
        if (!text && !urls.length && !ids.length) return { ok: false, error: '没有描述也没有图片' };
        const rec = await zzCall('recognize_model', { ...(text ? { query: text, userOrigPrompt: text } : {}), ...(urls.length ? { picUrls: urls } : {}), ...(ids.length ? { picFileIds: ids } : {}) });
        const d = zzJson(rec)?.data, top = d?.top1, full = !!(d?.recognized && top?.modelId);
        if (!full && !(top?.cateId && top?.brandId)) return { ok: true, text: '没认出是什么商品' + (d ? '' : '（' + zzTidy(rec).slice(0, 200) + '）') + '：请用户说清品牌和型号，或换张能看清的照片。' };
        const nm = c => String(c.displayName || '').startsWith(c.brandName) ? c.displayName : c.brandName + ' ' + c.displayName;
        const others = full ? (d.candidates || []).filter(c => c.modelId && c.modelId !== top.modelId).slice(0, 3).map(nm) : [];
        const ev = await zzCall('evaluate_price', { query: text || top.displayName || top.brandName, cateId: top.cateId, brandId: top.brandId, ...(full ? { modelId: top.modelId, modelName: top.modelName } : {}),
          ...(text ? { userOrigPrompt: text } : {}), ...(params && typeof params === 'object' ? { confirmedParams: params } : {}) });
        const ed = zzJson(ev)?.data;
        const head = full ? '识别型号：' + nm(top) + (others.length ? '（其他可能：' + others.join('、') + '）' : '')
          : '只认出品牌：' + top.brandName + '（' + top.cateName + '），没认出具体型号；请用户换个说法（如「华为 Mate 40 Pro 8+256G」）或发照片，也可以点回收入口自己选型号。';
        return { ok: true, text: head + '\n' + (ed ? zzValuation(ed) : zzTidy(ev)) };
      }
      return { ok: false, error: '不认识的操作' };
    } catch (e) { log('shop', '转转', action, 'error', e.message); return { ok: false, error: e.message }; }
  }

  async function search({ keyword, sort = '综合', n = 6, min, max, platform } = {}) {
    keyword = String(keyword || '').trim().slice(0, 60);
    if (!keyword) return { ok: false, error: '没有关键词' };
    const zz = /^(转转|zz|zhuanzhuan)$/i.test(String(platform || '').trim());
    const st = SORTS[sort] ?? 0; n = Math.max(1, Math.min(Number(n) || 6, 10));
    min = Math.max(0, Number(min) || 0); max = Math.max(0, Number(max) || 0);
    const ck = [zz ? 'zz' : 'pdd', keyword, zz ? sort : st, n, min, max].join('|'), hit = cache.get(ck);
    if (hit && Date.now() - hit.at < CACHE_MS) return { ok: true, items: hit.items, cached: true };
    if (!zz && Date.now() < coolUntil) return { ok: false, error: '拼多多暂时限制了查询，' + Math.ceil((coolUntil - Date.now()) / 60e3) + ' 分钟后再试' };
    try {
      const items = zz ? await searchZz(keyword, sort, n, min, max) : keys() ? await searchDirect(keyword, st, n, min, max) : await searchPublic(keyword, sort, n, min, max);
      for (const [k, v] of cache) if (Date.now() - v.at > CACHE_MS) cache.delete(k);
      cache.set(ck, { at: Date.now(), items });
      log('shop', zz ? '转转' : '拼多多', keyword, sort, '→', items.length);
      return { ok: true, items };
    } catch (e) { log('shop', keyword, 'error', e.message); return { ok: false, error: e.message }; }
  }
  return { search, zz };
}

// ---- 商品图代理 ----
const IMG_HOST = /(^|\.)(pddpic\.com|yangkeduo\.com|zhuanstatic\.com)$/i;
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
