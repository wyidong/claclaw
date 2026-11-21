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
