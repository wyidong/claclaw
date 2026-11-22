// 帮用户装第一个 Agent：npm 安装 dsh（install.mjs）+ 把 DeepSeek 的 key 写进 dsh 的 credentials（login.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { installStart, installState, installReset, markInstallable } from '../src/claws/install.mjs';
import { dsWriteKey, dsHasKey } from '../src/claws/login.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-install-'));
const KEY = 'sk-0123456789abcdef0123456789abcdef';

test('写 key：没有文件就新建；保留别的 ref；已有就原位替换；refs: {} 也能写', () => {
  const f = path.join(TMP, 'a', '.credentials.yaml');
  const old = process.env.DEEPSEEK_API_KEY; delete process.env.DEEPSEEK_API_KEY;
  try {
    assert.equal(dsHasKey(f), false);
    dsWriteKey(KEY, f);
    assert.equal(fs.readFileSync(f, 'utf8'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ' + KEY + '\n');
    assert.equal(dsHasKey(f), true);
    const g = path.join(TMP, 'b.yaml');
    fs.writeFileSync(g, 'version: 1\r\nrefs:\r\n  ARK_API_KEY: ark-xyz\r\n  DEEPSEEK_API_KEY: sk-old0000000000000000\r\n');
    dsWriteKey(KEY, g);
    assert.equal(fs.readFileSync(g, 'utf8'), 'version: 1\nrefs:\n  ARK_API_KEY: ark-xyz\n  DEEPSEEK_API_KEY: ' + KEY + '\n');
    const h = path.join(TMP, 'c.yaml');
    fs.writeFileSync(h, 'version: 1\nrefs: {}\n');
    assert.equal(dsHasKey(h), false);
    dsWriteKey(KEY, h);
    assert.equal(fs.readFileSync(h, 'utf8'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: ' + KEY + '\n');
    assert.throws(() => dsWriteKey('abc', h), /sk-/);
    assert.throws(() => dsWriteKey(KEY + '\nrefs: x', h), /sk-/, '不能借换行写进别的内容');
  } finally { if (old !== undefined) process.env.DEEPSEEK_API_KEY = old; }
});

function fakeSpawn(code, out = '') {
  const calls = [];
  const impl = (cmd, args) => {
    calls.push([cmd, args]);
    const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
    setTimeout(() => { if (out) p.stderr.emit('data', out); p.emit('exit', code); }, 5);
    return p;
  };
  return { impl, calls };
}
const settle = () => new Promise(r => setTimeout(r, 30));

test('安装按钮：DeepSeek 没装就给，不看别的 Claw 装没装；装了的、这台机器用不了的、没列出来的不给', () => {
  const mark = l => markInstallable(l).filter(c => c.canInstall).map(c => c.id);
  assert.deepEqual(mark([{ id: 'deepseek', supported: true, installed: false }, { id: 'kuai', supported: true, installed: true }, { id: 'claude', supported: true, installed: true }]), ['deepseek']);
  assert.deepEqual(mark([{ id: 'deepseek', supported: true, installed: false }, { id: 'opencode', supported: true, installed: false }]), ['deepseek']);
  assert.deepEqual(mark([{ id: 'deepseek', supported: true, installed: true }, { id: 'kuai', supported: true, installed: true }]), []);
  assert.deepEqual(mark([{ id: 'deepseek', supported: false, installed: false }, { id: 'toString', supported: true, installed: false }]), []);
});

test('安装：只能装列出来的；跑 npm install -g 固定的包；成功 / 没权限 / 失败都有说法', async () => {
  assert.throws(() => installStart('evil'), /不能在这里安装/);
  let f = fakeSpawn(0);
  const j = installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: f.impl });
  assert.equal(j.status, 'running');
  assert.deepEqual(f.calls[0][1].slice(-1), ['@deepseek-ai/dsh@latest']);
  assert.ok(f.calls[0][1].includes('-g'));
  assert.ok(f.calls[0][1].some(a => /^--allow-scripts=.*node-pty/.test(a)), 'npm 11.19+ 默认不跑依赖的安装脚本：要放行 node-pty 等');
  assert.equal(installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: fakeSpawn(0).impl }).status, 'running', '正在装：不重复起');
  await settle();
  assert.equal(installState().status, 'ok');
  assert.equal(installState().pct, 100);
  const again = fakeSpawn(0);
  assert.equal(installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: again.impl }).status, 'ok', '刚装好：再点只回结果，不重复装');
  assert.equal(again.calls.length, 0);
  installReset();
  f = fakeSpawn(243, 'npm error code EACCES\nnpm error syscall mkdir\n');
  installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: f.impl });
  await settle();
  assert.match(installState().error, /sudo npm install -g --allow-scripts=\S+ @deepseek-ai\/dsh@latest，/);
  installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: fakeSpawn(1, 'npm warn x\nnpm error network ETIMEDOUT\n').impl });
  await settle();
  assert.equal(installState().status, 'fail');
  assert.match(installState().error, /ETIMEDOUT/);
});

