// 协同直连（peerrtc.mjs）：同一个进程里两头互相打通，经通道转请求给假的协同收件服务。没装 node-datachannel 就跳过。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rtcLib, rtcConfig, rtcConnect, rtcAnswer, rtcOpen, rtcState, rtcClose, rtcCloseAll, classifyAddr } from '../peerrtc.mjs';

const lib = await rtcLib();

test('classifyAddr', () => {
  assert.equal(classifyAddr('192.168.1.5'), 'lan');
  assert.equal(classifyAddr('::ffff:10.0.0.2'), 'lan');
  assert.equal(classifyAddr('100.74.25.121'), 'tailscale');
  assert.equal(classifyAddr('182.139.218.212'), 'wan');
  assert.equal(classifyAddr('2409:8a62::1'), 'wan');
  const ifs = { en0: [{ family: 'IPv6', internal: false, address: '2409:8a62:3d2:1c90:14f0:e367:3767:7e7b' }] };
  assert.equal(classifyAddr('2409:8a62:3d2:1c90:473:d474:ff55:90b7', ifs), 'lan', '和本机同一个 /64 的公网 IPv6 算局域网');
  assert.equal(classifyAddr('2409:8a62:3d2:1c91::5', ifs), 'wan');
  assert.equal(classifyAddr('2409:8a62:3d2:1c90::5', ifs), 'lan');
  assert.equal(classifyAddr('fd7a:115c:a1e0::7833:2e1b'), 'tailscale');
});

test('直连：打通、双向请求、大回复、路径限制、断开时进行中的请求报错', { skip: !lib && '没装 node-datachannel' }, async () => {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const c = []; req.on('data', d => c.push(d));
    req.on('end', () => {
      const body = Buffer.concat(c).toString();
      seen.push({ url: req.url, method: req.method, h: req.headers, body });
      if (req.url === '/claclaw-peer/big') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, s: 'x'.repeat(3 << 20) })); }
      if (req.url === '/claclaw-peer/slow') { setTimeout(() => { res.writeHead(200); res.end('{"ok":true}'); }, 30000).unref(); return; }
      if (req.url === '/claclaw-peer/nope') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"ok":false,"error":"钥匙不对"}'); }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, echo: body, auth: req.headers.authorization || '' }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  rtcConfig({ target: () => 'http://127.0.0.1:' + srv.address().port + '/claclaw-peer', ice: [], log: () => {} });
  try {
    // A 看 B 叫 'B'，B 看 A 叫 'A'（同一个进程里两张表）
    const conn = await rtcConnect('B', sdp => rtcAnswer('A', sdp));
    assert.ok(conn.open);
    assert.ok(rtcOpen('B') && rtcState('B').open);
    await new Promise(r => setTimeout(r, 300));
    assert.ok(rtcOpen('A'), '应答方也能用这条通道');

    const j = await rtcOpen('B').call('/claclaw-peer/send', { body: { msg: '你好' }, headers: { authorization: 'Bearer k1', 'x-evil': '1' } });
    assert.equal(j.ok, true); assert.equal(j.status, 200); assert.equal(JSON.parse(j.echo).msg, '你好'); assert.equal(j.auth, 'Bearer k1');
    const last = seen.at(-1);
    assert.equal(last.method, 'POST'); assert.equal(last.h['x-claclaw-via'], 'direct'); assert.equal(last.h['x-evil'], undefined, '只转白名单里的头');

    const back = await rtcOpen('A').call('/claclaw-peer/sessions', { headers: { authorization: 'Bearer k2' } });   // 反方向
    assert.equal(back.auth, 'Bearer k2'); assert.equal(seen.at(-1).method, 'GET');

    const big = await rtcOpen('B').call('/claclaw-peer/big');
    assert.equal(big.s.length, 3 << 20);

    const no = await rtcOpen('B').call('/claclaw-peer/nope');
    assert.equal(no.ok, false); assert.equal(no.status, 401); assert.equal(no.error, '钥匙不对');

    await assert.rejects(rtcOpen('B').call('/etc/passwd'), /bad path/);
    await assert.rejects(rtcOpen('B').call('/claclaw-peer/../x'), /bad path/);

    const slow = rtcOpen('B').call('/claclaw-peer/slow');
    await new Promise(r => setTimeout(r, 300));
    rtcClose('B'); rtcClose('A');
    await assert.rejects(slow, e => e.connect === false, '已经送到对方的请求断了不能换路重发');
    assert.equal(rtcOpen('B'), null);
    await assert.rejects(Promise.resolve().then(() => { const c = rtcOpen('B'); if (!c) throw Object.assign(new Error('直连没通'), { connect: true }); }), e => e.connect);
  } finally { rtcCloseAll(); srv.closeAllConnections?.(); srv.close(); }
});
