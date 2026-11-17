// 明文 http 不往公网发钥匙；经中继配对记下的公网 IP 不拿来拼局域网地址
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-pp-'));
const { plainAddrOk, callPeer, peerLanUrls, peerCall, peerRoute, chanList, noteChan, forgetPeer } = await import('../peer.mjs');

test('哪些地址能走明文 http', () => {
  for (const a of ['10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '127.0.0.1', '169.254.1.1', '::1', 'fe80::1', 'fd00::1', 'fc00::1', '::ffff:192.168.1.5']) assert.equal(plainAddrOk(a, false), true, a);
  for (const a of ['1.2.3.4', '8.8.8.8', '172.32.0.1', '2001:4860::8888', 'example.com', '', '0.0.0.0']) assert.equal(plainAddrOk(a, false), false, a);
  // 100.64/10：运营商 CGNAT 和 Tailscale 共用，本机没有 Tailscale 网卡时当公网
  assert.equal(plainAddrOk('100.74.1.2', false), false);
  assert.equal(plainAddrOk('100.74.1.2', true), true);
});

test('callPeer：明文 http 连公网 IP 直接拒，不发请求（connect 错，可换路）', async () => {
  await assert.rejects(callPeer('http://1.2.3.4:8788/claclaw-peer', '/ping', { token: 'secret' }), e => e.connect === true && e.code === 'PLAIN_PUBLIC');
  await assert.rejects(callPeer('http://[2001:4860::8888]:8788/claclaw-peer', '/ping', { token: 'secret' }), e => e.code === 'PLAIN_PUBLIC');
});

test('callPeer：名字地址解析后核对，解析出本机 / 内网照常发', async () => {
  let hits = 0;
  const s = await new Promise(r => { const x = http.createServer((req, res) => { hits++; res.end('{"ok":true}'); }); x.listen(0, '127.0.0.1', () => r(x)); });
  const port = s.address().port;
  const j = await callPeer('http://localhost:' + port + '/claclaw-peer', '/ping', { token: 'k' });
  assert.equal(j.ok, true);
  assert.equal(hits, 1);
  s.close();
});

test('peerLanUrls：公网明文地址和公网 p.ip 都不进局域网候选；内网 p.ip 照拼', () => {
  const base = { inbox: 'http://Mac.local:8788/claclaw-peer', addrs: ['http://1.2.3.4:8788/claclaw-peer', 'https://abc.relay.example/claclaw-peer'] };
  assert.deepEqual(peerLanUrls({ ...base, ip: '203.0.113.9' }), ['http://Mac.local:8788/claclaw-peer']);
  assert.deepEqual(peerLanUrls({ ...base, ip: 'relay.example.com' }), ['http://Mac.local:8788/claclaw-peer']);
  assert.deepEqual(peerLanUrls({ ...base, ip: '100.70.0.1' }), ['http://Mac.local:8788/claclaw-peer']);
  assert.deepEqual(peerLanUrls({ ...base, ip: '192.168.1.9' }), ['http://Mac.local:8788/claclaw-peer', 'http://192.168.1.9:8788/claclaw-peer']);
});

test('peerCall：只有公网明文地址时一个请求都不发', async () => {
  let plain = 0;
  const s = await new Promise(r => { const x = http.createServer((req, res) => { plain++; res.end('{"ok":true}'); }); x.listen(0, '127.0.0.1', () => r(x)); });
  const p = { id: 'pp1', theirToken: 't', inbox: 'http://203.0.113.9:' + s.address().port + '/claclaw-peer', ip: '203.0.113.9' };
  await assert.rejects(peerCall({ enabled: true, port: 8788, peers: [] }, p, '/ping', { ms: 3000 }), e => /PLAIN_PUBLIC|没有对方的地址/.test(e.code || e.message));
  assert.equal(plain, 0);
  s.close();
});

test('forgetPeer：清掉走路记录和各条路的表现', () => {
  peerRoute.set('px', { via: 'lan' }); noteChan('px', 'http://192.168.1.2:8788/claclaw-peer', true, 5);
  assert.equal(chanList('px').length, 1);
  forgetPeer('px');
  assert.equal(peerRoute.has('px'), false);
  assert.equal(chanList('px').length, 0);
});

test('中继、https 不受明文限制：#key= 的中继地址交给 clarelay，https 照常连', async () => {
  await assert.rejects(callPeer('http://1.2.3.4/t/x/claclaw-peer#key=k', '/ping', { token: 't' }), e => e.code !== 'PLAIN_PUBLIC' && /中继|clarelay/.test(e.message));
  await assert.rejects(callPeer('https://127.0.0.1:1/claclaw-peer', '/ping', { token: 't', ms: 2000 }), e => e.code !== 'PLAIN_PUBLIC' && e.connect === true);
});
