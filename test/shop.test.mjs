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
