// 坏请求不能让进程退出：ws 升级的坏地址 / 坏 cookie、协同端口的坏地址（起一个临时实例，HOME 和数据目录都是临时的）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const freePort = () => new Promise(r => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
// 原样发一段 HTTP 请求，回第一行（状态行）
const raw = (port, text) => new Promise(r => {
  const s = net.connect(port, '127.0.0.1', () => s.write(text)); let d = '';
  const done = () => { s.destroy(); r(d.split('\r\n')[0]); };
  s.on('data', x => { d += x; }); s.on('close', done); s.on('error', done); setTimeout(done, 3000);
});
const UP = 'Connection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n';

test('坏的升级地址、坏的 cookie 编码、协同端口坏地址：回错误，进程不退出', { timeout: 30000 }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'badreq-'));
  const home = path.join(tmp, 'home'), data = path.join(tmp, 'data'), bin = path.join(tmp, 'bin');
  for (const d of [home, data, bin]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'dns-sd'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });   // 不在局域网里真广播
  const [port, peerPort] = [await freePort(), await freePort()];
  fs.writeFileSync(path.join(data, 'peer.json'), JSON.stringify({ enabled: true, port: peerPort }));
  const env = { ...process.env, HOME: home, CLACLAW_DATA: data, CLACLAW_HOST: '127.0.0.1', PATH: bin + path.delimiter + process.env.PATH };
  for (const k of ['DSH_HOME', 'CODEX_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) delete env[k];   // 各 Claw 的目录都落在临时 HOME 里，不碰真的
  const p = spawn(process.execPath, ['server.mjs', '--port', String(port)], { cwd: ROOT, env, stdio: 'ignore' });
  let exited = null; p.on('exit', c => { exited = c; });
  try {
    for (let i = 0; i < 100 && !(await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).startsWith('HTTP/'); i++) await new Promise(r => setTimeout(r, 100));
    for (let i = 0; i < 50 && !(await raw(peerPort, 'GET /x HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n')).startsWith('HTTP/'); i++) await new Promise(r => setTimeout(r, 100));
    assert.match(await raw(port, 'GET http://x:99999/ws HTTP/1.1\r\nHost: x\r\n' + UP), /^HTTP\/1\.1 400/);
    const st = await raw(port, `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: http://127.0.0.1:${port}\r\nCookie: claclaw_sid=%; claclaw_dev=%E0%A4%A\r\n` + UP);
    assert.match(st, /^HTTP\/1\.1 (101|401)/);
    assert.match(await raw(port, 'GET /api/sessions HTTP/1.1\r\nHost: x\r\nCookie: claclaw_sid=%\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 \d{3}/);
    assert.match(await raw(peerPort, 'GET http://x:99999/claclaw HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 400/);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(exited, null, '进程退出了');
    assert.match(await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), /^HTTP\/1\.1 \d{3}/);
  } finally {
    p.kill();
    await new Promise(r => (exited !== null ? r() : p.on('exit', r)));
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}   // 它拉起的 CLI 可能还在往临时 HOME 里写
  }
});
