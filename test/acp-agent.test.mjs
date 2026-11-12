// AcpAgent 进程管理：用当前 node 跑一个假的 ACP agent（不起真实外部程序）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-agent-data-'));   // acp.mjs 引入 auth.mjs 前先指到临时目录
const { AcpAgent } = await import('../acp.mjs');

// 假 agent：initialize 正常回；hang 永远不回；die 直接退出；closeStdin 关掉自己的 stdin 但进程不退（之后再写就是 EPIPE）
const FAKE = `
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { agentCapabilities: { x: 1 } } });
    else if (m.method === 'die') process.exit(3);
    else if (m.method === 'closeStdin') { out({ jsonrpc: '2.0', id: m.id, result: {} }); setTimeout(() => { process.stdin.destroy(); try { require('fs').closeSync(0); } catch {} }, 20); }
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(9), 20000);   // 兜底：测试出错没收拾时自己退，别挂住测试进程
`;

function mkAgent(opts = {}) {
  let spawns = 0;
  const ag = new AcpAgent({
    name: 'fake', bin: () => process.execPath, missing: 'no fake',
    command: bin => { spawns++; return [bin, ['-e', FAKE]]; },
    ...opts,
  });
  return { ag, spawns: () => spawns };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gone = p => p.exitCode !== null || p.signalCode !== null;

test('stop()：状态马上清掉，没回的请求失败，会话收到通知；之后写入不抛错；再 use 会等旧进程退出后重新拉起', { timeout: 15000 }, async () => {
  const { ag, spawns } = mkAgent();
  await ag.use();
  const old = ag.proc;
  assert.ok(ag.running);
  assert.deepEqual(ag.caps, { x: 1 });
  const dead = [];
  ag.owners.set('s1', { onAcpDead: why => dead.push(why) });
  const hang = ag.rpc('hang', {});
  const stopped = ag.stop();
  assert.equal(ag.running, false);
  assert.equal(ag.ready, null);
  await assert.rejects(hang, /已停止/);
  assert.equal(dead.length, 1);
  assert.equal(ag.owners.size, 0);
  ag.notify('session/cancel', {});            // 进程关着：不写、不抛
  ag.answer(1, {});
  await assert.rejects(ag.rpc('x', {}), /没在运行/);
  await ag.use();                              // 先等旧的退干净
  assert.ok(gone(old), '旧进程应该已经退出');
  assert.notEqual(ag.proc, old);
  assert.equal(spawns(), 2);
  await stopped;
  await ag.stop();
});

test('stop() 后同时来几次 start 只起一个进程；等待中又 stop 了，那次 start 作废', { timeout: 15000 }, async () => {
  const { ag, spawns } = mkAgent();
  await ag.use();
  ag.stop();
  const a = ag.start(), b = ag.start();
  assert.equal(a, b);
  await a;
  assert.equal(spawns(), 2);
  ag.stop();
  const c = ag.start();
  ag.stop();                                   // 还在等旧进程退出时又停了
  await assert.rejects(c, /已停止/);
  await sleep(50);
  assert.equal(spawns(), 2);
  assert.equal(ag.running, false);
  await ag.use();                              // 还能再拉起
  assert.equal(spawns(), 3);
  await ag.stop();
});

test('进程自己退出：没回的请求失败，状态清掉，下次 use 重新拉起', { timeout: 15000 }, async () => {
  const { ag, spawns } = mkAgent();
  await ag.use();
  const hang = ag.rpc('hang', {});
  ag.notify('die', {});
  await assert.rejects(hang, /进程退出了（3）/);
  assert.equal(ag.running, false);
  ag.notify('session/cancel', {});
  await ag.use();
  assert.ok(ag.running);
  assert.equal(spawns(), 2);
  await ag.stop();
});

test('agent 关了 stdin 还往里写（EPIPE）：不会变成未捕获异常，按进程死掉处理', { timeout: 15000 }, async () => {
  const { ag } = mkAgent();
  const logs = [];
  await ag.use((...a) => logs.push(a.join(' ')));
  const p = ag.proc;
  await ag.rpc('closeStdin', {});
  await sleep(150);
  const hang = ag.rpc('hang', {});           // 写进已关闭的管道
  for (let i = 0; i < 5; i++) ag.notify('x', { pad: 'y'.repeat(70000) });
  await assert.rejects(hang, /连接断了|进程退出了/);
  assert.equal(ag.running, false);
  for (let i = 0; i < 50 && !gone(p); i++) await sleep(20);
  assert.ok(gone(p), 'hardKill 的 agent 管道断了要把进程杀掉');
  assert.ok(logs.some(l => /stdin error/.test(l)));
});
