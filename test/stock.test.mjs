// claw-stock 技能：解析、匹配、计算、排版（不联网：行情接口的返回用存下来的样子）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { marketOf, kindOfCode, boardOf, cleanQuery, parseHint, parseSuggest, rank, parseQuote, phase, parseKEm, parseKTx, sma, spark, pctStr, money, renderQuote, renderK, renderCmp, parseFlow, renderFlow, flowDays, flowLevel, FLOW_LEVEL, BOARDS, topMode, topBoard, parseTop, limitTag, rankTop, parseBreadth, renderTop } from '../skills/claw-stock/stock.mjs';
import { loadFills, routeFill } from '../src/claws/kuai-fill.mjs';

test('6 位代码属于哪个市场：沪 6/5/900，深 0/3/1/200，京 920/8/4', () => {
  assert.deepEqual(['600519', '688981', '510300', '900901'].map(marketOf), ['sh', 'sh', 'sh', 'sh']);
  assert.deepEqual(['000001', '300750', '159919', '200002'].map(marketOf), ['sz', 'sz', 'sz', 'sz']);
  assert.deepEqual(['920982', '830799', '430047'].map(marketOf), ['bj', 'bj', 'bj']);
  assert.deepEqual(['12345', 'abcdef', '700000'].map(marketOf), ['', '', '']);
});
test('板块：科创板、创业板、北交所；光看代码认得出场内基金', () => {
  assert.equal(boardOf('sh', '688981', '个股'), '科创板');
  assert.equal(boardOf('sz', '300750', '个股'), '创业板');
  assert.equal(boardOf('bj', '920982', '个股'), '北交所');
  assert.equal(boardOf('sh', '000001', '指数'), '指数');
  assert.equal(kindOfCode('sh', '510300'), '基金');
  assert.equal(kindOfCode('sz', '159919'), '基金');
  assert.equal(kindOfCode('sh', '600519'), '');
});
test('用户的说法 → 要找的名字', () => {
  assert.equal(cleanQuery('查一下宁德时代的股价'), '宁德时代');
  assert.equal(cleanQuery('茅台今天怎么样？'), '茅台');
  assert.equal(cleanQuery('看看比亚迪最近的走势'), '比亚迪');
  assert.equal(cleanQuery('600519'), '600519');
  assert.equal(cleanQuery('上证指数'), '上证指数');
  assert.equal(cleanQuery('帮我查查中国平安股价多少'), '中国平安');
});

const HINT = 'v_hint="sh~601318~\\u4e2d\\u56fd\\u5e73\\u5b89~zgpa~GP-A^hk~02318~\\u4e2d\\u56fd\\u5e73\\u5b89~zgpa~GP^us~pngay.ps~PingAn~pingan~GP^sz~000001~\\u5e73\\u5b89\\u94f6\\u884c~payh~GP-A^sz~988007~\\u521b\\u4e1a\\u677f\\u6307~x~ZS^sh~510300~\\u6caa\\u6df1300ETF~hs300etf~ETF"';
test('腾讯搜索：只留沪深京，港美股和外币版指数不要；没有是空的', () => {
  const l = parseHint(HINT);
  assert.deepEqual(l.map(x => x.mkt + x.code), ['sh601318', 'sz000001', 'sh510300']);
  assert.deepEqual(l.map(x => x.name), ['中国平安', '平安银行', '沪深300ETF']);
  assert.deepEqual(l.map(x => x.kind), ['个股', '个股', '基金']);
  assert.deepEqual(parseHint('v_hint="N";'), []);
  assert.deepEqual(parseHint(''), []);
});
test('东方财富搜索：京 A 算北交所，三板、港股不要', () => {
  const l = parseSuggest({ QuotationCodeTable: { Data: [
    { Code: '920982', Name: '锦波生物', Classify: 'NEEQ', SecurityTypeName: '京A', QuoteID: '0.920982', PinYin: 'JBSW' },
    { Code: '835688', Name: '平安环保', Classify: 'NEEQ', SecurityTypeName: '三板', QuoteID: '0.835688' },
    { Code: '03750', Name: '宁德时代', Classify: 'HK', SecurityTypeName: '港股', QuoteID: '116.03750' },
    { Code: '000001', Name: '上证指数', Classify: 'Index', SecurityTypeName: '指数', QuoteID: '1.000001' },
    { Code: '601318', Name: '中国平安', Classify: 'AStock', SecurityTypeName: '沪A', QuoteID: '1.601318' }] } });
  assert.deepEqual(l.map(x => [x.mkt, x.code, x.kind].join(' ')), ['bj 920982 个股', 'sh 000001 指数', 'sh 601318 个股']);
  assert.deepEqual(parseSuggest(null), []);
});
test('排序：名字一样最先；同样像时个股在前，说了「指数」「ETF」就先给那一类', () => {
  const l = [{ name: '平安银行', code: '000001', kind: '个股' }, { name: '中国平安', code: '601318', kind: '个股' }, { name: '平安', code: '999990', kind: '基金' }];
  assert.equal(rank(l, '中国平安')[0].name, '中国平安');
  assert.equal(rank(l, '中国平安')[0].exact, true);
  assert.equal(rank(l, '平安银')[0].name, '平安银行');
  assert.equal(rank(l, '平安银')[0].exact, false);
  const m = [{ name: '沪深300ETF', code: '510300', kind: '基金' }, { name: '沪深300', code: '000300', kind: '指数' }, { name: '沪深300股份', code: '600000', kind: '个股' }];
  assert.equal(rank(m, '沪深300')[0].kind, '指数');           // 名字一模一样
  assert.equal(rank(m, '沪深300ETF')[0].kind, '基金');
  assert.equal(rank(m.slice(0, 1).concat(m.slice(2)), '沪深300指数')[0].kind, '个股');   // 都不一样、也没有指数：个股在前
});

