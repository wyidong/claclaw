import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

// 第三方库：装在临时目录里，不碰 claclaw 自己的 vendor/
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-'));
process.env.CLACLAW_VENDOR = V;
const { libInstall: install0, libInfo, libImport, libDir, baseOf, LIBS, newerVersion, verifySig } = await import('../vendor.mjs');
const { inviteBase } = await import('../relaydev.mjs');

// 测试用的发布钥匙（正式的公钥写在 vendor.mjs 的 LIBS 里）
const KP = crypto.generateKeyPairSync('ed25519'), KP2 = crypto.generateKeyPairSync('ed25519');
const PUB = KP.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const libInstall = (id, base, o = {}) => install0(id, base, { pubkeys: [PUB], ...o });
const signB64 = (bytes, k = KP.privateKey) => crypto.sign(null, bytes, k).toString('base64');

const sha = b => crypto.createHash('sha256').update(b).digest('hex');
// 假的 clarelay 下载地址：files = { 文件名: 内容 }；bad = 清单里写错哈希的文件
function serve(version, files, { bad = '', names = null, redirect = false, key = KP.privateKey, lib = 'clarelay', nosig = false } = {}) {
  const L = LIBS.clarelay, routes = {}, man = {};
  for (const [f, c] of Object.entries(files)) { man[f] = f === bad ? '0'.repeat(64) : sha(c); routes[L.file(f)] = c; }
  for (const f of names || []) man[f] = '1'.repeat(64);
  const raw = Buffer.from(JSON.stringify({ lib, version, files: man }));
  routes[L.manifest] = raw;
  if (!nosig) routes[L.sig] = signB64(raw, key);
  const hits = [];
  const s = http.createServer((q, r) => {
    hits.push(q.url);
    if (redirect) { r.writeHead(302, { location: 'http://127.0.0.1:1/x' }); return r.end(); }
    const b = routes[q.url]; r.writeHead(b ? 200 : 404); r.end(b || '');
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ base: 'http://127.0.0.1:' + s.address().port, close: () => s.close(), hits })));
}
const lib = v => ({ 'agent.mjs': `export const startDevice = () => '${v}';`, 'common.mjs': `export const VERSION = '${v}';`, 'tunnel.mjs': `export const v = '${v}';`, 'rtc-client.js': '// x' });

