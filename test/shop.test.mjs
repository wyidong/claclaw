import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { sign, pddItem, salesNum, resort, shopImgOk } from '../src/shop.mjs';

test('拼多多签名：secret + 参数按名字排序拼接 + secret，MD5 大写', () => {
  const want = crypto.createHash('md5').update('S' + 'a1b2type' + 'x' + 'S').digest('hex').toUpperCase();
  assert.equal(sign({ type: 'x', b: '2', a: '1' }, 'S'), want);
});

test('商品条目：分转元，券后价 = 拼团价 - 券', () => {
  const x = pddItem({ goods_sign: 'g', goods_name: ' 杯子 ', min_group_price: 3990, coupon_discount: 500, sales_tip: '1.3万+', goods_thumbnail_url: 'https://img.pddpic.com/a.jpg' });
  assert.deepEqual([x.price, x.orig, x.coupon, x.title, x.sign], [34.9, 39.9, 5, '杯子', 'g']);
});

test('销量排序认「万+」', () => {
  assert.equal(salesNum('19.6万+'), 196000);
  assert.equal(salesNum('858'), 858);
  const r = resort([{ sales: '858', price: 3 }, { sales: '1.2万+', price: 1 }, { sales: '4000', price: 2 }], 6);
  assert.deepEqual(r.map(x => x.sales), ['1.2万+', '4000', '858']);
  assert.deepEqual(resort(r, 9).map(x => x.price), [1, 2, 3]);
});

test('商品图只代理拼多多的 https 图片', () => {
  assert.ok(shopImgOk('https://img.pddpic.com/gaudit-image/x.jpg'));
  assert.ok(shopImgOk('https://t00img.yangkeduo.com/x.jpg'));
  assert.ok(!shopImgOk('http://img.pddpic.com/x.jpg'));
  assert.ok(!shopImgOk('https://evilpddpic.com/x.jpg'));
  assert.ok(!shopImgOk('https://127.0.0.1/x.jpg'));
});

test('没有本机钥匙时问公开的商品服务，结果缓存；服务报错照实返回', async () => {
  const http = await import('node:http'), fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  let hits = 0, fail = false;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      hits++; const q = JSON.parse(b);
      if (fail) { res.writeHead(503, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: '拼多多限用，冷却中' })); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, items: [{ platform: '拼多多', title: q.keyword + ' A', price: 9.9, url: 'https://p.pinduoduo.com/x' }, { title: '没链接', url: 'javascript:1' }] }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.CLACLAW_SHOP_API = 'http://127.0.0.1:' + srv.address().port + '/s';
  const { makeShop } = await import('../src/shop.mjs?pub');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-'));
  try {
    const s = makeShop({ DATA });
    const r = await s.search({ keyword: '杯子', n: 5 });
    assert.equal(r.ok, true); assert.deepEqual(r.items.map(x => x.title), ['杯子 A']);
    assert.equal((await s.search({ keyword: '杯子', n: 5 })).cached, true); assert.equal(hits, 1);
    fail = true;
    const e = await s.search({ keyword: '水壶' });
    assert.equal(e.ok, false); assert.match(e.error, /冷却/);
  } finally { srv.close(); delete process.env.CLACLAW_SHOP_API; fs.rmSync(DATA, { recursive: true, force: true }); }
});

test('转转：价格区间、商品条目（图换成 400 宽）、图片域名', async () => {
  const { zzRange, zzItem } = await import('../src/shop.mjs');
  assert.equal(zzRange(0, 0), ''); assert.equal(zzRange(0, 5000), '0_5000'); assert.equal(zzRange(3000, 0), '3000_'); assert.equal(zzRange(3000.4, 5000), '3000_5000');
  const x = zzItem({ infoId: '1', title: '95A 苹果 MacBook', price: '4628', chengSe: '95A', serviceLabelsInfo: ['在仓直发', null], infoImage: 'https://pic1.zhuanstatic.com/a.jpg?w=160', jumpUrl: 'https://zz3.cn/x' });
  assert.deepEqual([x.platform, x.price, x.cond, x.labels, x.img], ['转转', 4628, '95A', ['在仓直发'], 'https://pic1.zhuanstatic.com/a.jpg?w=400']);
  assert.ok(shopImgOk('https://pic1.zhuanstatic.com/zhuanzh/a.jpg?w=400'));
});

