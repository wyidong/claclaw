#!/usr/bin/env node
// claw-stock：查 A 股行情（沪深京的个股、指数、场内基金）。只给数据，不给买卖建议。
//   claw-stock "贵州茅台"            现价、涨跌、成交、估值 + 近 60 个交易日走势（名字、简称、拼音首字母、6 位代码都行）
//   claw-stock k 茅台 [--days 120]   一段时间的走势：区间涨跌、最高最低、均线、最近 5 天
//   claw-stock cmp 茅台 五粮液 …      几只放一起比（2～6 只）
//   claw-stock find 平安             这个名字对得上哪几只（重名、不确定代码时）
//   claw-stock flow [细分] [--days 5] 行业板块的主力资金：净流入最多、净流出最多的板块（大类 31 个 / 细分一百多个；当日、近 5 日、近 10 日）
//   claw-stock top [跌|成交额] [板块]  涨幅榜 / 跌幅榜 / 成交额榜：涨跌幅榜按板块分开排（主板 10%、创业板和科创板 20%、北交所 30%，上限不一样）
// 输出 ```stock 代码块：claclaw 画成行情卡片（红涨绿跌、走势折线，public/index.html 的 mdStock）；find 输出 Markdown 表格。
// 来源（都是公开行情页面用的接口，不用登录、没有签名）：
//   报价 腾讯证券 qt.gtimg.cn；日 K 东方财富 push2his（前复权），不通时换腾讯；找代码 腾讯 smartbox，没有时换东方财富（北交所只有它按名字找得到）
// 单位（两家不一样，这里统一）：成交量 = 手，成交额 = 元，市值 = 元。
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36' };
const NOTE = '数据来自腾讯证券、东方财富的公开行情，可能有延迟；只是数据，不是投资建议。';
async function get(url, enc = 'utf-8') {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return new TextDecoder(enc).decode(await r.arrayBuffer());
}

// ---------- 代码和市场 ----------
// 6 位代码属于哪个市场（只认个股和场内基金；指数代码会和个股撞，比如 000001 是平安银行也是上证指数，指数要按名字找）
export function marketOf(code) {
  if (!/^\d{6}$/.test(code)) return '';
  if (/^(6|5|9(?!2))/.test(code)) return 'sh';        // 60x 68x 主板 / 科创板，5xx 基金，900 B 股
  if (/^(92|8|4)/.test(code)) return 'bj';             // 北交所：920 新代码，8xx / 4xx 老代码
  if (/^(0|3|1|2)/.test(code)) return 'sz';            // 00x 主板，30x 创业板，1xx 基金，200 B 股
  return '';
}
// 光看代码只认得出场内基金（沪 5xxxxx、深 1xxxxx）；指数和个股的代码会撞，看不出
export const kindOfCode = (mkt, code) => (mkt === 'sh' && /^5/.test(code)) || (mkt === 'sz' && /^1/.test(code)) ? '基金' : '';
const KIND = { 'GP-A': '个股', GP: '个股', ZS: '指数', ETF: '基金', LOF: '基金', FJ: '基金' };
export const boardOf = (mkt, code, kind) => kind === '指数' ? '指数' : kind === '基金' ? '场内基金'
  : mkt === 'bj' ? '北交所' : /^68/.test(code) ? '科创板' : /^30/.test(code) ? '创业板' : mkt === 'sh' ? '沪市主板' : '深市主板';

// 用户的说法 → 要找的名字：去掉「查一下」「的股价」「今天怎么样」这类话
export const cleanQuery = s => String(s || '').trim()
  .replace(/^(帮我|请|麻烦)?(查一下|查查|查询|查|看一下|看看|看|搜一下|搜|找一下|找)(一下)?/, '')
  .replace(/(今天|现在|最近|目前|近期)?的?(股价|股票|行情|走势|报价|价格|涨跌|k线|K线|日线)?(是多少|多少钱?|怎么样|如何|咋样|怎样)?[?？。！!\s]*$/, '')
  .replace(/^(股票|a股|A股)\s*/, '').trim();