test('安装进度：按 npm http 行数出阶段和百分比，只增不减；http 行不进出错信息', async () => {
  installReset();
  const p = new EventEmitter(); p.stdout = new EventEmitter(); p.stderr = new EventEmitter(); p.kill = () => {};
  installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: () => p });
  const st = () => installState();
  assert.equal(st().phase, 'resolve');
  for (let i = 0; i < 340; i++) p.stderr.emit('data', 'npm http fetch GET 200 https://r.example/pkg' + i + ' 10ms (cache miss)\n');
  const a = st(); assert.equal(a.phase, 'resolve'); assert.ok(a.pct >= 15 && a.pct <= 20, a.pct); assert.match(a.tail, /查依赖（340 \/ 约 680）/);
  // 拆在两块里的一行也要认
  p.stderr.emit('data', 'npm http cache a@https://r.example/a/-/a-1.0.0.t'); p.stderr.emit('data', 'gz 1ms (cache hit)\nnpm http cache b@https://r.example/b/-/b-1.0.0.tgz 0ms (cache hit)\n');
  const b = st(); assert.equal(b.phase, 'fetch'); assert.equal(b.pct, 35); assert.match(b.tail, /0 \/ 2 个包/);
  p.stderr.emit('data', 'npm http fetch GET 200 https://cdn.example/packages/a/1.0.0/a-1.0.0.tgz 99ms (cache miss)\n');
  const c = st(); assert.ok(c.pct > 60 && c.pct < 70, c.pct); assert.match(c.tail, /1 \/ 2 个包/);
  p.stderr.emit('data', 'npm http fetch GET 200 https://cdn.example/packages/b/1.0.0/b-1.0.0.tgz 99ms (cache miss)\n');
  const d = st(); assert.equal(d.phase, 'finish'); assert.ok(d.pct >= 92 && d.pct < 100, d.pct);
  p.stderr.emit('data', 'npm error network ETIMEDOUT\n'); p.emit('exit', 1);
  assert.equal(st().status, 'fail'); assert.match(st().error, /ETIMEDOUT/); assert.doesNotMatch(st().error, /npm http/);
});

// claw-install 技能（kuAi 用）：通过本机接口叫 claclaw 去装，自己不跑 npm；输出是给用户看的话
test('claw-install 技能：只认 DeepSeek；带本机令牌调 /api/local/install；已经装了、正在装、装好了、没装成各有说法', { timeout: 30000 }, async () => {
  const { spawn } = await import('node:child_process'), http = await import('node:http');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-inst-')), seen = [];
  let plan = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      seen.push([req.method, req.url, req.headers['x-claclaw-local'], b]);
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(plan.length > 1 ? plan.shift() : plan[0]));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  fs.writeFileSync(path.join(home, 'local.json'), JSON.stringify({ url: 'http://127.0.0.1:' + srv.address().port, token: 'tok-123' }));
  const run = (...args) => new Promise(r => { let out = ''; const p = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'skills', 'claw-install', 'install.mjs'), ...args], { env: { ...process.env, CLACLAW_HOME: home } }); p.stdout.on('data', d => out += d); p.on('close', code => r({ code, out: out.trim() })); });
  try {
    // 已经装了：不重复装
    plan = [{ ok: true, installed: true, label: 'DeepSeek Harness' }];
    let r = await run('DeepSeek');
    assert.deepEqual([r.code, r.out], [0, 'DeepSeek Harness 已经装好了，不用再装。还没填 API Key 的话：到 Claw 页，在 DeepSeek 那张卡片上点「填 key」。']);
    assert.deepEqual(seen.at(-1), ['POST', '/api/local/install', 'tok-123', '{"claw":"deepseek"}']);
    // 开始装 → 等一小会儿就装好了
    plan = [{ ok: true, state: { status: 'running', label: 'DeepSeek Harness', pct: 3, tail: '正在查依赖（20 / 约 680）' } }, { ok: true, state: { status: 'ok', label: 'DeepSeek Harness', pct: 100 } }];
    r = await run('dsh');
    assert.equal(r.code, 0); assert.match(r.out, /^DeepSeek Harness 装好了。装好后还要填 API Key 才能用：到 Claw 页，在 DeepSeek 那张卡片上点「填 key」/);
    assert.equal(seen.at(-1)[0], 'GET');                                               // 之后是取进度
    // 没装成：退出码不是 0，原因照实说
    plan = [{ ok: true, state: { status: 'running', pct: 1 } }, { ok: true, state: { status: 'fail', label: 'DeepSeek Harness', error: '没有权限安装到全局目录。' } }];
    r = await run('深度求索');
    assert.deepEqual([r.code, r.out], [1, 'DeepSeek Harness 没装成：没有权限安装到全局目录。']);
    // 服务不让装（这台电脑用不了、没有 npm）
    plan = [{ ok: false, error: '没找到 npm：先装好 Node.js' }];
    r = await run('deepseek');
    assert.deepEqual([r.code, r.out], [1, '没装：没找到 npm：先装好 Node.js']);
    // 看进度
    plan = [{ ok: true, state: { status: 'running', label: 'DeepSeek Harness', pct: 40, tail: '正在下载（100 / 654 个包）' } }];
    r = await run('status');
    assert.equal(r.code, 0); assert.match(r.out, /^已经开始安装 DeepSeek Harness，现在 40%（正在下载（100 \/ 654 个包））。一般要 1–5 分钟/);
    assert.deepEqual(seen.at(-1).slice(0, 2), ['GET', '/api/local/install']);
    plan = [{ ok: true, state: { status: 'none' } }];
    assert.equal((await run()).out, '现在没有在装东西。');
    // 别的软件：不发请求，直接说装不了
    const before = seen.length;
    r = await run('wechat');
    assert.equal(r.code, 2); assert.match(r.out, /^这里只能装：DeepSeek Harness/); assert.equal(seen.length, before);
  } finally { srv.close(); }
  // claclaw 没在运行（找不到本机令牌）
  const none = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-inst-'));
  const p = spawn(process.execPath, [path.join(import.meta.dirname, '..', 'skills', 'claw-install', 'install.mjs'), 'deepseek'], { env: { ...process.env, CLACLAW_HOME: none } });
  let out = ''; p.stdout.on('data', d => out += d);
  assert.equal(await new Promise(r => p.on('close', r)), 1); assert.match(out, /^claclaw 没在运行/);
});
