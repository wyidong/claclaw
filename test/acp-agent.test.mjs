// AcpAgent 进程管理：用当前 node 跑一个假的 ACP agent（不起真实外部程序）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-agent-data-'));   // acp.mjs 引入 auth.mjs 前先指到临时目录
const { AcpAgent, AcpRunner } = await import('../src/claws/acp.mjs');

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

// Windows 上子进程关了自己的 stdin 但没退时，往管道里写不报错（只是堆在缓冲里），要等进程退出才报 EOF：这个场景在 Windows 上造不出来
test('agent 关了 stdin 还往里写（EPIPE）：不会变成未捕获异常，按进程死掉处理', { timeout: 15000, skip: process.platform === 'win32' && 'Windows 管道对端关了不报 EPIPE' }, async () => {
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

test('prepare 返回 Promise：等它完再起进程，同时来的 start 只起一个；等的时候 stop() 了就作废', { timeout: 15000 }, async () => {
  let release;
  const { ag, spawns } = mkAgent({ prepare: () => new Promise(r => { release = r; }) });
  const a = ag.use(), b = ag.use();
  await sleep(20);
  assert.equal(spawns(), 0, 'prepare 没完不起进程');
  release({ env: {}, sig: 's1' });
  await Promise.all([a, b]);
  assert.equal(spawns(), 1);
  assert.equal(ag.sig, 's1');
  await ag.stop();
  const c = ag.use();
  await sleep(20);
  ag.stop();
  release({ env: {}, sig: 's2' });
  await assert.rejects(c, /已停止/);
  assert.equal(spawns(), 1, 'stop 之后不再起');
  assert.equal(ag.ready, null);
});

// ---------- AcpRunner：会话收尾、关闭超时、协同消息那一轮的审查 ----------
// 假 agent（会话版）：resume / new 回带「权限模式」的 configOptions（当前是 yolo）；set_config_option 照改；
// prompt 看文字：hang 不回、die 退出、perm 先来要确认（答复回来再结束这一轮）、其他直接结束；session/close 不回
const FAKE_S = `
const out = m => process.stdout.write(JSON.stringify(m) + '\\n');
let mode = 'yolo', buf = '', permFor = null;
const cfg = () => [{ id: 'mode', name: '模式', category: 'mode', currentValue: mode, options: [{ value: 'default', name: 'Default' }, { value: 'yolo', name: 'YOLO' }] }];
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d; let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
    const ok = result => out({ jsonrpc: '2.0', id: m.id, result });
    if (m.method === 'initialize') ok({ agentCapabilities: {} });
    else if (m.method === 'session/resume') ok({ configOptions: cfg() });
    else if (m.method === 'session/set_config_option') { mode = m.params.value; ok({ configOptions: cfg() }); }
    else if (m.method === 'session/prompt') {
      const t = m.params.prompt.map(x => x.text).join('');
      if (t === 'die') process.exit(3);
      else if (t === 'perm') { permFor = m.id; out({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: { sessionId: m.params.sessionId,
        toolCall: { toolCallId: 't1', kind: 'execute', rawInput: { command: 'rm -rf x' } },
        options: [{ optionId: 'a1', kind: 'allow_once' }, { optionId: 'aa', kind: 'allow_always' }, { optionId: 'r1', kind: 'reject_once' }] } }); }
      else if (t !== 'hang') ok({ stopReason: 'end_turn' });
    }
    else if (m.id === 900 && permFor != null) { out({ jsonrpc: '2.0', id: permFor, result: { stopReason: 'end_turn' } }); permFor = null; }
  }
});
process.stdin.on('end', () => process.exit(0));
setTimeout(() => process.exit(9), 20000);
`;
function mkRunner() {
  const ag = new AcpAgent({ name: 'fakes', bin: () => process.execPath, missing: 'no fake', command: bin => [bin, ['-e', FAKE_S]] });
  const calls = [], answers = [];
  const rpc = ag.rpc.bind(ag), answer = ag.answer.bind(ag);
  ag.rpc = (m, p, ms) => { calls.push([m, p?.value]); return rpc(m, p, ms); };
  ag.answer = (id, r, e) => { answers.push(r?.outcome?.optionId || r?.outcome?.outcome); return answer(id, r, e); };
  class R extends AcpRunner {
    static agent = ag; static prefix = 'fk:'; static runners = new Map(); static label = 'Fake'; static group = 'Fake';
    static permPrefix = 'fk-'; static commands = []; static cfgIds = { mode: 'mode' }; static cfgNames = { mode: '模式' };
  }
  const r = new R('fk:s1', { info: { cwd: os.tmpdir() } });
  const ev = [];
  r.subscribe({ readyState: 1, send: s => ev.push(JSON.parse(s)) });
  return { ag, r, ev, calls, answers, of: t => ev.filter(e => e.t === t) };
}
const until = async (f, ms = 5000) => { for (let i = 0; i < ms / 10 && !f(); i++) await sleep(10); assert.ok(f(), '等不到：' + f); };

test('agent 崩了：这一轮只收一次尾；排着的消息开的新一轮不会被旧一轮的 catch 结束掉', { timeout: 15000 }, async () => {
  const { ag, r, of } = mkRunner();
  r.send('die');
  assert.equal(r.send('next'), 'queued');
  await until(() => of('turn.done').length >= 2);
  await sleep(50);
  const done = of('turn.done');
  assert.equal(done.length, 2);
  assert.equal(done[0].subtype, 'error');
  assert.equal(done[1].subtype, 'success');            // 新一轮正常跑完，没被旧一轮迟到的 finish 标成结束
  assert.equal(of('error').length, 1);
  assert.equal(r.busy, false);
  r.unsubscribe([...r.subs][0]); await ag.stop();
});

test('agent 崩了（没排队）：error / turn.done 各只发一次', { timeout: 15000 }, async () => {
  const { ag, r, of } = mkRunner();
  r.send('die');
  await until(() => of('turn.done').length >= 1);
  await sleep(100);
  assert.equal(of('turn.done').length, 1);
  assert.equal(of('error').length, 1);
  r.subs.clear(); r.dispose(); await ag.stop();
});

test('session/close 一直不回：超时后清掉 closing 和 owners，之后的 waitClosing 不会永远等', { timeout: 15000 }, async () => {
  const { ag, r } = mkRunner();
  ag.closeMs = 200;
  await r.attach();
  r.subs.clear(); r.dispose();
  assert.ok(ag.closing.has('s1'));
  const t0 = Date.now();
  await ag.waitClosing('s1');
  assert.ok(Date.now() - t0 < 2000);
  await until(() => !ag.closing.has('s1') && !ag.owners.has('s1'));
  assert.equal(ag.pending.size, 0);                    // 超时的请求不留在 pending 里
  await assert.rejects(ag.rpc('hang', {}, 100), /没有应答/);
  await ag.stop();
});

test('协同消息那一轮：yolo 临时切到每次询问，要确认的先过审查；「本轮同类都允许」只答允许一次；结束后换回 yolo', { timeout: 15000 }, async () => {
  const { ag, r, of, calls, answers } = mkRunner();
  const seen = [];
  AcpRunner.peerReview = async (pt, a) => { seen.push(a); return { title: '处理对方（' + pt.from + '）的消息时要运行命令，允许吗？', description: 'd', peerKey: 'bash:rm' }; };
  try {
    r.peerTurn = { from: '对方', allowed: new Set(), text: '删掉 x' };
    assert.equal(r.peerTurn, null);                    // 设的值留给下一次 send
    r.send('perm');
    await until(() => of('perm.request').length);
    const req = of('perm.request')[0];
    assert.match(req.title, /对方/);
    assert.equal(req.canAlways, true);
    assert.equal(seen[0].tool, 'Bash');
    assert.equal(seen[0].input.command, 'rm -rf x');
    assert.deepEqual(calls.filter(c => c[0] === 'session/set_config_option').map(c => c[1]), ['default']);   // 发 prompt 前切到了 default
    assert.ok(calls.findIndex(c => c[0] === 'session/set_config_option') < calls.findIndex(c => c[0] === 'session/prompt'));
    const pt = r.peerTurn;
    r.replyPermission(req.requestId, 'allow_session');
    assert.ok(pt.allowed.has('bash:rm'));
    await until(() => of('turn.done').length);
    assert.deepEqual(answers, ['a1']);                 // allow_once，不是 agent 那边的永久允许
    assert.equal(r.peerTurn, null);
    await until(() => calls.filter(c => c[0] === 'session/set_config_option').length === 2);
    assert.equal(calls.filter(c => c[0] === 'session/set_config_option')[1][1], 'yolo');
    await until(() => cfgMode(r) === 'yolo');
  } finally { AcpRunner.peerReview = null; r.subs.clear(); r.dispose(); await ag.stop(); }
});
const cfgMode = r => r.config?.find(o => o.id === 'mode')?.currentValue;

test('协同消息那一轮：审查放行、原模式是 yolo → 直接允许不弹确认；不是协同的轮次照常不审查', { timeout: 15000 }, async () => {
  const { ag, r, of, answers, calls } = mkRunner();
  let reviews = 0;
  AcpRunner.peerReview = async () => { reviews++; return null; };
  try {
    r.peerTurn = { from: '对方', allowed: new Set(), text: 'x' };
    r.send('perm');
    await until(() => of('turn.done').length === 1);
    assert.equal(reviews, 1);
    assert.equal(of('perm.request').length, 0);
    assert.deepEqual(answers, ['a1']);
    await until(() => cfgMode(r) === 'yolo');
    // 用户自己发的：不审查、不切模式（yolo 下真 agent 不会来问；这里假 agent 照问，就照常弹确认）
    const n = calls.length;
    r.send('perm');
    await until(() => of('perm.request').length === 1);
    assert.equal(reviews, 1);
    assert.equal(calls.slice(n).filter(c => c[0] === 'session/set_config_option').length, 0);
    r.replyPermission(of('perm.request')[0].requestId, 'deny');
    await until(() => of('turn.done').length === 2);
  } finally { AcpRunner.peerReview = null; r.subs.clear(); r.dispose(); await ag.stop(); }
});

test('协同消息在回复中发来（排队）：轮到它时才按协同处理', { timeout: 15000 }, async () => {
  const { ag, r, of } = mkRunner();
  let reviews = 0;
  AcpRunner.peerReview = async () => { reviews++; return null; };
  try {
    r.send('hang');
    await until(() => r.attached);
    r.peerTurn = { from: '对方', allowed: new Set(), text: 'x' };
    assert.equal(r.send('perm'), 'queued');
    assert.equal(r.peerTurn, null);                    // 正在跑的这一轮不是协同的
    r.finish({ reason: 'cancelled' });                 // 模拟这一轮被中断
    await until(() => of('turn.done').length === 2);
    assert.equal(reviews, 1);
  } finally { AcpRunner.peerReview = null; r.subs.clear(); r.dispose(); await ag.stop(); }
});

test('网页带来的设备（devNext）：跟着下一次 send 走、放进 session/prompt 的 _meta（子类 promptMeta 决定带不带）；排队的轮到时带最后一条的', { timeout: 15000 }, async () => {
  const { ag, r, of } = mkRunner();
  const seen = [], rpc0 = ag.rpc;
  ag.rpc = (m, p, ms) => { if (m === 'session/prompt') seen.push(p); return rpc0(m, p, ms); };
  try {
    r.devNext = 'windows'; r.send('a');
    await until(() => of('turn.done').length === 1);
    assert.equal(seen[0]._meta, undefined);            // 默认不带
    r.promptMeta = dev => dev ? { device: dev } : null;
    r.devNext = 'windows'; r.send('b');
    await until(() => of('turn.done').length === 2);
    assert.deepEqual(seen[1]._meta, { device: 'windows' });
    r.send('c');                                       // 没设：不带（协同、群里转来的）
    await until(() => of('turn.done').length === 3);
    assert.equal(seen[2]._meta, undefined);
    r.devNext = 'mac'; r.send('hang');
    await until(() => seen.length === 4);
    r.devNext = 'iphone'; assert.equal(r.send('q'), 'queued');
    r.finish({ reason: 'cancelled' });
    await until(() => seen.length === 5);
    assert.deepEqual(seen[4]._meta, { device: 'iphone' });
  } finally { r.subs.clear(); r.dispose(); await ag.stop(); }
});