// 腾讯 smartbox：v_hint="sh~600519~贵州…~gzmt~GP-A^…"；没有是 "N"
export function parseHint(text) {
  const m = /v_hint="([^"]*)"/.exec(text || '');
  if (!m || m[1] === 'N') return [];
  const un = s => s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\/g, '');
  return m[1].split('^').map(x => x.split('~')).filter(f => f.length >= 5 && /^(sh|sz|bj)$/.test(f[0]) && /^\d{6}$/.test(f[1]) && KIND[f[4]])
    .filter(f => !/^98/.test(f[1]))                                          // 988xxx：指数的外币版本，不要
    .map(f => ({ mkt: f[0], code: f[1], name: un(f[2]), py: f[3], kind: KIND[f[4]] }));
}
// 东方财富 suggest：只留沪深京的个股、指数、基金（三板、港美股不要）
export function parseSuggest(j) {
  return (j?.QuotationCodeTable?.Data || []).map(d => {
    const kind = d.Classify === 'Index' ? '指数' : d.Classify === 'Fund' ? '基金' : /^(沪A|深A|京A|科创板|创业板)$/.test(d.SecurityTypeName || '') ? '个股' : '';
    const mkt = d.SecurityTypeName === '京A' ? 'bj' : String(d.QuoteID || '').startsWith('1.') ? 'sh' : 'sz';
    return kind && /^\d{6}$/.test(d.Code || '') ? { mkt, code: d.Code, name: d.Name, py: String(d.PinYin || '').toLowerCase(), kind } : null;
  }).filter(Boolean);
}
// 排序：名字一模一样最先，其次名字以它开头、包含；同分时个股在前、指数其次、基金最后（用户说了「指数」「ETF」就反过来）
export function rank(list, q) {
  const n = s => String(s).toLowerCase().replace(/\s/g, ''), k = n(q);
  const want = /指数|指$|综指|成指/.test(q) ? '指数' : /etf|lof|基金|reit/i.test(q) ? '基金' : '个股';
  const sc = x => { const a = n(x.name); return (a === k || x.code === k || x.py === k ? 100 : a.startsWith(k) ? 70 : a.includes(k) || k.includes(a) ? 50 : 20) + (x.kind === want ? 9 : x.kind === '个股' ? 5 : x.kind === '指数' ? 3 : 0); };
  return list.map((x, i) => ({ x, s: sc(x), i })).sort((a, b) => b.s - a.s || a.i - b.i).map(o => ({ ...o.x, exact: o.s >= 100 }));
}
async function search(q) {
  let list = [];
  try { list = parseHint(await get('https://smartbox.gtimg.cn/s3/?v=2&t=all&q=' + encodeURIComponent(q))); } catch (e) { warn('腾讯搜索没通：' + e.message); }
  if (!list.some(x => x.name.replace(/\s/g, '') === q.replace(/\s/g, ''))) {   // 腾讯没有一模一样的（北交所、刚上市的）：再问东方财富，合在一起
    try { const more = parseSuggest(JSON.parse(await get('https://searchapi.eastmoney.com/api/suggest/get?type=14&count=8&input=' + encodeURIComponent(q)))); for (const m of more) if (!list.some(x => x.code === m.code && x.mkt === m.mkt)) list.push(m); }
    catch (e) { warn('东方财富搜索没通：' + e.message); }
  }
  return rank(list, q);
}
// 一句话 → 候选（第一个是最像的）。写了 6 位代码的直接用，不搜
async function resolve(raw) {
  const q = cleanQuery(raw), m = /^(sh|sz|bj)?\.?(\d{6})$/i.exec(q);
  if (m) { const mkt = (m[1] || marketOf(m[2])).toLowerCase(); return mkt ? [{ mkt, code: m[2], name: '', kind: kindOfCode(mkt, m[2]), exact: true }] : []; }
  return q ? search(q) : [];
}

// ---------- 报价（腾讯）----------
// v_sh600519="1~贵州茅台~600519~现价~昨收~今开~成交量(手)~…~30:时间~31:涨跌~32:涨跌%~33:最高~34:最低~…~37:成交额(万)~38:换手%~39:市盈率TTM~…~43:振幅%~44:流通市值(亿)~45:总市值(亿)~46:市净率~47:涨停~48:跌停"
export function parseQuote(text) {
  const out = {};
  for (const m of String(text || '').matchAll(/v_(sh|sz|bj)(\d{6})="([^"]*)"/g)) {
    const f = m[3].split('~'); if (f.length < 40 || !f[1]) continue;
    const num = i => { const v = parseFloat(f[i]); return Number.isFinite(v) ? v : null; }, t = f[30] || '';
    out[m[1] + m[2]] = { mkt: m[1], code: m[2], name: f[1].replace(/\s/g, ''), price: f[3], prev: num(4), open: num(5), vol: num(6), chg: num(31), pct: num(32), high: num(33), low: num(34),
      amount: num(37) == null ? null : num(37) * 1e4, turn: num(38), pe: num(39), amp: num(43), fcap: num(44) == null ? null : num(44) * 1e8, cap: num(45) == null ? null : num(45) * 1e8, pb: num(46), up: num(47), down: num(48),
      time: /^\d{14}$/.test(t) ? `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}` : '' };
  }
  return out;
}
async function quotes(list) {
  const all = parseQuote(await get('https://qt.gtimg.cn/q=' + list.map(x => x.mkt + x.code).join(','), 'gbk'));
  return list.map(x => all[x.mkt + x.code] ? { ...all[x.mkt + x.code], kind: x.kind || (all[x.mkt + x.code].pe == null && all[x.mkt + x.code].cap == null ? '指数' : '个股') } : null);
}
// 这个报价是盘中的还是收盘的：按北京时间看（9:15～15:00 的交易日当天算盘中）
export function phase(time, now = new Date()) {
  if (!time) return '';
  const bj = new Date(now.getTime() + 8 * 3600e3).toISOString(), today = bj.slice(0, 10), hm = bj.slice(11, 16);
  return time.slice(0, 10) === today && hm >= '09:15' && hm < '15:00' ? '盘中' : time.slice(0, 10) === today ? '今日收盘' : '收盘价，最近一个交易日';
}