const QT = 'v_sh600519="1~贵州茅台~600519~1472.36~1469.00~1469.99~39808~22287~17521~1472.32~1~1472.31~2~1472.30~2~1472.26~19~1472.25~7~1472.36~2~1473.00~6~1473.03~2~1473.60~3~1473.68~2~~20261127161454~3.36~0.23~1481.41~1452.99~1472.36/39808/5849112431~39808~584911~0.32~22.40~~1481.41~1452.99~1.93~18405.70~18405.70~6.79~1615.90~1322.10~0.81~16~1";\nv_sz999999="";\n';
test('腾讯报价：成交额万 → 元，市值亿 → 元，时间拆成能读的；没有行情的代码不出现', () => {
  const all = parseQuote(QT), q = all.sh600519;
  assert.deepEqual(Object.keys(all), ['sh600519']);
  assert.deepEqual([q.name, q.price, q.prev, q.open, q.high, q.low, q.chg, q.pct], ['贵州茅台', '1472.36', 1469, 1469.99, 1481.41, 1452.99, 3.36, 0.23]);
  assert.deepEqual([q.vol, q.amount, q.turn, q.pe, q.pb, q.amp], [39808, 5849110000, 0.32, 22.4, 6.79, 1.93]);
  assert.equal(Math.round(q.cap / 1e8), 18406);
  assert.equal(q.time, '2026-11-27 16:14');
});
test('盘中 / 收盘：按北京时间看', () => {
  const at = s => new Date(s + '+08:00');
  assert.equal(phase('2026-11-27 10:30', at('2026-11-27T10:31:00')), '盘中');
  assert.equal(phase('2026-11-27 15:00', at('2026-11-27T16:20:00')), '今日收盘');
  assert.equal(phase('2026-11-27 16:14', at('2026-11-28T17:00:00')), '收盘价，最近一个交易日');
  assert.equal(phase('', at('2026-11-28T17:00:00')), '');
});
test('日 K：东方财富带成交额，腾讯的个股在 qfqday、指数在 day', () => {
  const em = parseKEm({ data: { klines: ['2026-11-26,1470.00,1469.00,1473.00,1456.00,32408,4747727455.00', '2026-11-27,1469.99,1472.36,1481.41,1452.99,39808,5849112431.00'] } });
  assert.deepEqual(em[1], { date: '2026-11-27', open: 1469.99, close: 1472.36, high: 1481.41, low: 1452.99, vol: 39808, amount: 5849112431 });
  assert.deepEqual(parseKEm({ data: null }), []);
  const tx = parseKTx({ data: { sh600519: { qfqday: [['2026-11-27', '1469.990', '1472.360', '1481.410', '1452.990', '39808.000']] } } }, 'sh600519');
  assert.deepEqual([tx[0].close, tx[0].vol, tx[0].amount], [1472.36, 39808, null]);
  assert.equal(parseKTx({ data: { sh000001: { day: [['2026-11-27', '1', '2', '3', '0.5', '9']] } } }, 'sh000001')[0].close, 2);
  assert.deepEqual(parseKTx({}, 'sh600519'), []);
});
test('均线、小走势图、数字的写法', () => {
  const ks = [1, 2, 3, 4, 5, 6].map(c => ({ close: c }));
  assert.equal(sma(ks, 5), 4);
  assert.equal(sma(ks, 60), null);
  assert.equal(spark([1, 2, 3, 4, 5, 6, 7, 8]), '▁▂▃▄▅▆▇█');
  assert.equal(spark([5, 5, 5]), '▄▄▄');
  assert.equal(spark([1]), '');
  assert.equal(spark(Array.from({ length: 300 }, (_, i) => i), 30).length, 30);
  assert.deepEqual([pctStr(1.234), pctStr(-0.5), pctStr(0), pctStr(null)], ['+1.23%', '-0.50%', '0.00%', '—']);
  assert.deepEqual([money(1.84e12), money(5849112431), money(123456), money(null)], ['1.84 万亿', '58.49 亿', '12 万', '—']);
});

