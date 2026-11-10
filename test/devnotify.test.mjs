// 报给 clarelay 的已读 / 提醒丢了：不单条重发，过一会儿全量同步，没成再隔久一点
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

test('已读报丢了 → 5 秒后全量同步，没成 15 秒后再来，成了就停', async () => {
  const hits = [];
  let readFails = true;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      hits.push(req.method + ' ' + req.url);
      if (req.url === '/status') return res.end(JSON.stringify({ online: true, name: 'T' }));
      if (req.url === '/read' && readFails) { res.statusCode = 500; return res.end('{}'); }
      res.end(JSON.stringify({ ok: true, online: true }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devn-'));
  const f = path.join(dir, 'local.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://127.0.0.1:' + srv.address().port, token: 't' }));
  process.env.CLACLAW_CLARELAY_LOCAL = f;
  const { startDevNotify, devRead } = await import('../devnotify.mjs?' + Date.now());
  const logs = [], syncs = [];
  let syncOk = false;
  const until = async (fn, ms = 3000) => { const t = Date.now(); while (!fn()) { if (Date.now() - t > ms) throw new Error('等不到'); await new Promise(r => setImmediate(r)); } };
  startDevNotify({ log: (...a) => logs.push(a.join(' ')), onOnline: async () => { syncs.push(Date.now()); return { ok: syncOk }; } });
  await until(() => syncs.length === 1);          // 刚上线那次
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    devRead('abc');
    await until(() => logs.some(l => l.includes('/read failed')));
    mock.timers.tick(4999); await new Promise(r => setImmediate(r));
    assert.equal(syncs.length, 1, '5 秒不到不同步');
    mock.timers.tick(1); await until(() => syncs.length === 2);
    await new Promise(r => setImmediate(r));
    syncOk = true;
    mock.timers.tick(14999); await new Promise(r => setImmediate(r));
    assert.equal(syncs.length, 2);
    mock.timers.tick(1); await until(() => syncs.length === 3);
    await new Promise(r => setImmediate(r));
    mock.timers.tick(10 * 60 * 1000); await new Promise(r => setImmediate(r));
    assert.equal(syncs.length, 3, '同步成了就不再来');
    // 再丢一条：重新从 5 秒开始
    devRead('def');
    await until(() => logs.filter(l => l.includes('/read failed')).length === 2);
    mock.timers.tick(5000); await until(() => syncs.length === 4);
  } finally { mock.timers.reset(); srv.close(); }
});
