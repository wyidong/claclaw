// 应用内更新：临时 git 仓库模拟「远端有新版本」，测检查、更新、失败退回、GitHub 连不上改走代码包镜像
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { makeUpdater } from '../src/update.mjs';

const G = (cwd, ...a) => execFileSync('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { encoding: 'utf8' }).trim();
const wait = async (f, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (f()) return; await new Promise(r => setTimeout(r, 50)); } throw new Error('等超时'); };

function setup({ checkOk = true } = {}) {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-upd-'));
  const src = path.join(T, 'src'), bare = path.join(T, 'origin.git'), root = path.join(T, 'root'), data = path.join(T, 'data');
  fs.mkdirSync(path.join(src, 'tools'), { recursive: true }); fs.mkdirSync(data);
  fs.writeFileSync(path.join(src, 'tools', 'check.mjs'), checkOk ? '' : 'process.exit(1)');
  fs.writeFileSync(path.join(src, 'package.json'), '{"v":1}');
  G(T, 'init', '-q', '-b', 'main', src); G(src, 'add', '.'); G(src, 'commit', '-qm', 'v1');
  execFileSync('git', ['clone', '-q', '--bare', src, bare]);
  execFileSync('git', ['clone', '-q', bare, root]);
  const push = (msg, files) => { for (const [f, c] of Object.entries(files)) fs.writeFileSync(path.join(src, f), c); G(src, 'add', '.'); G(src, 'commit', '-qm', msg); G(src, 'push', '-q', bare, 'main'); };
  return { T, src, bare, root, data, push };
}

test('检查到新版本、点更新：快进、依赖变了才装、自检、排重启', async () => {
  const s = setup();
  const npmRuns = [], restarts = [];
  // 冒充 npm：每跑一次记一行。Windows 跑不了 sh 脚本，用 .cmd（update.mjs 会用 shell 跑 .cmd）
  const npmLog = path.join(s.T, 'npm.log'), WIN = process.platform === 'win32';
  const fakeNpm = path.join(s.T, WIN ? 'npm.cmd' : 'npm.sh');
  fs.writeFileSync(fakeNpm, WIN ? '@echo x>> "' + npmLog + '"\r\n' : '#!/bin/sh\necho x >> "' + npmLog + '"\n'); if (!WIN) fs.chmodSync(fakeNpm, 0o755);
  const u = makeUpdater({ ROOT: s.root, DATA: s.data, npm: fakeNpm, restart: async n => { restarts.push(n); } });
  let v = await u.check();
  assert.equal(v.supported, true); assert.equal(v.latest, null);
  s.push('改了说明', { 'a.txt': '1' });
  s.push('加了依赖', { 'package.json': '{"v":2}' });
  v = await u.check();
  assert.equal(v.latest.count, 2); assert.equal(v.latest.diverged, false);
  assert.deepEqual(v.latest.log.map(x => x.s), ['加了依赖', '改了说明']);
  await u.apply();
  await wait(() => u.view().phase === 'restart');
  assert.equal(G(s.root, 'rev-parse', 'HEAD'), G(s.src, 'rev-parse', 'HEAD'));
  assert.equal(fs.readFileSync(npmLog, 'utf8').trim().split('\n').length, 1);   // package.json 变了：装了一次
  assert.match(restarts[0], /^更新到 \w{7}$/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(s.data, 'update-last.json'), 'utf8')).to, G(s.src, 'rev-parse', '--short=7', 'HEAD'));
  fs.rmSync(s.T, { recursive: true, force: true });
});

test('自检失败：退回原来的版本，本机没提交的改动保留，不重启', async () => {
  const s = setup();
  const u = makeUpdater({ ROOT: s.root, DATA: s.data, npm: process.platform === 'win32' ? 'cmd' : 'true', restart: async () => { throw new Error('不该重启'); } });
  s.push('坏版本', { 'tools/check.mjs': 'process.exit(1)' });
  fs.writeFileSync(path.join(s.root, 'package.json'), '{"v":1,"local":true}');   // 本机改过（不碰更新的文件）
  const old = G(s.root, 'rev-parse', 'HEAD');
  await u.check(); await u.apply();
  await wait(() => u.view().phase === 'failed');
  assert.match(u.view().phaseError, /^自检这一步没成/);
  assert.equal(G(s.root, 'rev-parse', 'HEAD'), old);
  assert.match(fs.readFileSync(path.join(s.root, 'package.json'), 'utf8'), /local/);
  fs.rmSync(s.T, { recursive: true, force: true });
});

test('本机有自己的提交（分叉）：提示，不能更新', async () => {
  const s = setup();
  const u = makeUpdater({ ROOT: s.root, DATA: s.data, restart: async () => {} });
  fs.writeFileSync(path.join(s.root, 'b.txt'), 'x'); G(s.root, 'add', '.'); G(s.root, 'commit', '-qm', '本机的');
  s.push('新版', { 'a.txt': '2' });
  const v = await u.check();
  assert.equal(v.latest.diverged, true);
  await assert.rejects(u.apply(), /分叉/);
  fs.rmSync(s.T, { recursive: true, force: true });
});

test('仓库连不上：从安装时记下的代码包镜像取', async () => {
  const s = setup();
  s.push('镜像里的新版', { 'a.txt': '3' });
  const bundle = path.join(s.T, 'c.bundle'); G(s.src, 'bundle', 'create', '-q', bundle, 'main');   // 中继上的代码包只有 refs/heads/main，没有 HEAD
  const buf = fs.readFileSync(bundle), sum = crypto.createHash('sha256').update(buf).digest('hex');
  G(s.root, 'remote', 'set-url', 'origin', path.join(s.T, 'nope.git'));   // 仓库连不上
  fs.writeFileSync(path.join(s.data, 'install-origin.json'), JSON.stringify({ relay: 'https://relay.example.com/claclaw' }));
  const asked = [];
  const fetch = async u => { asked.push(u); return { ok: true, arrayBuffer: async () => (u.endsWith('.sha256') ? Buffer.from(sum + '  claclaw.bundle\n') : buf) }; };
  const u = makeUpdater({ ROOT: s.root, DATA: s.data, fetch, restart: async () => {} });
  const v = await u.check();
  assert.equal(v.via, 'mirror'); assert.equal(v.latest.count, 1);
  assert.deepEqual(asked, ['https://relay.example.com/claclaw/claclaw.bundle.sha256', 'https://relay.example.com/claclaw/claclaw.bundle']);
  fs.rmSync(s.T, { recursive: true, force: true });
});

test('不是 git 仓库（桌面安装包）：不支持', async () => {
  const T = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-upd-'));
  const u = makeUpdater({ ROOT: T, DATA: T });
  await u.ready;
  assert.equal(u.view().supported, false); assert.match(u.view().reason, /不是从代码仓库装的/);
  fs.rmSync(T, { recursive: true, force: true });
});