const KS = Array.from({ length: 61 }, (_, i) => ({ date: '2026-09-' + String(i + 1).padStart(2, '0'), open: 100 + i, close: 100 + i, high: 101 + i, low: 99 + i, vol: 1000, amount: 1e8 }));
const lines = out => out.split('\n').filter(l => l.includes(' | ')).map(l => l.split(' | '));
const of = (out, kind, name) => lines(out).find(f => f[0] === kind && (!name || f[1] === name));
test('输出是 ```stock 块：个股带估值、指数不带、基金写规模；最后有来源说明，没有买卖建议的词', () => {
  const q = { ...parseQuote(QT).sh600519, kind: '个股' };
  const out = renderQuote(q, KS, [{ name: '贵州茅台', code: '600519', exact: true }]);
  assert.match(out, /^```stock\n股 \| /); assert.match(out, /\n```$/);
  assert.deepEqual(of(out, '股'), ['股', '贵州茅台', '600519', '沪市主板', '1472.36', '+3.36', '+0.23%', '2026-11-27 16:14 · ' + phase('2026-11-27 16:14')]);
  assert.deepEqual(of(out, '项', '今开'), ['项', '今开', '1469.99', '+']);      // 比昨收 1469.00 高：红
  assert.deepEqual(of(out, '项', '最低'), ['项', '最低', '1452.99', '-']);      // 比昨收低：绿
  assert.deepEqual(of(out, '项', '昨收'), ['项', '昨收', '1469.00']);           // 末尾空着的字段不写
  assert.deepEqual(of(out, '项', '市盈率 TTM'), ['项', '市盈率 TTM', '22.40']);
  const t = of(out, '势');
  assert.deepEqual(t.slice(1, 4), ['近 60 个交易日', '+60.00%', '最低 100.00 · 最高 161.00 · 前复权']);   // 61 根：从第 1 根的收盘 100 涨到 160
  assert.equal(t[4].split(',').length, 60); assert.equal(t[4].split(',').at(-1), '160.00');
  assert.equal(lines(out).at(-1)[0], '注'); assert.match(out, /不是投资建议。\n```$/);
  assert.doesNotMatch(out, /名字相近的还有/);
  const idx = renderQuote({ ...q, name: '上证指数', code: '000001', kind: '指数', pe: null, cap: null }, KS);
  assert.doesNotMatch(idx, /市盈率|前复权/); assert.ok(of(idx, '项', '成交量'));
  const fund = renderQuote({ ...q, name: '沪深300ETF', code: '510300', kind: '基金' }, KS);
  assert.ok(of(fund, '项', '规模')); assert.doesNotMatch(fund, /市盈率/);
  assert.deepEqual(of(renderQuote({ ...q, pe: -3 }, KS), '项', '市盈率 TTM'), ['项', '市盈率 TTM', '—', '', '亏损']);
  const amb = renderQuote(q, KS, [{ name: '平安银行', code: '000001', exact: false }, { name: '中国平安', code: '601318' }]);
  assert.match(amb, /\n注 \| 名字相近的还有：中国平安 601318。/);
  assert.match(renderQuote({ ...q, name: '怪|名\n字' }, KS), /^```stock\n股 \| 怪｜名 字 \| /);       // 名字里的 | 和换行不会把一行拆坏
  for (const o of [out, idx, renderK(q, KS, 20), renderCmp([{ q, ks: KS }, { q, ks: KS.slice(0, 5) }])]) assert.doesNotMatch(o, /建议买|建议卖|买入|卖出|看涨|看跌|支撑位|压力位|目标价/);
});
test('走势：区间、均线、最近 5 天；对比：数据不够的写 —', () => {
  const q = { ...parseQuote(QT).sh600519, kind: '个股' }, k = renderK(q, KS, 20);
  assert.deepEqual(of(k, '势').slice(1, 4), ['2026-09-42 ～ 2026-09-61 · 20 个交易日', '+13.48%', '前复权']);
  assert.deepEqual(of(k, '项', '区间涨跌'), ['项', '区间涨跌', '+13.48%', '+']);
  assert.deepEqual(of(k, '项', '最高'), ['项', '最高', '161.00', '', '09-61']);
  assert.deepEqual(of(k, '项', 'MA5'), ['项', 'MA5', '158.00', '', '现价在上方 1.3%']);
  assert.equal(of(k, '项', 'MA60')[2], '130.50');
  const days = lines(k).filter(f => f[0] === '日');
  assert.equal(days.length, 5);
  assert.deepEqual(days.at(-1), ['日', '2026-09-61', '160.00', '160.00', '161.00', '159.00', '+0.63%', '1.00 亿']);
  assert.deepEqual(of(renderK(q, KS.slice(0, 10), 10), '项', 'MA20'), ['项', 'MA20', '—', '', '数据不够']);
  const dn = renderK(q, KS.map((x, i) => ({ ...x, close: 200 - i })), 20);
  assert.deepEqual(of(dn, '项', '区间涨跌').slice(2), ['-11.95%', '-']);
  const c = renderCmp([{ q, ks: KS }, { q: { ...q, name: '新股', pe: -3, pb: 0 }, ks: KS.slice(0, 5) }]);
  assert.deepEqual(of(c, '比', '贵州茅台'), ['比', '贵州茅台', '600519', '1472.36', '+0.23%', '+14.29%', '+60.00%', '22.4', '6.79', '1.84 万亿']);
  assert.deepEqual(of(c, '比', '新股').slice(3, 9), ['1472.36', '+0.23%', '—', '—', '—', '—']);
});

