import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-cp-'));
const { callPeer } = await import('../peer.mjs');

function serve(handler) {
  return new Promise(r => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });
}

test('正常请求：带钥匙、POST JSON，回 JSON', async () => {
  const s = await serve((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true, auth: req.headers.authorization, got: JSON.parse(b) })); }); });
  const j = await callPeer('http://127.0.0.1:' + s.address().port + '/claclaw-peer', '/x', { token: 'k', body: { text: 'hi' } });
  assert.equal(j.ok, true); assert.equal(j.auth, 'Bearer k'); assert.equal(j.got.text, 'hi'); assert.equal(j.status, 200);
  s.close();
});

test('连不上：标 connect（可以换地址重试）', async () => {
  const s = await serve(() => {}); const port = s.address().port; s.close();
  await assert.rejects(callPeer('http://127.0.0.1:' + port, '', {}), e => e.connect === true && /连不上/.test(e.message));
});

test('已连上但等回复超时：不标 connect（不能重发）', async () => {
  const s = await serve(() => {});
  await assert.rejects(callPeer('http://127.0.0.1:' + s.address().port, '', { body: { a: 1 }, ms: 300 }), e => e.connect === false && /超时/.test(e.message));
  s.closeAllConnections(); s.close();
});

test('非 2xx：ok=false，带上错误', async () => {
  const s = await serve((req, res) => { res.statusCode = 409; res.end(JSON.stringify({ ok: false, error: '忙' })); });
  const j = await callPeer('http://127.0.0.1:' + s.address().port, '', {});
  assert.equal(j.ok, false); assert.equal(j.error, '忙'); assert.equal(j.status, 409);
  s.close();
});
