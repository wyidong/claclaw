// 帮用户装第一个 Agent：npm 安装 dsh（install.mjs）+ 把 DeepSeek 的 key 写进 dsh 的 credentials（login.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { installStart, installState } from '../install.mjs';
import { dsWriteKey, dsHasKey } from '../login.mjs';

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

test('安装：只能装列出来的；跑 npm install -g 固定的包；成功 / 没权限 / 失败都有说法', async () => {
  assert.throws(() => installStart('evil'), /不能在这里安装/);
  let f = fakeSpawn(0);
  const j = installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: f.impl });
  assert.equal(j.status, 'running');
  assert.deepEqual(f.calls[0][1].slice(-1), ['@deepseek-ai/dsh@latest']);
  assert.ok(f.calls[0][1].includes('-g'));
  assert.equal(installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: fakeSpawn(0).impl }).status, 'running', '正在装：不重复起');
  await settle();
  assert.equal(installState().status, 'ok');
  f = fakeSpawn(243, 'npm error code EACCES\nnpm error syscall mkdir\n');
  installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: f.impl });
  await settle();
  assert.match(installState().error, /sudo npm install -g @deepseek-ai\/dsh@latest/);
  installStart('deepseek', { npmBin: '/usr/bin/npm', spawnImpl: fakeSpawn(1, 'npm warn x\nnpm error network ETIMEDOUT\n').impl });
  await settle();
  assert.equal(installState().status, 'fail');
  assert.match(installState().error, /ETIMEDOUT/);
});
