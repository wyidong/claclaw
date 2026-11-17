import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// 第三方库：装在临时目录里，不碰 claclaw 自己的 vendor/
const V = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-'));
process.env.CLACLAW_VENDOR = V;
const { libInstall: install0, libInstallFile, libFetch, libInfo, libImport, libDir, baseOf, LIBS, newerVersion, verifySig, releaseKeyOk, fileVersion } = await import('../vendor.mjs');
const { inviteBase, inviteInfo, helloKey } = await import('../relaydev.mjs');

// 测试用的发布钥匙（正式的公钥从设备邀请码 / hello 来）
const KP = crypto.generateKeyPairSync('ed25519'), KP2 = crypto.generateKeyPairSync('ed25519');
const pubOf = kp => kp.publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
const PUB = pubOf(KP), PUB2 = pubOf(KP2);
const libInstall = (id, base, o = {}) => install0(id, base, { pubkeys: [PUB], ...o });
const signB64 = (bytes, k = KP.privateKey) => crypto.sign(null, bytes, k).toString('base64');

// 单文件客户端：第二行写版本，和 clarelay 打包出来的一样
const file = (v, extra = '') => Buffer.from(`#!/usr/bin/env node\n// clarelay ${v} 电脑端（客户端）单文件版\nexport const VERSION = '${v}';\nexport const startDevice = () => '${v}';${extra}\n`);
// 假的 clarelay 下载地址
function serve(bytes, { key = KP.privateKey, nosig = false, sigOf = null, redirect = false } = {}) {
  const L = LIBS.clarelay, routes = { [L.file]: bytes };
  if (!nosig) routes[L.sig] = signB64(sigOf || bytes, key);
  const hits = [];
  const s = http.createServer((q, r) => {
    hits.push(q.url);
    if (redirect) { r.writeHead(302, { location: 'http://127.0.0.1:1/x' }); return r.end(); }
    const b = routes[q.url]; r.writeHead(b ? 200 : 404); r.end(b || '');
  });
  return new Promise(ok => s.listen(0, '127.0.0.1', () => ok({ base: 'http://127.0.0.1:' + s.address().port, close: () => s.close(), hits })));
}

test('下载地址只认 https（本机回环可以 http）', () => {
  assert.throws(() => baseOf('http://relay.example.com'), /https/);
  assert.throws(() => baseOf('https://u:p@relay.example.com'), /用户名/);
  assert.equal(baseOf('https://relay.example.com/x/y?z'), 'https://relay.example.com');
  assert.equal(baseOf('http://127.0.0.1:9/'), 'http://127.0.0.1:9');
});

test('公钥格式、文件里的版本号', () => {
  assert.equal(releaseKeyOk(PUB), PUB);
  assert.equal(releaseKeyOk(' ' + PUB + '\n'), PUB);
  assert.equal(releaseKeyOk('abc'), '');
  const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  assert.equal(releaseKeyOk(rsa), '', '只认 Ed25519');
  assert.equal(fileVersion('clarelay', file('0.5.2')), '0.5.2');
  assert.equal(fileVersion('clarelay', Buffer.from('export const x = 1;\n')), '');
});

test('装、重复装不动、换新版、留上一个版本', async () => {
  assert.equal(libInfo('clarelay').installed, false);
  assert.equal(await libImport('clarelay'), null);
  const s1 = await serve(file('0.5.2'));
  const r1 = await libInstall('clarelay', s1.base);
  assert.equal(r1.changed, true);
  assert.equal(libInfo('clarelay').version, '0.5.2');
  assert.equal(libInfo('clarelay').signed, true);
  assert.equal((await libImport('clarelay')).startDevice(), '0.5.2');
  const d1 = libDir('clarelay');
  assert.equal((await libInstall('clarelay', s1.base)).changed, false, '同一份不重下');
  s1.close();
  const s2 = await serve(file('0.5.3'));
  assert.equal((await libInstall('clarelay', s2.base)).changed, true);
  assert.equal((await libImport('clarelay')).startDevice(), '0.5.3', '新目录重新 import，不拿缓存里的旧模块');
  assert.ok(fs.existsSync(d1), '上一个版本留着');
  s2.close();
  const s3 = await serve(file('0.5.4'));
  await libInstall('clarelay', s3.base);
  assert.ok(!fs.existsSync(d1), '更早的删掉');
  assert.equal(fs.readdirSync(path.join(V, 'clarelay')).filter(n => !n.endsWith('.json')).length, 2);
  s3.close();
});

test('签名：没公钥不下载；签名不对、没签名、签的不是这份文件：不装，当前版本不变', async () => {
  const before = libInfo('clarelay').version;
  const s = await serve(file('0.6.0'));
  await assert.rejects(install0('clarelay', s.base, { pubkeys: [] }), /还没有发布公钥/);
  assert.equal(s.hits.length, 0, '没公钥：一个请求都不发');
  await assert.rejects(install0('clarelay', s.base, { pubkeys: ['abc'] }), /还没有发布公钥/, '格式不对的公钥当没有');
  await assert.rejects(install0('clarelay', s.base, { pubkeys: [PUB2] }), /签名不对/);
  s.close();
  const s2 = await serve(file('0.6.0'), { nosig: true });
  await assert.rejects(libInstall('clarelay', s2.base), /读不到签名/);
  s2.close();
  const s3 = await serve(file('0.6.0'), { sigOf: file('0.6.0', '\n// 别的') });
  await assert.rejects(libInstall('clarelay', s3.base), /签名不对/);
  s3.close();
  const s4 = await serve(file('0.6.0'), { key: KP2.privateKey });
  await assert.rejects(libInstall('clarelay', s4.base), /签名不对/);
  assert.equal((await install0('clarelay', s4.base, { pubkeys: [PUB, PUB2] })).changed, true, '多把公钥任一验得过就算');
  s4.close();
  assert.notEqual(libInfo('clarelay').version, before);
});