// ---------- 日 K ----------
// 东方财富：前复权，一行「日期,开,收,高,低,成交量(手),成交额(元)」
export const parseKEm = j => (j?.data?.klines || []).map(l => { const f = l.split(','); return { date: f[0], open: +f[1], close: +f[2], high: +f[3], low: +f[4], vol: +f[5], amount: +f[6] }; }).filter(k => k.date && Number.isFinite(k.close));
// 腾讯：个股在 qfqday、指数在 day，一行 [日期,开,收,高,低,成交量(手)]，没有成交额
export const parseKTx = (j, sym) => { const d = j?.data?.[sym] || {}; return (d.qfqday || d.day || []).map(f => ({ date: f[0], open: +f[1], close: +f[2], high: +f[3], low: +f[4], vol: +f[5], amount: null })).filter(k => k.date && Number.isFinite(k.close)); };
async function kline(x, n) {
  try {
    const k = parseKEm(JSON.parse(await get(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${x.mkt === 'sh' ? 1 : 0}.${x.code}&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56,f57&klt=101&fqt=1&end=20500101&lmt=${n}`)));
    if (k.length) return k;
  } catch (e) { warn('东方财富日 K 没通：' + e.message); }
  const sym = x.mkt + x.code;
  return parseKTx(JSON.parse(await get(`https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${sym},day,,,${n},qfq`)), sym);
}

// ---------- 计算和排版 ----------
export const sma = (ks, n) => ks.length < n ? null : ks.slice(-n).reduce((s, k) => s + k.close, 0) / n;
// 小走势图：一串 ▁▂▃▄▅▆▇█，最多 w 个字（多了按段取每段最后一天）
export function spark(vals, w = 30) {
  const v = vals.filter(Number.isFinite); if (v.length < 2) return '';
  const pick = v.length <= w ? v : Array.from({ length: w }, (_, i) => v[Math.round((i + 1) * v.length / w) - 1]);
  const lo = Math.min(...pick), hi = Math.max(...pick);
  return pick.map(x => '▁▂▃▄▅▆▇█'[hi === lo ? 3 : Math.min(7, Math.floor((x - lo) / (hi - lo) * 8))]).join('');
}
const dp = p => Math.min(3, (String(p).split('.')[1] || '').length || 2);                       // 小数位跟着现价走（基金 3 位）
const fx = (v, d = 2) => v == null || !Number.isFinite(v) ? '—' : v.toFixed(d);
export const pctStr = v => v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(2) + '%';
export const arrow = v => v > 0 ? '▲' : v < 0 ? '▼' : '—';
export const money = v => v == null || !Number.isFinite(v) ? '—' : Math.abs(v) >= 1e12 ? (v / 1e12).toFixed(2) + ' 万亿' : Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿' : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(0) + ' 万' : v.toFixed(0);
const volStr = v => v == null ? '—' : v >= 1e8 ? (v / 1e8).toFixed(2) + ' 亿手' : v >= 1e4 ? (v / 1e4).toFixed(1) + ' 万手' : v.toFixed(0) + ' 手';
const chgOver = (ks, n) => ks.length > n ? (ks.at(-1).close / ks.at(-1 - n).close - 1) * 100 : null;      // 近 n 个交易日涨跌
const table = (heads, rows) => ['| ' + heads.join(' | ') + ' |', '|' + heads.map(() => ' --- ').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
// 输出是 ```stock 代码块，claclaw 画成行情卡片（红涨绿跌、走势折线）。一行一条，字段用 | 分开，旧页面当代码显示也看得懂：
//   股 | 名称 | 代码 | 板块 | 现价 | 涨跌 | 涨跌幅 | 报价时间和说明
//   项 | 名字 | 值 | 颜色（+ 红、- 绿、空着不上色）| 小字说明
//   势 | 标题 | 涨跌幅 | 说明 | 收盘价，逗号分开（画折线）
//   日 | 日期 | 开 | 收 | 高 | 低 | 涨跌幅 | 成交额
//   比 | 名称 | 代码 | 现价 | 今日 | 近 20 日 | 近 60 日 | 市盈率 | 市净率 | 总市值
//   注 | 一句说明
const row = (...f) => f.map(x => String(x ?? '').replace(/\|/g, '｜').replace(/\s*\n\s*/g, ' ')).join(' | ').replace(/(\s*\|)+\s*$/, '');   // 末尾空着的字段不写
const block = lines => '```stock\n' + lines.filter(Boolean).join('\n') + '\n```';
const sign = v => v > 0 ? '+' : v < 0 ? '-' : '';
const signed = (v, d) => v == null || !Number.isFinite(v) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
const headRow = q => row('股', q.name, q.code, boardOf(q.mkt, q.code, q.kind), q.price, signed(q.chg, dp(q.price)), pctStr(q.pct), `${q.time} · ${phase(q.time)}`);
const vs = (v, q) => v == null || q.prev == null ? '' : sign(v - q.prev);                        // 今开、最高、最低：比昨收高是红、低是绿
// 折线用的收盘价：最多 80 个点（多了按段取每段最后一天）
const pts = (ks, d, w = 80) => { const v = ks.map(k => k.close), p = v.length <= w ? v : Array.from({ length: w }, (_, i) => v[Math.round((i + 1) * v.length / w) - 1]); return p.map(x => x.toFixed(d)).join(','); };
const othersRow = cands => cands.length > 1 && !cands[0].exact ? row('注', '名字相近的还有：' + cands.slice(1, 5).map(c => `${c.name} ${c.code}`).join('、') + '。要看哪只，把名字或代码说全。') : '';

export function renderQuote(q, ks, cands = []) {
  const d = dp(q.price), idx = q.kind === '指数', out = [headRow(q),
    row('项', '今开', fx(q.open, d), vs(q.open, q)), row('项', '最高', fx(q.high, d), vs(q.high, q)), row('项', '最低', fx(q.low, d), vs(q.low, q)), row('项', '昨收', fx(q.prev, d)), row('项', '振幅', q.amp == null ? '—' : q.amp.toFixed(2) + '%')];
  if (idx) out.push(row('项', '成交量', volStr(q.vol)), row('项', '成交额', money(q.amount)));
  else {
    out.push(row('项', '成交额', money(q.amount)), row('项', '换手率', q.turn == null ? '—' : q.turn.toFixed(2) + '%'));
    if (q.kind === '基金') out.push(row('项', '规模', money(q.cap)));
    else out.push(row('项', '市盈率 TTM', q.pe == null || q.pe <= 0 ? '—' : q.pe.toFixed(2), '', q.pe != null && q.pe <= 0 ? '亏损' : ''), row('项', '市净率', fx(q.pb)), row('项', '总市值', money(q.cap)));
  }
  if (ks.length > 2) {   // ks 多带了前一天那根：涨跌从它的收盘价算起，和 cmp 的「近 N 日」是同一个算法
    const w = ks.slice(1), lo = Math.min(...w.map(k => k.low)), hi = Math.max(...w.map(k => k.high));
    out.push(row('势', `近 ${w.length} 个交易日`, pctStr((w.at(-1).close / ks[0].close - 1) * 100), `最低 ${fx(lo, d)} · 最高 ${fx(hi, d)}${idx ? '' : ' · 前复权'}`, pts(w, d)));
  }
  return block([...out, othersRow(cands), row('注', NOTE)]);
}
export function renderK(q, all, days, cands = []) {
  const ks = all.slice(-days), d = dp(q.price), last = ks.at(-1), hi = ks.reduce((a, k) => k.high > a.high ? k : a), lo = ks.reduce((a, k) => k.low < a.low ? k : a), total = (last.close / ks[0].close - 1) * 100;
  const dayPct = ks.map((k, i) => i ? { date: k.date, p: (k.close / ks[i - 1].close - 1) * 100 } : null).filter(Boolean), up = dayPct.reduce((a, b) => b.p > a.p ? b : a, dayPct[0]), dn = dayPct.reduce((a, b) => b.p < a.p ? b : a, dayPct[0]);
  const amt = ks.filter(k => k.amount != null);
  const ma = n => { const v = sma(all, n); return v == null ? row('项', 'MA' + n, '—', '', '数据不够') : row('项', 'MA' + n, fx(v, d), '', `现价在${last.close >= v ? '上方' : '下方'} ${Math.abs((last.close / v - 1) * 100).toFixed(1)}%`); };
  return block([headRow(q),
    row('势', `${ks[0].date} ～ ${last.date} · ${ks.length} 个交易日`, pctStr(total), q.kind === '指数' ? '' : '前复权', pts(ks, d)),
    row('项', '区间涨跌', pctStr(total), sign(total)), row('项', '最高', fx(hi.high, d), '', hi.date.slice(5)), row('项', '最低', fx(lo.low, d), '', lo.date.slice(5)),
    up && row('项', '单日最大涨', pctStr(up.p), sign(up.p), up.date.slice(5)), dn && row('项', '单日最大跌', pctStr(dn.p), sign(dn.p), dn.date.slice(5)),
    row('项', '日均成交额', amt.length ? money(amt.reduce((s, k) => s + k.amount, 0) / amt.length) : '—'), ma(5), ma(20), ma(60),
    ...ks.slice(-5).map(k => { const i = all.indexOf(k), p = i > 0 ? (k.close / all[i - 1].close - 1) * 100 : null; return row('日', k.date, fx(k.open, d), fx(k.close, d), fx(k.high, d), fx(k.low, d), pctStr(p), money(k.amount)); }),
    othersRow(cands), row('注', NOTE)]);
}
export function renderCmp(items) {
  return block([...items.map(({ q, ks }) => row('比', q.name, q.code, q.price, pctStr(q.pct), pctStr(chgOver(ks, 20)), pctStr(chgOver(ks, 60)), q.pe == null || q.pe <= 0 ? '—' : q.pe.toFixed(1), q.pb > 0 ? fx(q.pb) : '—', money(q.cap))),
    row('注', `报价时间 ${items[0].q.time} · ${phase(items[0].q.time)}；近 20 / 60 日按交易日算，前复权。`), row('注', NOTE)]);
}

// ---------- 板块资金流（东方财富）----------
// 行业板块的「主力净流入」：东方财富按大单成交估算的口径（超大单 + 大单的买入减卖出），不是真实的资金进出账，别家算出来不一样。
// 两个层级：大类（一级行业，31 个）、细分（二级行业，一百多个）。三个时长：当日、近 5 日、近 10 日。接口一页最多 100 条。
export const FLOW_LEVEL = { 大类: 'm:90+t:2+s:2', 细分: 'm:90+s:4' };
const FLOW_KEY = { 1: ['f62', 'f184', 'f3', '当日'], 5: ['f164', 'f165', 'f109', '近 5 日'], 10: ['f174', 'f175', 'f160', '近 10 日'] };   // 净流入额、净占比、涨跌幅
export const flowDays = n => !(n > 1) ? 1 : n <= 5 ? 5 : 10;                       // 只有这三档，说了别的天数取最近的一档
export const flowLevel = s => /细分|二级|子行业|细/.test(s || '') ? '细分' : '大类';
// 一条板块 → { name, net 元, share %, pct %, amount 元, lead 当日领流入的个股 }；没数的（停牌、刚设的板块，接口给 "-"）不要
export function parseFlow(j, days = 1) {
  const [kn, ks, kp] = FLOW_KEY[days], num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  return (j?.data?.diff || []).map(x => ({ code: x.f12, name: x.f14, net: num(x[kn]), share: num(x[ks]), pct: num(x[kp]), amount: num(x.f6), lead: days === 1 && typeof x.f204 === 'string' && x.f204 !== '-' ? x.f204 : '', ts: num(x.f124) }))
    .filter(x => x.name && x.net != null);
}
async function flow(level, days) {
  const url = pn => `https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=1&np=1&fltt=2&invt=2&fid=${FLOW_KEY[days][0]}&fs=${encodeURIComponent(FLOW_LEVEL[level])}&fields=f3,f6,f12,f14,f62,f184,f109,f164,f165,f160,f174,f175,f204,f124`;
  const first = JSON.parse(await get(url(1))), total = first?.data?.total || 0, list = parseFlow(first, days);
  for (let pn = 2; (pn - 1) * 100 < total && pn <= 5; pn++) list.push(...parseFlow(JSON.parse(await get(url(pn))), days));
  return list.sort((a, b) => b.net - a.net);
}
const yi = v => (v > 0 ? '+' : '') + (v / 1e8).toFixed(Math.abs(v) >= 1e10 ? 0 : 1) + ' 亿';
// 输出：题 | 标题 | 小字；段 | 小标题；流 | 名次 | 板块 | 主力净流入 | 净占比 | 涨跌幅 | 领流入的个股（只有当日有）
export function renderFlow(list, level, days, top = 10) {
  const label = FLOW_KEY[days][3], ts = Math.max(0, ...list.map(x => x.ts || 0)), at = ts ? new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
  const inN = list.filter(x => x.net > 0).length, outN = list.filter(x => x.net < 0).length, sum = list.reduce((s, x) => s + x.net, 0);
  const line = x => row('流', list.indexOf(x) + 1, x.name, yi(x.net), pctStr(x.share), pctStr(x.pct), x.lead);
  // 「净流入最多」下面只放真的净流入的，「净流出最多」下面只放真的净流出的：普涨、普跌的日子一边会不满，甚至没有
  const head = list.filter(x => x.net > 0).slice(0, top), tail = list.filter(x => x.net < 0).slice(-5).reverse();
  return block([row('题', `行业${level} · ${label}主力资金`, [at && at + ' · ' + phase(at).replace('收盘价，', ''), `${list.length} 个板块：${inN} 个净流入、${outN} 个净流出` + (level === '大类' ? `，合计 ${yi(sum)}` : '')].filter(Boolean).join(' · ')),
    row('段', head.length ? '净流入最多' : '没有净流入的板块'), ...head.map(line),
    row('段', tail.length ? '净流出最多' : '没有净流出的板块'), ...tail.map(line),
    row('注', '「主力净流入」是东方财富按大单成交估算的，不是真实的资金进出账，别家的数会不一样。' + (days > 1 ? '涨跌幅是这几天累计的。' : '')),
    row('注', '数据来自东方财富的公开行情，可能有延迟；只是数据，不是投资建议。')]);
}

// ---------- 涨幅榜 / 跌幅榜 / 成交额榜（东方财富）----------
// 各板块的涨跌幅上限不一样（主板 10%、创业板和科创板 20%、北交所 30%），放在一起排前面全是北交所，所以按板块分开排。
// 榜内的先后：涨停（跌停）的算并列，按成交额从大到小——它们的涨幅只差在价格取整上（10.00%～10.45%），按那个排没有意义；没涨停的再按涨幅。
// 涨幅超过上限的（新股上市头几天、恢复上市不设涨跌幅）排最前面，标出来。
export const BOARDS = [
  { key: '主板', name: '沪深主板', lim: 10, fs: 'm:1+t:2,m:0+t:6' },
  { key: '双创', name: '创业板 / 科创板', lim: 20, fs: 'm:0+t:80,m:1+t:23' },
  { key: '北交所', name: '北交所', lim: 30, fs: 'm:0+t:81+s:2048' }];
const ALL_A = BOARDS.map(b => b.fs).join(',');
export const topMode = s => /成交|活跃|额/.test(s || '') ? '成交额' : /跌/.test(s || '') ? '跌' : '涨';
export const topBoard = s => /北交|北证/.test(s || '') ? '北交所' : /创业|科创|双创/.test(s || '') ? '双创' : /主板/.test(s || '') ? '主板' : '';
export function parseTop(j) {
  const num = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  return (j?.data?.diff || []).map(x => ({ code: String(x.f12 || ''), name: String(x.f14 || '').replace(/\s/g, ''), price: num(x.f2), pct: num(x.f3), amount: num(x.f6), turn: num(x.f8),
    ind: typeof x.f100 === 'string' && x.f100 !== '-' ? x.f100.replace(/[ⅡⅢ]+$/, '') : '', listed: String(x.f26 || ''), ts: num(x.f124) })).filter(x => /^\d{6}$/.test(x.code) && x.name && x.pct != null && x.price != null);
}
// 一只在这个板块里算什么：超过上限的 = 不限幅（上市不到 30 天的写「新股」），到了上限的 = 涨停 / 跌停。上限留 0.1 个点的余量（取整）
export function limitTag(x, lim, today = new Date()) {
  const a = Math.abs(x.pct);
  if (a > lim + 0.6) { const d = /^\d{8}$/.test(x.listed) ? (today - new Date(`${x.listed.slice(0, 4)}-${x.listed.slice(4, 6)}-${x.listed.slice(6)}T00:00:00+08:00`)) / 864e5 : 999; return d < 30 ? '新股' : '不限幅'; }
  return a >= lim - 0.1 ? (x.pct > 0 ? '涨停' : '跌停') : '';
}
// 排好一个板块的榜：dir 1 涨幅榜、-1 跌幅榜。分三组：0 不限幅的（按涨幅）、1 涨停的（按成交额）、2 其余（按涨幅）
export function rankTop(list, lim, dir = 1, today = new Date()) {
  const side = x => dir > 0 ? x.pct > 0 : x.pct < 0;
  return list.map(x => { const tag = side(x) ? limitTag(x, lim, today) : ''; return { ...x, tag, g: tag === '新股' || tag === '不限幅' ? 0 : tag ? 1 : 2 }; })
    .sort((a, b) => a.g - b.g || (a.g === 1 ? (b.amount || 0) - (a.amount || 0) : dir * (b.pct - a.pct) || (b.amount || 0) - (a.amount || 0)));
}
const clist = async (fs, fid, po, pn) => JSON.parse(await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=${pn}&pz=100&po=${po}&np=1&fltt=2&invt=2&fid=${fid}&fs=${encodeURIComponent(fs)}&fields=f2,f3,f6,f8,f12,f14,f26,f100,f124`));
// 一个板块的涨（跌）幅榜：一页 100 只，往后翻到出现没涨停的为止（要数清涨停几只、把涨停的按成交额排），最多 10 页
async function boardTop(b, dir) {
  const all = []; let total = 0;
  for (let pn = 1; pn <= 10; pn++) {
    const j = await clist(b.fs, 'f3', dir > 0 ? 1 : 0, pn), page = parseTop(j); total = j?.data?.total || total; all.push(...page);
    if (page.length < 100 || page.some(x => dir * x.pct < b.lim - 0.1)) break;
  }
  const ranked = rankTop(all, b.lim, dir);
  return { ...b, total, list: ranked, limits: ranked.filter(x => x.tag === '涨停' || x.tag === '跌停').length };
}
// 全市场涨跌家数：上证指数、深证成指、北证 50 这三个指数的行情里带着所在市场的上涨 / 下跌 / 平盘家数
export const parseBreadth = j => { const d = j?.data?.diff || [], s = k => d.reduce((a, x) => a + (typeof x[k] === 'number' ? x[k] : 0), 0); return d.length ? { up: s('f104'), down: s('f105'), flat: s('f106') } : null; };
const breadth = async () => { try { return parseBreadth(JSON.parse(await get('https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=1.000001,0.399001,0.899050&fields=f12,f104,f105,f106'))); } catch (e) { warn('涨跌家数没拿到：' + e.message); return null; } };
// 输出：题 | 标题 | 小字；段 | 小标题；榜 | 名次 | 名称 | 代码 | 现价 | 涨跌幅 | 成交额 | 行业 | 标记（涨停 / 跌停 / 新股 / 不限幅）
export function renderTop(mode, secs, br, per) {
  const ts = Math.max(0, ...secs.flatMap(s => s.list.slice(0, per).map(x => x.ts || 0))), at = ts ? new Date(ts * 1000 + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : '';
  const what = mode === '成交额' ? '成交额榜' : mode === '跌' ? '跌幅榜' : '涨幅榜', lw = mode === '跌' ? '跌停' : '涨停';
  return block([row('题', what, [at && at + ' · ' + phase(at).replace('收盘价，', ''), br && `全市场上涨 ${br.up} 只、下跌 ${br.down} 只、平 ${br.flat} 只`].filter(Boolean).join(' · ')),
    // 涨幅榜只列真的涨了的、跌幅榜只列真的跌了的：普涨的日子有的板块一只下跌的都没有，这时照实写，不拿涨得少的来凑
    ...secs.map(s => ({ ...s, list: mode === '成交额' ? s.list : s.list.filter(x => mode === '跌' ? x.pct < 0 : x.pct > 0) })).flatMap(s => [
      row('段', mode === '成交额' ? s.name : s.list.length ? `${s.name} · ${lw}是 ${s.lim}% · ${lw} ${s.limits} 只` : `${s.name} · 没有${mode === '跌' ? '下跌' : '上涨'}的股票`),
      ...s.list.slice(0, per).map((x, i) => row('榜', i + 1, x.name, x.code, x.price.toFixed(2), pctStr(x.pct), money(x.amount), x.ind, x.tag))]),
    mode !== '成交额' && row('注', `各板块的涨跌幅上限不一样，所以分开排。${lw}的算并列，按成交额从大到小；没${lw}的再按${mode === '跌' ? '跌' : '涨'}幅。新股上市头几天不设上限，排在最前面。`),
    row('注', '数据来自东方财富的公开行情，可能有延迟；只是数据，不是投资建议。')]);
}

// ---------- 命令 ----------
const warn = m =>process.stderr.write('[claw-stock] ' + m + '\n');
// 不直接 process.exit：Windows 上请求还没收尾就退出，libuv 会断言失败（退出码变成 127）。抛出去，最外层设退出码
class Stop extends Error { constructor(code, m) { super(m); this.code = code; } }
const die = (code, m) => { throw new Stop(code, m); };
const USAGE = `用法：
  claw-stock "贵州茅台"            现价、涨跌、成交、估值 + 近 60 个交易日走势（名字、简称、6 位代码都行）
  claw-stock k 茅台 [--days 120]   一段时间的走势（默认 60 个交易日，最多 500）
  claw-stock cmp 茅台 五粮液 …      几只放一起比（2～6 只）
  claw-stock find 平安             这个名字对得上哪几只
  claw-stock flow [细分] [--days 5]  行业板块的主力资金：哪些板块净流入最多、最少（默认行业大类、当日；--days 5 或 10 看近几日）
  claw-stock top [跌|成交额] [主板|双创|北交所]  涨幅榜（默认）、跌幅榜、成交额榜；涨跌幅榜按板块分开排，写了板块只排那一个
  加 --json 输出给程序用的 JSON`;

async function one(raw) {                       // 一句话 → { q 报价, cands 候选 }；找不到退出 2
  const cands = await resolve(raw);
  if (!cands.length) die(2, `没找到「${cleanQuery(raw) || raw}」对应的 A 股（沪深京的个股、指数、场内基金）。港股、美股、场外基金这里查不了。`);
  const [q] = await quotes([cands[0]]);
  if (!q) die(2, `代码 ${cands[0].code} 没有行情：可能写错了，或者已经退市。`);
  return { q, cands };
}
async function main(argv) {
  const json = argv.includes('--json'), di = argv.indexOf('--days'), days = Math.max(5, Math.min(500, di >= 0 ? parseInt(argv[di + 1], 10) || 60 : 60));
  const rest = argv.filter((a, i) => a !== '--json' && a !== '--days' && !(di >= 0 && i === di + 1)), cmd = rest[0] || '';
  const say = (text, data) => process.stdout.write(json ? JSON.stringify(data) + '\n' : text + '\n');
  if (!cmd || cmd === '-h' || cmd === '--help') die(cmd ? 0 : 1, USAGE);
  if (cmd === 'flow') {
    const level = flowLevel(rest.slice(1).join(' ')), fd = flowDays(di >= 0 ? parseInt(argv[di + 1], 10) : 1), list = await flow(level, fd);
    if (!list.length) die(2, '没有拿到板块资金流（行情接口暂时没通，或者还没开盘）。不要自己编数字。');
    return say(renderFlow(list, level, fd), { level, days: fd, list });
  }
  if (cmd === 'top') {
    const arg = rest.slice(1).join(' '), mode = topMode(arg), only = topBoard(arg);
    let secs;
    if (mode === '成交额') {
      const b = BOARDS.find(x => x.key === only), list = parseTop(await clist(b ? b.fs : ALL_A, 'f6', 1, 1)).sort((x, y) => (y.amount || 0) - (x.amount || 0));
      secs = [{ name: b ? b.name : '全部 A 股', lim: b ? b.lim : 0, limits: 0, list: list.map(x => ({ ...x, tag: '' })) }];
    } else secs = await Promise.all(BOARDS.filter(b => !only || b.key === only).map(b => boardTop(b, mode === '跌' ? -1 : 1)));
    if (!secs.some(s => s.list.length)) die(2, '没有拿到排行（行情接口暂时没通，或者还没开盘）。不要自己编数字。');
    const per = secs.length > 1 ? 6 : 15;
    return say(renderTop(mode, secs, await breadth(), per), { mode, sections: secs.map(s => ({ name: s.name, limit: s.lim, limits: s.limits, list: s.list.slice(0, per) })) });
  }
  if (cmd === 'find') {
    const q = cleanQuery(rest.slice(1).join(' ')); if (!q) die(1, USAGE);
    const list = (await resolve(q)).filter(x => x.name).slice(0, 12);
    if (!list.length) die(2, `没有名字像「${q}」的 A 股。`);
    return say(table(['代码', '名称', '类型'], list.map(x => ['`' + x.code + '`', x.name, boardOf(x.mkt, x.code, x.kind)])), list);
  }
  if (cmd === 'cmp') {
    const names = rest.slice(1).flatMap(s => s.split(/[,，、]|\s+和\s+|\s+/)).map(s => s.trim()).filter(Boolean);
    if (names.length < 2 || names.length > 6) die(1, '要比的写 2～6 只，比如：claw-stock cmp 茅台 五粮液 泸州老窖');
    const items = await Promise.all(names.map(async n => { const { q } = await one(n); return { q, ks: await kline(q, 61).catch(() => []) }; }));
    return say(renderCmp(items), items);
  }
  if (cmd === 'k') {
    const name = rest.slice(1).join(' '); if (!name) die(1, USAGE);
    const { q, cands } = await one(name), all = await kline(q, Math.max(days, 60) + 1);
    if (all.length < 2) die(2, `${q.name} 没有拿到日 K（刚上市，或者行情接口暂时没通）。`);
    return say(renderK(q, all, Math.min(days, all.length), cands), { quote: q, days: all.slice(-days), ma5: sma(all, 5), ma20: sma(all, 20), ma60: sma(all, 60) });
  }
  const { q, cands } = await one(rest.join(' ')), ks = await kline(q, 61).catch(e => (warn('日 K 没拿到：' + e.message), []));
  say(renderQuote(q, ks, cands), { quote: q, days: ks, others: cands.slice(1, 5) });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2)).catch(e => {
    // 只有真的是网络 / 接口的事才说「没通」；程序自己的错照实说，免得让人白等
    const net = e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.name === 'SyntaxError' || /^HTTP \d+|fetch failed/.test(e?.message || '') || !!e?.cause?.code;
    process.stderr.write((e instanceof Stop ? e.message : net ? '行情接口暂时没通（' + (e.cause?.code || e.message) + '），过一会儿再试。不要自己编数字。' : 'claw-stock 出错了：' + (e?.message || e) + '。这是程序的问题，不是行情的问题；不要自己编数字。') + '\n');
    process.exitCode = e instanceof Stop ? e.code : 2;
  });
