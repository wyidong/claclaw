import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// 测试实例：身份文件放在数据目录里，不碰本机 ~/.clarelay-device.json，也不去停单独安装的电脑端
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-'));
process.env.CLACLAW_DATA = DATA;
delete process.env.CLACLAW_CLARELAY_STATE;
const { makeRelayDev, relayStatePath } = await import('../src/peer/relaydev.mjs');
const STATE = path.join(DATA, 'clarelay-device.json');

function harness(off0 = false) {
  const calls = [], devs = [];
  let off = off0;
  const load = async () => ({
    async startDevice(o) {
      calls.push(o);
      if (o.invite) fs.writeFileSync(STATE, JSON.stringify({ id: 'd1', label: 'x', domain: 'relay.test', name: o.name, status: 'active' }));
      else if (!fs.existsSync(STATE)) throw new Error('还没加入设备圈：需要设备邀请码');
      const d = Object.assign(new EventEmitter(), { url: 'https://x.relay.test', shellUrl: 'https://relay.test', online: true, status: 'active', name: o.name, cert: { ok: true }, stopped: 0,
        async stop() { this.stopped++; } });
      return d;
    },
  });
  const rd = makeRelayDev({ port: 8787, DATA, log() {}, getOff: () => off, setOff: v => { off = v; }, onDevice: d => devs.push(d), load });
  return { rd, calls, devs, isOff: () => off };
}

test('身份文件在数据目录里', () => { assert.equal(relayStatePath(DATA), STATE); });

test('加入、断开、连接、移除', async () => {
  try { fs.unlinkSync(STATE); } catch {}
  const h = harness();
  assert.equal(h.rd.info().joined, false);
  h.rd.autoStart(); await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.length, 0, '没加入：启动时不连');
  await assert.rejects(h.rd.join('abc'), /不是 clarelay 设备邀请码/);
  await assert.rejects(h.rd.join('{"domain":'), /不是完整的 JSON/);

  const i1 = await h.rd.join(' clarelay-device1.xyz ');
  assert.equal(h.calls[0].invite, 'clarelay-device1.xyz');
  assert.equal(h.calls[0].state, STATE);
  assert.deepEqual(h.calls[0].services, { claclaw: 'http://127.0.0.1:8787' });
  assert.ok(i1.joined && i1.running && i1.online);
  assert.equal(i1.url, 'https://x.relay.test');
  assert.ok(h.devs.at(-1));

  const i2 = await h.rd.disconnect();
  assert.equal(h.isOff(), true);
  assert.equal(h.devs.at(-1), null);
  assert.ok(i2.joined && !i2.running && i2.off);

  // 断开了：重启后不自动连
  const h2 = harness(true); h2.rd.autoStart(); await new Promise(r => setTimeout(r, 20));
  assert.equal(h2.calls.length, 0);

  const i3 = await h.rd.connect();
  assert.equal(h.calls.at(-1).invite, undefined, '再连不用邀请码');
  assert.ok(i3.running && !i3.off);

  const i4 = await h.rd.remove();
  assert.equal(fs.existsSync(STATE), false);
  assert.ok(!i4.joined && !i4.running);
  await assert.rejects(h.rd.connect(), /先粘贴设备邀请码/);
});

test('有身份、没断开：启动时自动连', async () => {
  fs.writeFileSync(STATE, JSON.stringify({ id: 'd1', label: 'x', domain: 'relay.test' }));
  const h = harness();
  h.rd.autoStart(); await new Promise(r => setTimeout(r, 20));
  assert.equal(h.calls.length, 1);
  assert.ok(h.rd.info().running);
  await h.rd.stop();
  fs.writeFileSync(STATE, JSON.stringify({ id: 'd1', revoked: true }));
  const h2 = harness(); h2.rd.autoStart(); await new Promise(r => setTimeout(r, 20));
  assert.equal(h2.calls.length, 0, '撤销了：不连');
});