test('转转：MCP 先 initialize 再 tools/call search；凭证失效照实说', async () => {
  const http = await import('node:http'), fs = await import('node:fs'), os = await import('node:os'), path = await import('node:path');
  const seen = []; let deny = false;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      if (deny || req.headers.authorization !== 'Bearer T') { res.writeHead(401); return res.end(); }
      const q = JSON.parse(b); seen.push(q.method + (req.headers['mcp-session-id'] ? '@' + req.headers['mcp-session-id'] : ''));
      if (!q.id) { res.writeHead(202); return res.end(); }
      const result = q.method === 'initialize' ? { serverInfo: { name: 'zz' } } : { content: [{ type: 'text', text: JSON.stringify({ items: [
        { infoId: '1', title: '9A ' + q.params.arguments.keyword, price: '3488', infoImage: 'https://pic1.zhuanstatic.com/a.jpg?w=160', jumpUrl: 'https://zz3.cn/a', priceRange: q.params.arguments.priceRange },
        { infoId: '2', title: '没链接', price: '1', jumpUrl: '' }] }) }] };
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'S1' });
      res.end('event: message\ndata: ' + JSON.stringify({ jsonrpc: '2.0', id: q.id, result }) + '\n\n');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  process.env.CLACLAW_ZZ_MCP = 'http://127.0.0.1:' + srv.address().port + '/mcp'; process.env.ZZ_MCP_TOKEN = 'T';
  const { makeShop } = await import('../src/shop.mjs?zz');
  const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-'));
  try {
    const s = makeShop({ DATA });
    const r = await s.search({ keyword: 'iPhone 15', platform: '转转', max: 4000 });
    assert.equal(r.ok, true); assert.deepEqual(r.items.map(x => [x.title, x.price, x.url]), [['9A iPhone 15', 3488, 'https://zz3.cn/a']]);
    assert.deepEqual(seen, ['initialize', 'notifications/initialized@S1', 'tools/call@S1']);
    deny = true;
    const e = await s.search({ keyword: 'iPad', platform: '转转' });
    assert.equal(e.ok, false); assert.match(e.error, /凭证失效/);
  } finally { srv.close(); delete process.env.CLACLAW_ZZ_MCP; delete process.env.ZZ_MCP_TOKEN; fs.rmSync(DATA, { recursive: true, force: true }); }
});

test('转转估价结果：有分档只讲分档（分换元）；要确认时列出参数 ID 和选项 ID', async () => {
  const { zzValuation } = await import('../src/shop.mjs');
  const a = zzValuation({ priceHit: true, minPrice: '2500', maxPrice: '96000', tiers: [{ desc: '当成色最好', isSingle: false, minPrice: '134500', maxPrice: '137500' }, { desc: '当功能异常/维修', isSingle: true, singlePrice: '3000' }],
    matchedParams: [{ paramName: '容量', optionName: '128G' }], jumpUrl: 'https://zz3.cn/a' });
  assert.match(a, /当成色最好：约 1345～1375 元/); assert.match(a, /当功能异常\/维修：约 30 元/); assert.doesNotMatch(a, /25～960/);
  assert.match(a, /容量 128G/); assert.match(a, /入口：https:\/\/zz3\.cn\/a/);
  assert.match(zzValuation({ priceHit: true, minPrice: '100000', maxPrice: '120000' }), /约 1000～1200 元/);
  const b = zzValuation({ priceHit: false, needClarification: true, clarificationOptions: [{ paramId: 'capacityId', paramName: '容量', options: [{ optionId: 1, optionName: '128G' }, { optionId: 2, optionName: '256G' }] }] });
  assert.match(b, /容量（capacityId）：128G=1、256G=2/); assert.doesNotMatch(b, /回收参考价/);
  assert.match(zzValuation({ priceHit: false, statusMessage: '暂未命中' }), /暂时估不出价格/);
});