test('跳转、降级、低于最低版本、没版本号：不装，当前版本不变', async () => {
  const cur = libInfo('clarelay').version;
  const s1 = await serve(file('0.9.0'), { redirect: true });
  await assert.rejects(libInstall('clarelay', s1.base), /下载不了/);
  s1.close();
  const s2 = await serve(file('0.5.2'));
  await assert.rejects(libInstall('clarelay', s2.base), /不降级/);
  s2.close();
  const s3 = await serve(file('0.5.1'));
  await assert.rejects(libFetch('clarelay', s3.base, { pubkeys: [PUB] }), /至少 0\.5\.2/);
  s3.close();
  const s4 = await serve(Buffer.from('export const startDevice = () => 1;\n'));
  await assert.rejects(libInstall('clarelay', s4.base), /读不到版本号/);
  s4.close();
  assert.equal(libInfo('clarelay').version, cur);
});

test('本机文件装的（未签名）不受不降级限制，能被签名版替换', async () => {
  const f = path.join(V, 'local.mjs');
  fs.writeFileSync(f, file('0.5.2', '\n// local'));
  const r = await libInstallFile('clarelay', f);
  assert.equal(r.changed, true);
  assert.equal(libInfo('clarelay').signed, false);
  assert.equal(libInfo('clarelay').version, '0.5.2');
  const s = await serve(file('0.5.2'));
  assert.equal((await libInstall('clarelay', s.base)).changed, true, '未签名之后同版本的签名版照常装');
  assert.equal(libInfo('clarelay').signed, true);
  s.close();
  fs.writeFileSync(f, file('0.5.1'));
  await assert.rejects(libInstallFile('clarelay', f), /至少 0\.5\.2/, '本机文件也不能低于最低版本');
});

test('设备邀请码：下载地址、发布公钥；版本比较', () => {
  const compact = 'clarelay-device1.' + Buffer.from(JSON.stringify({ d: 'Relay.Example.com', c: 'x', k: PUB })).toString('base64url');
  assert.deepEqual(inviteInfo(compact), { base: 'https://relay.example.com', domain: 'relay.example.com', key: PUB });
  assert.equal(inviteBase(JSON.stringify({ clarelay: 'device-invite', relay: 'relay.example.com', port: 8443, code: 'x' })), 'https://relay.example.com:8443');
  assert.equal(inviteInfo(JSON.stringify({ relay: 'relay.example.com', code: 'x', releaseKey: 'bad' })).key, '', '格式不对的公钥当没有');
  assert.equal(inviteBase('垃圾'), '');
  assert.equal(newerVersion('0.10.0', '0.9.9'), true);
  assert.equal(newerVersion('0.5.2', '0.5.2'), false);
  assert.equal(newerVersion('0.5.1', '0.5.2'), false);
  assert.equal(verifySig(Buffer.from('a'), 'xx', [PUB]), false);
});

// 老电脑取公钥：假的 TLS 连接，按 PROTOCOL.md §9.1 回 101，再发一行 hello
function fakeConnect(reply, { hello = { t: 'hello', status: 'active', releaseKey: PUB } } = {}) {
  const sent = [];
  const connect = () => {
    const s = new EventEmitter(); s.destroy = () => {};
    s.write = d => { sent.push(String(d)); setTimeout(() => { s.emit('data', Buffer.from(reply)); if (reply.startsWith('HTTP/1.1 101')) { s.emit('data', Buffer.from('{"t":"pi')); s.emit('data', Buffer.from('ng"}\n\n[1]\n' + JSON.stringify(hello) + '\n')); } }, 5); };
    setTimeout(() => s.emit('secureConnect'), 1);
    return s;
  };
  return { connect, sent };
}
test('老电脑取发布公钥：带设备凭证连控制连接，读 hello 里的 releaseKey', async () => {
  const st = { id: 'dev1', token: 'tok', domain: 'Relay.Example.com', port: 443 };
  const f = fakeConnect('HTTP/1.1 101 Switching Protocols\r\nupgrade: clarelay\r\nconnection: Upgrade\r\n\r\n');
  assert.equal(await helloKey(st, { connect: f.connect }), PUB);
  assert.match(f.sent[0], /^GET \/_device\/control HTTP\/1\.1\r\nhost: relay\.example\.com\r\nconnection: Upgrade\r\nupgrade: clarelay\r\nauthorization: Bearer tok\r\nx-device-id: dev1\r\n\r\n$/);
  const bad = fakeConnect('HTTP/1.1 101 Switching Protocols\r\n\r\n', { hello: { t: 'hello', releaseKey: 'abc' } });
  assert.equal(await helloKey(st, { connect: bad.connect }), '', '格式不对的当没有');
  await assert.rejects(helloKey(st, { connect: fakeConnect('HTTP/1.1 401 Unauthorized\r\n\r\n').connect }), /凭证不对/);
  await assert.rejects(helloKey({ id: 'x' }, { connect: f.connect }), /不完整/);
});