test('devnotify：内置时直接调电脑端，不走本机接口', async () => {
  process.env.CLACLAW_CLARELAY_LOCAL = path.join(DATA, 'none.local.json');
  const dn = await import('../src/peer/devnotify.mjs');
  assert.equal(dn.devConfigured(), false);
  const got = [];
  const d = Object.assign(new EventEmitter(), { online: true, push: true, status: 'active', url: 'https://x', shellUrl: 'https://s', name: 'mac', id: 'd1',
    notify: e => got.push(['notify', e]), read: e => got.push(['read', e]), sync: e => got.push(['sync', e]) });
  dn.useDevice(d);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(dn.devConfigured(), true);
  assert.equal(dn.devStatus().online, true);
  assert.equal(dn.devStatus().builtin, true);
  dn.devNotify({ target: 's1', kind: 'reply', title: 't', snippet: 'hi', unread: 2 });
  dn.devRead('s1');
  const j = await dn.devSync([{ target: 's1', unread: 1 }]);
  await new Promise(r => setTimeout(r, 20));
  assert.deepEqual(got.map(x => x[0]), ['notify', 'read', 'sync']);
  assert.equal(got[0][1].app, 'claclaw');
  assert.equal(j.ok, true);
  dn.useDevice(null);
  assert.equal(dn.devConfigured(), false);
});

test('邀请码里的发布公钥：加入成功才记下（按域名），移除时删掉；格式不对的当没有', async () => {
  const { inviteInfo } = await import('../src/peer/relaydev.mjs');
  const crypto = await import('node:crypto');
  const KEY = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const b64 = o => Buffer.from(JSON.stringify(o)).toString('base64url');
  assert.deepEqual(inviteInfo('clarelay-device1.' + b64({ d: 'Relay.Test', c: 'x', k: KEY })), { base: 'https://relay.test', domain: 'relay.test', key: KEY });
  assert.equal(inviteInfo(JSON.stringify({ clarelay: 'device-invite', relay: 'relay.test', code: 'x', releaseKey: KEY })).key, KEY);
  assert.equal(inviteInfo('clarelay-device1.' + b64({ d: 'relay.test', c: 'x', k: 'abc' })).key, '', '格式不对的当没有');
  assert.equal(inviteInfo('clarelay-device1.' + b64({ d: 'relay.test', c: 'x', k: crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64') })).key, '', '不是 Ed25519 的不要');

  try { fs.unlinkSync(STATE); } catch {}
  const KEYS = path.join(DATA, 'clarelay-release-keys.json');
  try { fs.unlinkSync(KEYS); } catch {}
  const h = harness();
  await h.rd.join('clarelay-device1.' + b64({ d: 'relay.test', c: 'x', k: KEY }));
  assert.equal(JSON.parse(fs.readFileSync(KEYS, 'utf8'))['relay.test'].key, KEY);
  if (process.platform !== 'win32') assert.equal(fs.statSync(KEYS).mode & 0o777, 0o600);
  await h.rd.remove();
  assert.equal(JSON.parse(fs.readFileSync(KEYS, 'utf8'))['relay.test'], undefined);
});

test('老电脑（身份文件里没公钥、还没下载电脑端）启动时：在 start 里连一次控制连接取公钥再下载', async () => {
  const crypto = await import('node:crypto');
  const KEY = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const V = fs.mkdtempSync(path.join(os.tmpdir(), 'rd-vendor-')), old = process.env.CLACLAW_VENDOR;
  process.env.CLACLAW_VENDOR = V;
  const KEYS = path.join(DATA, 'clarelay-release-keys.json');
  try { fs.unlinkSync(KEYS); } catch {}
  fs.writeFileSync(STATE, JSON.stringify({ id: 'd1', token: 't', label: 'x', domain: 'relay.invalid', status: 'active' }));
  const hello = [];
  const rd = makeRelayDev({ port: 8787, DATA, log() {}, getOff: () => false, setOff() {}, onDevice() {}, helloKey: async st => { hello.push(st.id); return KEY; } });
  try {
    await assert.rejects(rd.connect(), /下载 clarelay 电脑端没成/);   // relay.invalid 下载不了；关键是先取到了公钥
    assert.deepEqual(hello, ['d1'], 'start 里也要能连控制连接取公钥');
    assert.equal(JSON.parse(fs.readFileSync(KEYS, 'utf8'))['relay.invalid'].key, KEY);
  } finally { process.env.CLACLAW_VENDOR = old; if (old === undefined) delete process.env.CLACLAW_VENDOR; try { fs.unlinkSync(STATE); } catch {} }
});
