#!/usr/bin/env node
// claw-stock：查 A 股行情（沪深京的个股、指数、场内基金）。只给数据，不给买卖建议。
//   claw-stock "贵州茅台"            现价、涨跌、成交、估值 + 近 60 个交易日走势（名字、简称、拼音首字母、6 位代码都行）
//   claw-stock k 茅台 [--days 120]   一段时间的走势：区间涨跌、最高最低、均线、最近 5 天
//   claw-stock cmp 茅台 五粮液 …      几只放一起比（2～6 只）
//   claw-stock find 平安             这个名字对得上哪几只（重名、不确定代码时）
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
const head = q => `**${q.name}** \`${q.code}\` · ${boardOf(q.mkt, q.code, q.kind)}`;
const priceLine = q => `**${q.price}** ${arrow(q.chg)} ${q.chg > 0 ? '+' : ''}${fx(q.chg, dp(q.price))}（${pctStr(q.pct)}） · ${q.time}（${phase(q.time)}）`;
const others = cands => cands.length > 1 && !cands[0].exact ? '\n\n名字相近的还有：' + cands.slice(1, 5).map(c => `${c.name} \`${c.code}\``).join('、') + '。要看哪只，把名字或代码说全。' : '';

export function renderQuote(q, ks, cands = []) {
  const d = dp(q.price), idx = q.kind === '指数', rows1 = [[fx(q.open, d), fx(q.high, d), fx(q.low, d), fx(q.prev, d), q.amp == null ? '—' : q.amp.toFixed(2) + '%']];
  const out = [head(q), '', priceLine(q), '', table(['今开', '最高', '最低', '昨收', '振幅'], rows1), ''];
  out.push(idx ? table(['成交量', '成交额'], [[volStr(q.vol), money(q.amount)]])
    : q.kind === '基金' ? table(['成交额', '换手率', '规模'], [[money(q.amount), q.turn == null ? '—' : q.turn.toFixed(2) + '%', money(q.cap)]])
    : table(['成交额', '换手率', '市盈率 TTM', '市净率', '总市值'], [[money(q.amount), q.turn == null ? '—' : q.turn.toFixed(2) + '%', q.pe == null || q.pe <= 0 ? '—（亏损或没有）' : q.pe.toFixed(2), fx(q.pb), money(q.cap)]]));
  if (ks.length > 2) {   // ks 多带了前一天那根：涨跌从它的收盘价算起，和 cmp 的「近 N 日」是同一个算法
    const w = ks.slice(1), lo = Math.min(...w.map(k => k.low)), hi = Math.max(...w.map(k => k.high));
    out.push('', `近 ${w.length} 个交易日 ${spark(w.map(k => k.close))} ${pctStr((w.at(-1).close / ks[0].close - 1) * 100)}，最低 ${fx(lo, d)}、最高 ${fx(hi, d)}${idx ? '' : '（前复权）'}`);
  }
  return out.join('\n') + others(cands) + '\n\n' + NOTE;
}
export function renderK(q, all, days, cands = []) {
  const ks = all.slice(-days), d = dp(q.price), last = ks.at(-1), hi = ks.reduce((a, k) => k.high > a.high ? k : a), lo = ks.reduce((a, k) => k.low < a.low ? k : a);
  const dayPct = ks.map((k, i) => i ? { date: k.date, p: (k.close / ks[i - 1].close - 1) * 100 } : null).filter(Boolean), up = dayPct.reduce((a, b) => b.p > a.p ? b : a, dayPct[0]), dn = dayPct.reduce((a, b) => b.p < a.p ? b : a, dayPct[0]);
  const amt = ks.filter(k => k.amount != null), ma = n => { const v = sma(all, n); return v == null ? `MA${n} 数据不够` : `MA${n} ${fx(v, d)}（现价在它${last.close >= v ? '上方' : '下方'} ${Math.abs((last.close / v - 1) * 100).toFixed(1)}%）`; };
  const out = [head(q), '', priceLine(q), '', `**${ks[0].date} ～ ${last.date}，${ks.length} 个交易日**${q.kind === '指数' ? '' : '（前复权）'}`, '', spark(ks.map(k => k.close), 40), '',
    table(['区间涨跌', '最高', '最低', '单日最大涨', '单日最大跌', '日均成交额'], [[pctStr((last.close / ks[0].close - 1) * 100), `${fx(hi.high, d)}（${hi.date.slice(5)}）`, `${fx(lo.low, d)}（${lo.date.slice(5)}）`,
      up ? `${pctStr(up.p)}（${up.date.slice(5)}）` : '—', dn ? `${pctStr(dn.p)}（${dn.date.slice(5)}）` : '—', amt.length ? money(amt.reduce((s, k) => s + k.amount, 0) / amt.length) : '—']]), '',
    '均线：' + [5, 20, 60].map(ma).join('；'), '', '最近 5 个交易日：', '',
    table(['日期', '开', '收', '高', '低', '涨跌', '成交额'], ks.slice(-5).map(k => { const i = all.indexOf(k), p = i > 0 ? (k.close / all[i - 1].close - 1) * 100 : null; return [k.date, fx(k.open, d), fx(k.close, d), fx(k.high, d), fx(k.low, d), pctStr(p), money(k.amount)]; }))];
  return out.join('\n') + others(cands) + '\n\n' + NOTE;
}
export function renderCmp(items) {
  const rows = items.map(({ q, ks }) => [`${q.name} \`${q.code}\``, q.price, pctStr(q.pct), pctStr(chgOver(ks, 20)), pctStr(chgOver(ks, 60)), q.pe == null || q.pe <= 0 ? '—' : q.pe.toFixed(1), fx(q.pb), money(q.cap)]);
  return table(['名称', '现价', '今日', '近 20 日', '近 60 日', '市盈率 TTM', '市净率', '总市值'], rows) + `\n\n报价时间 ${items[0].q.time}（${phase(items[0].q.time)}）；近 20 / 60 日按交易日算，前复权。\n\n` + NOTE;
}

// ---------- 命令 ----------
const warn = m => process.stderr.write('[claw-stock] ' + m + '\n');
// 不直接 process.exit：Windows 上请求还没收尾就退出，libuv 会断言失败（退出码变成 127）。抛出去，最外层设退出码
class Stop extends Error { constructor(code, m) { super(m); this.code = code; } }
const die = (code, m) => { throw new Stop(code, m); };
const USAGE = `用法：
  claw-stock "贵州茅台"            现价、涨跌、成交、估值 + 近 60 个交易日走势（名字、简称、6 位代码都行）
  claw-stock k 茅台 [--days 120]   一段时间的走势（默认 60 个交易日，最多 500）
  claw-stock cmp 茅台 五粮液 …      几只放一起比（2～6 只）
  claw-stock find 平安             这个名字对得上哪几只
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
    process.stderr.write((e instanceof Stop ? e.message : '行情接口暂时没通（' + (e.cause?.code || e.message) + '），过一会儿再试。不要自己编数字。') + '\n');
    process.exitCode = e instanceof Stop ? e.code : 2;
  });