test('下载地址只认 https（本机回环可以 http）', () => {
  assert.throws(() => baseOf('http://relay.example.com'), /https/);
  assert.throws(() => baseOf('https://u:p@relay.example.com'), /用户名/);
  assert.equal(baseOf('https://relay.example.com/x/y?z'), 'https://relay.example.com');
  assert.equal(baseOf('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
});

test('装、重复装不动、换新版、留上一个版本', async () => {
  assert.equal(libInfo('clarelay').installed, false);
  assert.equal(await libImport('clarelay', 'agent.mjs'), null);
  const s1 = await serve('0.4.0', lib('0.4.0'));
  const r1 = await libInstall('clarelay', s1.base);
  assert.equal(r1.changed, true);
  assert.equal(libInfo('clarelay').version, '0.4.0');
  assert.equal((await libImport('clarelay', 'agent.mjs')).startDevice(), '0.4.0');
  const d1 = libDir('clarelay');
  assert.equal(fs.readFileSync(path.join(d1, 'rtc-client.js'), 'utf8'), '// x');
  const r1b = await libInstall('clarelay', s1.base);
  assert.equal(r1b.changed, false, '同一版本不重下');
  s1.close();

  const s2 = await serve('0.5.0', lib('0.5.0'));
  assert.equal((await libInstall('clarelay', s2.base)).changed, true);
  const d2 = libDir('clarelay');
  assert.notEqual(d2, d1);
  assert.equal((await libImport('clarelay', 'agent.mjs')).startDevice(), '0.5.0', '新目录 import 到的是新版');
  assert.ok(fs.existsSync(d1), '上一个版本留着');
  s2.close();

  const s3 = await serve('0.5.1', lib('0.5.1'));
  await libInstall('clarelay', s3.base);
  assert.ok(!fs.existsSync(d1), '更早的删掉');
  assert.ok(fs.existsSync(d2));
  s3.close();
});

test('签名：没配公钥不下载；签名不对、没签名、清单不是给这个库的：不装', async () => {
  const s = await serve('9.0.0', lib('9.0.0'));
  await assert.rejects(install0('clarelay', s.base, { pubkeys: [] }), /发布公钥/);
  s.close();
  const raw = Buffer.from('{"x":1}');
  assert.equal(verifySig(raw, signB64(raw), [PUB]), true);
  assert.equal(verifySig(Buffer.from('{"x":2}'), signB64(raw), [PUB]), false);
  assert.equal(verifySig(raw, 'abc', [PUB]), false);
  assert.equal(verifySig(raw, signB64(raw), ['bad']), false);
});

test('哈希对不上、清单里有坏文件名、缺文件、跳转、签名不对、降级：不装，当前版本不变', async () => {
  const before = libDir('clarelay'), ver = libInfo('clarelay').version;
  const cases = [
    [await serve('0.6.0', lib('0.6.0'), { key: KP2.privateKey }), /签名不对/],
    [await serve('0.6.0', lib('0.6.0'), { nosig: true }), /签名/],
    [await serve('0.6.0', lib('0.6.0'), { lib: 'other' }), /不是给 clarelay/],
    [await serve('0.4.9', lib('0.4.9')), /不降级/],
    [await serve('0.6.0', lib('0.6.0'), { bad: 'tunnel.mjs' }), /sha256/],
    [await serve('0.6.0', lib('0.6.0'), { names: ['../evil.mjs'] }), /文件名/],
    [await serve('0.6.0', lib('0.6.0'), { names: ['.hidden'] }), /文件名/],
    [await serve('0.6.0', { 'agent.mjs': 'x' }), /缺/],
    [await serve('0.6.0', lib('0.6.0'), { redirect: true }), /清单/],
  ];
  for (const [s, re] of cases) { await assert.rejects(libInstall('clarelay', s.base), re); s.close(); }
  assert.equal(libDir('clarelay'), before);
  assert.equal(libInfo('clarelay').version, ver);
  assert.deepEqual(fs.readdirSync(path.join(V, 'clarelay')).filter(f => f.startsWith('.dl-')), [], '临时目录清掉');
});

test('设备邀请码里的下载地址；版本比较', () => {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.equal(inviteBase('{"clarelay":"device-invite","relay":"Relay.Example.com","code":"x"}'), 'https://relay.example.com');
  assert.equal(inviteBase('{"clarelay":"device-invite","relay":"r.example.com","code":"x","port":8443}'), 'https://r.example.com:8443');
  assert.equal(inviteBase('看这个 clarelay-device1.' + b64({ d: 'r.example.com', c: 'x' })), 'https://r.example.com');
  assert.equal(inviteBase('{"relay":"evil.com/x"}'), '');
  assert.equal(inviteBase('abc'), '');
  assert.equal(newerVersion('0.5.0', '0.4.0'), true);
  assert.equal(newerVersion('0.5.0', '0.4.0'), true);
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.4.0', '0.5.0'), false);
  assert.equal(newerVersion('0.5.0', '0.5.0'), false);
  assert.equal(newerVersion('0.5.0', '0.5.0-local'), false);
});

test('本机目录装的（未签名）能被签名的版本替换，签名版之后不降级', async () => {
  const V2 = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor2-'));
  process.env.CLACLAW_VENDOR = V2;
  try {
    const s1 = await serve('0.5.0-local', lib('local'), { nosig: true });
    await install0('clarelay', s1.base, { unsigned: true, allowDowngrade: true }); s1.close();
    assert.equal(libInfo('clarelay').signed, false);
    const s2 = await serve('0.5.0', lib('0.5.0'));
    assert.equal((await libInstall('clarelay', s2.base)).changed, true); s2.close();
    assert.equal(libInfo('clarelay').signed, true);
    const s3 = await serve('0.5.0', { ...lib('0.5.0'), 'x.mjs': '//re' });
    assert.equal((await libInstall('clarelay', s3.base)).changed, true, '同一版本重新签发的照常装'); s3.close();
  } finally { process.env.CLACLAW_VENDOR = V; }
});
