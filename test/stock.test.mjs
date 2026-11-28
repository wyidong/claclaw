// claw-stock 技能：解析、匹配、计算、排版（不联网：行情接口的返回用存下来的样子）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { marketOf, kindOfCode, boardOf, cleanQuery, parseHint, parseSuggest, rank, parseQuote, phase, parseKEm, parseKTx, sma, spark, pctStr, money, renderQuote, renderK, renderCmp } from '../skills/claw-stock/stock.mjs';
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
test('排版：个股带估值、指数不带；最后都有来源说明，没有买卖建议的词', () => {
  const q = { ...parseQuote(QT).sh600519, kind: '个股' };
  const out = renderQuote(q, KS, [{ name: '贵州茅台', code: '600519', exact: true }]);
  assert.match(out, /^\*\*贵州茅台\*\* `600519` · 沪市主板/);
  assert.match(out, /\*\*1472\.36\*\* ▲ \+3\.36（\+0\.23%）/);
  assert.match(out, /市盈率 TTM/);
  assert.match(out, /近 60 个交易日 [▁-█]{30} \+60\.00%/);      // 61 根：从第 1 根的收盘 100 涨到 160
  assert.match(out, /不是投资建议。$/);
  assert.doesNotMatch(out, /名字相近的还有/);
  const idx = renderQuote({ ...q, name: '上证指数', code: '000001', kind: '指数', pe: null, cap: null }, KS);
  assert.doesNotMatch(idx, /市盈率|前复权/);
  assert.match(idx, /成交量/);
  const fund = renderQuote({ ...q, name: '沪深300ETF', code: '510300', kind: '基金' }, KS);
  assert.match(fund, /规模/); assert.doesNotMatch(fund, /市盈率/);
  const amb = renderQuote(q, KS, [{ name: '平安银行', code: '000001', exact: false }, { name: '中国平安', code: '601318' }]);
  assert.match(amb, /名字相近的还有：中国平安 `601318`/);
  for (const o of [out, idx, renderK(q, KS, 20), renderCmp([{ q, ks: KS }, { q, ks: KS.slice(0, 5) }])]) assert.doesNotMatch(o, /建议买|建议卖|买入|卖出|看涨|看跌|支撑位|压力位|目标价/);
});
test('走势：区间、均线、最近 5 天；对比：数据不够的写 —', () => {
  const q = { ...parseQuote(QT).sh600519, kind: '个股' }, k = renderK(q, KS, 20);
  assert.match(k, /\*\*2026-09-42 ～ 2026-09-61，20 个交易日\*\*（前复权）/);
  assert.match(k, /MA5 158\.00（现价在它上方/);
  assert.match(k, /MA60 130\.50/);
  assert.equal(k.split('\n').filter(l => /^\| 2026-09-/.test(l)).length, 5);
  assert.match(renderK(q, KS.slice(0, 10), 10), /MA20 数据不够/);
  const c = renderCmp([{ q, ks: KS }, { q: { ...q, name: '新股', pe: -3 }, ks: KS.slice(0, 5) }]);
  assert.match(c, /\| 贵州茅台 `600519` \| 1472\.36 \| \+0\.23% \| \+14\.29% \| \+60\.00% \| 22\.4 \|/);
  assert.match(c, /\| 新股 `600519` \| 1472\.36 \| \+0\.23% \| — \| — \| — \|/);
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
