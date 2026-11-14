import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-pa-'));
const { addrKind, parseAddrsHeader, ourAddrs, setOurExtra, peerCall, peerRoute, peerLanUrls, peerRelays, ADDRS_HEADER, DIRECT } = await import('../peer.mjs');

test('地址分类', () => {
  assert.equal(addrKind('http://192.168.1.5:8788/claclaw-peer'), 'lan');
  assert.equal(addrKind('http://Mac.local:8788/claclaw-peer'), 'lan');
  assert.equal(addrKind('http://100.74.25.121:8788/claclaw-peer'), 'tailscale');
  assert.equal(addrKind('http://[fd7a:115c:a1e0::1]:8788/claclaw-peer'), 'tailscale');
  assert.equal(addrKind('http://1.2.3.4:8788/claclaw-peer'), 'wan');
  assert.equal(addrKind('https://abc.relay.example/claclaw-peer'), 'relay');
  assert.equal(addrKind('https://1.2.3.4:8790/t/x/claclaw-peer#pin=sha256//a'), 'relay');
  assert.equal(addrKind(DIRECT), 'direct');
});

test('地址头：只认 …/claclaw-peer，none 清空，坏的忽略', () => {
  assert.deepEqual(parseAddrsHeader('none'), []);
  assert.equal(parseAddrsHeader(''), null);
  assert.equal(parseAddrsHeader('http://x/evil'), null);
  assert.deepEqual(parseAddrsHeader('http://1.2.3.4:8788/claclaw-peer  https://a.b/claclaw-peer javascript:x'), ['http://1.2.3.4:8788/claclaw-peer', 'https://a.b/claclaw-peer']);
});

test('我们的地址：关着协同为空；clarelay 补的子域名、公网地址排进去', () => {
  assert.deepEqual(ourAddrs({ enabled: false, port: 8788 }), []);
  setOurExtra({ wan: ['http://1.2.3.4:8788/claclaw-peer'], relay: ['https://abc.relay.example/claclaw-peer'] });
  const a = ourAddrs({ enabled: true, port: 8788, peers: [] });
  assert.ok(a.includes('http://1.2.3.4:8788/claclaw-peer'));
  assert.ok(a.includes('https://abc.relay.example/claclaw-peer'));
  assert.ok(a.indexOf('http://1.2.3.4:8788/claclaw-peer') < a.indexOf('https://abc.relay.example/claclaw-peer'));
  setOurExtra({ wan: [], relay: [] });
});

test('对方的地址表：http 的进局域网候选，https 的进中继候选', () => {
  const p = { inbox: 'http://Mac.local:8788/claclaw-peer', addrs: ['http://100.74.1.2:8788/claclaw-peer', 'https://abc.relay.example/claclaw-peer'] };
  assert.deepEqual(peerLanUrls(p), ['http://Mac.local:8788/claclaw-peer', 'http://100.74.1.2:8788/claclaw-peer']);
  assert.deepEqual(peerRelays(p), ['https://abc.relay.example/claclaw-peer']);
});

test('按顺序试：局域网不通换 Tailscale；请求带上我们的地址表；记下走的是 Tailscale', async () => {
  let got = null;
  const s = await new Promise(r => { const x = http.createServer((req, res) => { got = req.headers[ADDRS_HEADER]; res.end('{"ok":true}'); }); x.listen(0, '127.0.0.1', () => r(x)); });
  // 10.255.255.1 不可达（局域网候选，3 秒连不上就换）；Tailscale 候选用 127.0.0.1 冒充不了，改成把可达的那个标成 tailscale 的形式不现实，
  // 所以这里只验证：不可达的局域网地址失败后，换到下一个地址成功，并且带上了地址头
  const p = { id: 'p1', theirToken: 't', inbox: 'http://10.255.255.1:9/claclaw-peer', addrs: ['http://127.0.0.1:' + s.address().port + '/claclaw-peer'] };
  const j = await peerCall({ enabled: true, port: 8788, peers: [] }, p, '/ping', { ms: 5000 });
  assert.equal(j.ok, true);
  assert.ok(got);
  assert.equal(peerRoute.get('p1').via, 'lan');
  s.close();
});

test('中继地址：带 #pin= 的和只带 #key= 的（域名 + 正式证书）都认，别的不认', async () => {
  const { parseRelaysHeader, RELAY_ADDR } = await import('../peer.mjs');
  const a = 'https://1.2.3.4:8790/t/x/claclaw-peer#pin=sha256//abc=&key=k1', b = 'https://relay.example/t/y/claclaw-peer#key=k2';
  assert.deepEqual(parseRelaysHeader(a + ' ' + b + ' https://relay.example/t/z/claclaw-peer http://1.2.3.4/t/x#key=k'), [a, b]);
  assert.ok(RELAY_ADDR.test(b) && !RELAY_ADDR.test('https://relay.example/x#foo=1'));
});