// 页面那一半：把 public/index.html 里画行情卡片的那段原样抽出来测
const page = fs.readFileSync('public/index.html', 'utf8'), pi = page.indexOf('// ---------- 行情卡片：'), pj = page.indexOf('// ---------- 行情卡片完', pi);
const pctx = { esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'), mdCode: s => 'CODE:' + s };
vm.createContext(pctx); vm.runInContext(page.slice(pi, pj), pctx);
const { mdStock, stkCls } = pctx, body = s => s.replace(/^```stock\n/, '').replace(/\n```$/, '');
test('页面：红涨绿跌，平盘不上色', () => {
  assert.ok(pi > 0 && pj > pi, '找不到行情卡片那段');
  assert.match(page, /if\(lang==='stock'\)return mdStock\(cj\);/);
  assert.deepEqual(['+0.23%', '+3.36', '-1.77%', '-0.22', '0.00%', '+0.00%', '-0.00', '—', '', '-'].map(stkCls), [' up', ' up', ' dn', ' dn', '', '', '', '', '', '']);
  const css = fs.readFileSync('public/app.css', 'utf8');
  assert.match(css, /\.stk\{--up:color-mix\(in srgb,#E5352B /);      // 涨：红
  assert.match(css, /--dn:color-mix\(in srgb,#149A52 /);              // 跌：绿
  assert.match(css, /\.stk \.up\{color:var\(--up\)\}\.stk \.dn\{color:var\(--dn\)\}/);
});
test('页面：命令的输出画成卡片（现价上色、一格一个数、折线、表），认不出的照代码显示', () => {
  const q = { ...parseQuote(QT).sh600519, kind: '个股' }, h = mdStock(body(renderQuote(q, KS)));
  assert.match(h, /^<div class="stk"><div class="stk-h"><b>贵州茅台<\/b><code>600519<\/code><small>沪市主板<\/small><\/div>/);
  assert.match(h, /<div class="stk-p up"><em>1472\.36<\/em><span>▲ \+3\.36<\/span><span>\+0\.23%<\/span><\/div>/);
  assert.match(h, /<small>今开<\/small><b class="up">1469\.99<\/b>/);
  assert.match(h, /<small>最低<\/small><b class="dn">1452\.99<\/b>/);
  assert.match(h, /<small>昨收<\/small><b class="">1469\.00<\/b>/);
  assert.match(h, /<svg class="stk-l up" viewBox="0 0 300 64"/);
  assert.equal((/<polyline points="([^"]+)"/.exec(h)[1].split(' ')).length, 60);
  assert.match(h, /<div class="stk-n">数据来自/);
  const down = mdStock(body(renderQuote({ ...q, chg: -3.36, pct: -0.23 }, KS.map((x, i) => ({ ...x, close: 200 - i })))));
  assert.match(down, /<div class="stk-p dn"><em>1472\.36<\/em><span>▼ -3\.36<\/span>/);
  assert.match(down, /<svg class="stk-l dn"/);
  const k = mdStock(body(renderK(q, KS, 20)));
  assert.equal(k.split('<tr><td>').length - 1, 5);
  assert.match(k, /<td>09-61<\/td><td>160\.00<\/td>.*<span class="stk-v up">\+0\.63%<\/span>/);
  assert.match(k, /<small>MA5<\/small><b class="">158\.00<\/b><i>现价在上方 1\.3%<\/i>/);
  const c = mdStock(body(renderCmp([{ q, ks: KS }, { q: { ...q, name: '跌的', pct: -2 }, ks: KS }])));
  assert.match(c, /^<div class="stk"><div class="stk-tb stk-cmp">/);
  assert.match(c, /<b>跌的<\/b><code>600519<\/code><\/td><td>1472\.36<\/td><td><span class="stk-v dn">-2\.00%<\/span>/);
  assert.equal(mdStock('随便一段\n不是行情'), 'CODE:随便一段\n不是行情');
  assert.equal(mdStock('势 | 标题 | +1% | 说明 | 不是数字'), 'CODE:势 | 标题 | +1% | 说明 | 不是数字');
  assert.match(mdStock('股 | <b>x</b> | 1 | 板 | 1 | +1 | +1% | t'), /<b>&lt;b&gt;x&lt;\/b&gt;<\/b>/);     // 名字里的标签不会被当成网页
});

// 板块资金流：接口返回的样子（f62 当日净流入、f184 净占比、f3 涨跌幅；f164 / f165 / f109 是近 5 日；没数的给 "-"）
const FLOW = { data: { total: 5, diff: [
  { f12: 'BK1201', f14: '电子', f3: 12.48, f6: 532391793249, f62: 46189514752, f184: 8.68, f109: 9.86, f164: 40320000000, f165: 1.96, f204: '东山精密', f124: 1795765197 },
  { f12: 'BK1215', f14: '通信', f3: 10.6, f6: 160900000000, f62: 16280000000, f184: 10.12, f109: 11.13, f164: 25280000000, f165: 4.1, f204: '中际旭创', f124: 1795765197 },
  { f12: 'BK0475', f14: '银行', f3: -1.07, f6: 49400000000, f62: -3550000000, f184: -7.18, f109: 0.5, f164: 120000000, f165: 0.05, f204: '江苏银行', f124: 1795765100 },
  { f12: 'BK0001', f14: '煤炭', f3: 1.19, f6: 12600000000, f62: -490000000, f184: -3.89, f109: -2, f164: -900000000, f165: -1.2, f204: '-', f124: 1795765197 },
  { f12: 'BK0002', f14: '新设的板块', f3: '-', f6: '-', f62: '-', f184: '-', f109: '-', f164: '-', f165: '-', f204: '-', f124: '-' }] } };
test('板块资金流：时长只有当日 / 5 日 / 10 日三档；大类、细分两个层级', () => {
  assert.deepEqual([undefined, NaN, 0, 1, 2, 3, 5, 6, 10, 20, 60].map(flowDays), [1, 1, 1, 1, 5, 5, 5, 10, 10, 10, 10]);
  assert.deepEqual(['', '细分', '二级行业', '细一点', '大类', '行业'].map(flowLevel), ['大类', '细分', '细分', '细分', '大类', '大类']);
  assert.deepEqual(Object.keys(FLOW_LEVEL), ['大类', '细分']);
});
test('板块资金流：解析（没数的板块不要；领流入的个股只有当日有）', () => {
  const d1 = parseFlow(FLOW, 1), d5 = parseFlow(FLOW, 5);
  assert.deepEqual(d1.map(x => x.name), ['电子', '通信', '银行', '煤炭']);
  assert.deepEqual([d1[0].net, d1[0].share, d1[0].pct, d1[0].lead], [46189514752, 8.68, 12.48, '东山精密']);
  assert.equal(d1[3].lead, '');
  assert.deepEqual([d5[0].net, d5[0].share, d5[0].pct, d5[0].lead], [40320000000, 1.96, 9.86, '']);
  assert.deepEqual(parseFlow(null), []); assert.deepEqual(parseFlow({ data: { diff: [] } }), []);
});
test('板块资金流：输出（名次、带正负号的数、净流入 / 净流出各一段；普涨普跌时一边没有）', () => {
  const list = parseFlow(FLOW, 1).sort((a, b) => b.net - a.net), out = renderFlow(list, '大类', 1);
  assert.match(out, /^```stock\n题 \| 行业大类 · 当日主力资金 \| 2026-11-27 15:39 · /);
  assert.match(out, /4 个板块：2 个净流入、2 个净流出，合计 \+584 亿/);
  const flows = lines(out).filter(f => f[0] === '流');
  assert.deepEqual(flows, [['流', '1', '电子', '+462 亿', '+8.68%', '+12.48%', '东山精密'], ['流', '2', '通信', '+163 亿', '+10.12%', '+10.60%', '中际旭创'],
    ['流', '4', '银行', '-35.5 亿', '-7.18%', '-1.07%', '江苏银行'], ['流', '3', '煤炭', '-4.9 亿', '-3.89%', '+1.19%']]);
  assert.deepEqual(lines(out).filter(f => f[0] === '段').map(f => f[1]), ['净流入最多', '净流出最多']);
  const up = renderFlow(list.slice(0, 2), '细分', 5);
  assert.match(up, /题 \| 行业细分 · 近 5 日主力资金 \| .*2 个板块：2 个净流入、0 个净流出 *\n/);     // 细分不写合计（各板块有重叠）
  assert.deepEqual(lines(up).filter(f => f[0] === '段').map(f => f[1]), ['净流入最多', '没有净流出的板块']);
  assert.equal(lines(up).filter(f => f[0] === '流').length, 2);
  assert.deepEqual(lines(renderFlow(list.slice(2), '大类', 10)).filter(f => f[0] === '段').map(f => f[1]), ['没有净流入的板块', '净流出最多']);
  assert.match(up, /涨跌幅是这几天累计的。/); assert.doesNotMatch(out, /涨跌幅是这几天累计的/);
  assert.equal(lines(renderFlow(Array.from({ length: 31 }, (_, i) => ({ name: 'x' + i, net: (15 - i) * 1e8, share: 1, pct: 1, lead: '' })), '大类', 1)).filter(f => f[0] === '流').length, 15);   // 最多前 10 + 后 5
  assert.doesNotMatch(out, /建议买|建议卖|买入|卖出|看涨|看跌|抄底|机构在买/);
});
test('页面：板块资金流画成一张表（两段的列对齐），净流入那格垫色条，长短按最大的数比', () => {
  const list = parseFlow(FLOW, 1).sort((a, b) => b.net - a.net), h = mdStock(body(renderFlow(list, '大类', 1)));
  assert.match(h, /^<div class="stk"><div class="stk-h"><b>行业大类 · 当日主力资金<\/b><\/div><div class="stk-t">/);
  assert.equal(h.split('<table>').length - 1, 1);
  assert.match(h, /<tr><th>板块<\/th><th>主力净流入<\/th><th>净占比<\/th><th>涨跌<\/th><th>领流入<\/th><\/tr><tr class="stk-cap"><td colspan="5">净流入最多<\/td><\/tr>/);
  assert.match(h, /<td><i>1<\/i><b>电子<\/b><\/td><td class="stk-bar up" style="--w:100%"><span class="stk-v up">\+462 亿<\/span><\/td><td><span class="stk-v up">\+8\.68%<\/span><\/td>/);
  assert.match(h, /<td><i>4<\/i><b>银行<\/b><\/td><td class="stk-bar dn" style="--w:8%"><span class="stk-v dn">-35\.5 亿<\/span>/);
  assert.match(h, /<span class="stk-v up">\+1\.19%<\/span><\/td><td><\/td><\/tr>/);            // 煤炭：资金流出但当天是涨的；没有领流入的个股，那格空着
  const h5 = mdStock(body(renderFlow(parseFlow(FLOW, 5).sort((a, b) => b.net - a.net), '大类', 5)));
  assert.match(h5, /<th>涨跌<\/th><\/tr><tr class="stk-cap"><td colspan="4">/);                // 近 5 日没有「领流入」那一列
  assert.match(mdStock('题 | 只有标题 | 没有内容'), /^CODE:/);
  assert.match(mdStock('流 | 1 | <i>x</i> | +1 亿 | +1% | +1% | a"b'), /<b>&lt;i&gt;x&lt;\/i&gt;<\/b>.*<td>a&quot;b<\/td>/);
  assert.match(mdStock('流 | 1 | x | 不是数 | +1% | +1%'), /style="--w:0%"/);                    // 色条的长度只会是数字
});

// 排行榜：接口返回的样子（f2 现价、f3 涨跌幅、f6 成交额、f26 上市日期、f100 行业；停牌的给 "-"）
const T = (name, code, pct, amount, extra = {}) => ({ f12: code, f14: name, f2: 10, f3: pct, f6: amount, f8: 1, f26: '20100101', f100: '半导体', f124: 1795767060, ...extra });
const NOW = new Date('2026-11-28T12:00:00+08:00');
test('排行榜：说法 → 哪个榜、哪个板块；三个板块的上限', () => {
  assert.deepEqual(['', '涨幅榜', '跌', '跌幅榜', '成交额', '最活跃', '北交所 跌'].map(topMode), ['涨', '涨', '跌', '跌', '成交额', '成交额', '跌']);
  assert.deepEqual(['', '主板', '创业板', '科创板', '双创', '北交所', '北证', '跌 北交所'].map(topBoard), ['', '主板', '双创', '双创', '双创', '北交所', '北交所', '北交所']);
  assert.deepEqual(BOARDS.map(b => [b.key, b.lim]), [['主板', 10], ['双创', 20], ['北交所', 30]]);
});
test('排行榜：解析（停牌的不要，行业去掉 Ⅱ Ⅲ）；涨跌家数是三个市场加起来', () => {
  const l = parseTop({ data: { diff: [T('东山 精密', '002384', 10, 12e9, { f100: 'IT服务Ⅱ' }), T('停牌的', '000002', '-', '-', { f2: '-' }), T('没行业', '600001', 1, 1e8, { f100: '-' })] } });
  assert.deepEqual(l.map(x => [x.name, x.code, x.pct, x.ind]), [['东山精密', '002384', 10, 'IT服务'], ['没行业', '600001', 1, '']]);
  assert.deepEqual(parseTop(null), []);
  assert.deepEqual(parseBreadth({ data: { diff: [{ f104: 2227, f105: 118, f106: 11 }, { f104: 2872, f105: 64, f106: 4 }, { f104: 357, f105: 0, f106: 0 }] } }), { up: 5456, down: 182, flat: 15 });
  assert.equal(parseBreadth({ data: { diff: [] } }), null); assert.equal(parseBreadth(null), null);
});
test('排行榜：涨停 / 跌停 / 新股 / 不限幅（上限留 0.1 个点的取整余量）', () => {
  const tag = (pct, lim, listed = '20100101') => limitTag({ pct, listed }, lim, NOW);
  assert.deepEqual([10, 9.97, 10.45, 9.89, 5, -9.99, -10.02, -9.5].map(p => tag(p, 10)), ['涨停', '涨停', '涨停', '', '', '跌停', '跌停', '']);
  assert.deepEqual([20, 19.98, 19.89, 10].map(p => tag(p, 20)), ['涨停', '涨停', '', '']);
  assert.deepEqual([30, 29.96, 27.78].map(p => tag(p, 30)), ['涨停', '涨停', '']);
  assert.equal(tag(120, 10, '20261120'), '新股');      // 上市 8 天，涨幅超过上限
  assert.equal(tag(44, 10, '20261001'), '不限幅');     // 上市快两个月了还超过上限：恢复上市之类
  assert.equal(tag(120, 10, ''), '不限幅');
});
test('排行榜：先后——不限幅的最前（按涨幅），涨停的并列按成交额，其余按涨幅；跌幅榜反过来', () => {
  const l = parseTop({ data: { diff: [T('低价取整', '600001', 10.45, 1e8), T('成交大', '600002', 10, 9e9), T('成交中', '600003', 10.01, 5e9), T('没涨停', '600004', 8, 99e9), T('新股', '600005', 150, 2e9, { f26: '20261125' }), T('跌的', '600006', -3, 1e9)] } });
  const up = rankTop(l, 10, 1, NOW);
  assert.deepEqual(up.map(x => x.name), ['新股', '成交大', '成交中', '低价取整', '没涨停', '跌的']);
  assert.deepEqual(up.map(x => x.tag), ['新股', '涨停', '涨停', '涨停', '', '']);
  const d = parseTop({ data: { diff: [T('跌停小', '000001', -10, 1e8), T('跌停大', '000002', -9.98, 8e8), T('跌五', '000003', -5, 9e9), T('跌七', '000004', -7, 1e8), T('涨停的', '000005', 10, 9e9)] } });
  const down = rankTop(d, 10, -1, NOW);
  assert.deepEqual(down.map(x => x.name), ['跌停大', '跌停小', '跌七', '跌五', '涨停的']);
  assert.deepEqual(down.map(x => x.tag), ['跌停', '跌停', '', '', '']);      // 跌幅榜里涨停的不打标记
});
test('排行榜：输出（按板块分段，写清上限和涨停几只）', () => {
  const mk = (b, rows) => { const list = rankTop(parseTop({ data: { diff: rows } }), b.lim, 1, NOW); return { ...b, list, limits: list.filter(x => x.tag === '涨停').length }; };
  const secs = [mk(BOARDS[0], [T('东山精密', '002384', 10, 12178e6, { f2: 79.77, f100: '元件' }), T('小涨', '600009', 3.2, 5e8)]), mk(BOARDS[2], [T('并行科技', '920493', 27.78, 467e6, { f2: 95.45, f100: 'IT服务Ⅱ' })])];
  const out = renderTop('涨', secs, { up: 5456, down: 182, flat: 15 }, 6);
  assert.match(out, /^```stock\n题 \| 涨幅榜 \| 2026-11-27 16:11 · .*全市场上涨 5456 只、下跌 182 只、平 15 只\n/);
  assert.deepEqual(lines(out).filter(f => f[0] === '段').map(f => f[1]), ['沪深主板 · 涨停是 10% · 涨停 1 只', '北交所 · 涨停是 30% · 涨停 0 只']);
  assert.deepEqual(lines(out).filter(f => f[0] === '榜'), [['榜', '1', '东山精密', '002384', '79.77', '+10.00%', '121.78 亿', '元件', '涨停'],
    ['榜', '2', '小涨', '600009', '10.00', '+3.20%', '5.00 亿', '半导体'], ['榜', '1', '并行科技', '920493', '95.45', '+27.78%', '4.67 亿', 'IT服务']]);
  assert.match(out, /注 \| 各板块的涨跌幅上限不一样，所以分开排。涨停的算并列/);
  assert.equal(lines(renderTop('涨', secs, null, 1)).filter(f => f[0] === '榜').length, 2);               // 每段最多 per 只
  assert.match(renderTop('涨', secs, null, 6), /^```stock\n题 \| 涨幅榜 \| 2026-11-27 16:11 · [^·\n]+\n/);   // 涨跌家数没拿到就不写
  const amt = renderTop('成交额', [{ name: '全部 A 股', lim: 0, limits: 0, list: secs[0].list.map(x => ({ ...x, tag: '' })) }], null, 15);
  assert.match(amt, /题 \| 成交额榜 \| /); assert.match(amt, /\n段 \| 全部 A 股\n/); assert.doesNotMatch(amt, /所以分开排|涨停/);
  // 跌幅榜只列真的跌了的：这两个板块里没有下跌的，照实写，不拿涨得少的来凑（普涨那天北交所就是这样）
  const dn = renderTop('跌', secs, null, 6);
  assert.match(dn, /题 \| 跌幅榜 /);
  assert.deepEqual(lines(dn).filter(f => f[0] === '段').map(f => f[1]), ['沪深主板 · 没有下跌的股票', '北交所 · 没有下跌的股票']);
  assert.equal(lines(dn).filter(f => f[0] === '榜').length, 0);
  const fell = rankTop(parseTop({ data: { diff: [T('跌停的', '600001', -10, 1e9), T('小跌', '600002', -2, 1e9), T('涨的', '600003', 4, 1e9)] } }), 10, -1, NOW);
  const dn2 = renderTop('跌', [{ ...BOARDS[0], list: fell, limits: 1 }], null, 6);
  assert.deepEqual(lines(dn2).filter(f => f[0] === '榜').map(f => f[2]), ['跌停的', '小跌']);
  assert.match(dn2, /\n段 \| 沪深主板 · 跌停是 10% · 跌停 1 只\n/);
  assert.doesNotMatch(out, /建议买|建议卖|买入|卖出|看涨|看跌|龙头|妖股|打板/);
});
test('页面：排行榜画成一张表（名称下面小字是代码和行业，涨停 / 跌停是小标签），涨是红、跌是绿', () => {
  const h = mdStock('题 | 涨幅榜 | 小字\n段 | 沪深主板 · 涨停是 10% · 涨停 1 只\n榜 | 1 | 东山精密 | 002384 | 79.77 | +10.00% | 121.78 亿 | 元件 | 涨停\n榜 | 2 | 小涨 | 600009 | 10.00 | +3.20% | 5.00 亿 | 半导体\n段 | 北交所\n榜 | 1 | 跌的 | 920001 | 5.00 | -30.00% | 1.00 亿 |  | 跌停');
  assert.match(h, /^<div class="stk"><div class="stk-h"><b>涨幅榜<\/b><\/div><div class="stk-t">小字<\/div><div class="stk-tb stk-fl stk-rk"><table><tr><th>名称<\/th><th>现价<\/th><th>涨跌<\/th><th>成交额<\/th><\/tr>/);
  assert.equal(h.split('<table>').length - 1, 1);
  assert.match(h, /<tr class="stk-cap"><td colspan="4">沪深主板 · 涨停是 10% · 涨停 1 只<\/td><\/tr><tr><td><i>1<\/i><b>东山精密<\/b><u class="up">涨停<\/u><small>002384 · 元件<\/small><\/td><td>79\.77<\/td><td><span class="stk-v up">\+10\.00%<\/span><\/td><td>121\.78 亿<\/td><\/tr>/);
  assert.match(h, /<td><i>2<\/i><b>小涨<\/b><small>600009 · 半导体<\/small><\/td>/);                       // 没有标记就没有小标签
  assert.match(h, /<b>跌的<\/b><u class="dn">跌停<\/u><small>920001<\/small><\/td><td>5\.00<\/td><td><span class="stk-v dn">-30\.00%<\/span>/);   // 没有行业只写代码
  assert.match(mdStock('榜 | 1 | <b>x</b> | 000001 | 1 | +1% | 1 亿 | a&b | <i>'), /<b>&lt;b&gt;x&lt;\/b&gt;<\/b><u class="up">&lt;i&gt;<\/u><small>000001 · a&amp;b<\/small>/);
  assert.match(mdStock('榜 | 只有三段 | x'), /^CODE:/);
  // 资金流的卡片不受影响：还是它自己的表头和色条
  assert.match(mdStock('流 | 1 | 电子 | +462 亿 | +8.68% | +12.48% | 东山精密'), /<div class="stk-tb stk-fl"><table><tr><th>板块<\/th>.*class="stk-bar up"/);
});

test('命令：不写参数退出 1 并给用法；cmp 只写一只退出 1（都不联网）', () => {
  const run = (...a) => spawnSync(process.execPath, ['skills/claw-stock/stock.mjs', ...a], { encoding: 'utf8' });
  const a = run(); assert.equal(a.status, 1); assert.match(a.stderr, /用法/); assert.equal(a.stdout, '');
  assert.equal(run('cmp', '茅台').status, 1);
  assert.equal(run('--help').status, 0);
});
test('kuAi 填空：问行情的走这个技能；问买不买、问概念、别的技能的话不走', () => {
  const fills = loadFills(JSON.parse(fs.readFileSync('skills/kuai.json', 'utf8'))), go = t => routeFill(fills, t)?.name;
  for (const t of ['茅台今天股价多少', '查一下宁德时代的行情', '600519现在多少钱', '上证指数今天涨了多少', '看看比亚迪的股价', '大盘今天怎么样']) assert.equal(go(t), 'claw-stock', t);
  for (const t of ['茅台股票能不能买', '股票是什么意思', '推荐几只股票', '为什么今天大盘跌了', '帮我挑个保温杯', '打开四川卫视', '来首周杰伦的歌']) assert.notEqual(go(t), 'claw-stock', t);
});
