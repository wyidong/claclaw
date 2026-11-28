import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRelayPair, normBase, fmtCode, qrSvg } from '../src/peer/relaypair.mjs';

// 身份文件也放临时目录：不读这台电脑真的 ~/.clarelay-device.json
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'crpair-')); process.env.CLACLAW_CLARELAY_STATE = path.join(d, 'clarelay-device.json'); return d; };
// 假中继：按路由回 JSON；记下收到的请求
function fakeRelay(routes) {
  const calls = [];
  const f = async (url, init = {}) => {
    const u = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: u.pathname, body, origin: u.origin });
    const h = routes[u.pathname];
    const [status, j] = h ? h(body, calls) : [404, { error: 'no' }];
    return { ok: status < 400, status, json: async () => j };
  };
  return { f, calls };
}
const wait = ms => new Promise(r => setTimeout(r, ms));

test('中继地址：只认 https 域名，去掉路径', () => {
  assert.equal(normBase('relay.example.com'), 'https://relay.example.com');
  assert.equal(normBase('https://Relay.Example.com/claclaw/x'), 'https://relay.example.com');
  assert.equal(normBase('relay.example.com:8443'), 'https://relay.example.com:8443');
  assert.equal(normBase('http://relay.example.com'), '');
  assert.equal(normBase('localhost'), '');
  assert.equal(normBase(''), '');
  assert.equal(fmtCode('abcdefgh'), 'ABCD-EFGH');
  assert.match(qrSvg('https://relay.example.com/pair#ABCDEFGH'), /^<svg [^>]*viewBox="0 0 \d+ \d+"/);
});

test('不知道中继：要用户填；填了先 hello 确认再记住，之后不用再填', async () => {
  const DATA = tmp();
  const { f, calls } = fakeRelay({
    '/_device/hello': () => [200, { clarelay: true, pair: true }],
    '/_device/pair/start': () => [200, { code: 'ABCDEFGH', poll: 'secret-poll', expires: Date.now() + 600e3, interval: 2, url: 'https://relay.example.com/pair#ABCDEFGH' }],
    '/_device/pair/cancel': () => [200, { ok: true }],
  });
  const p = makeRelayPair({ DATA, log() {}, join: async () => ({}), fetch: f });
  assert.deepEqual(await p.start(), { status: 'need-relay' });
  const v = await p.start('relay.example.com');
  assert.equal(v.status, 'waiting');
  assert.equal(v.code, 'ABCD-EFGH');
  assert.ok(!JSON.stringify(v).includes('secret-poll'), '取件钥匙不给网页');
  assert.deepEqual(calls.map(c => c.path), ['/_device/hello', '/_device/pair/start']);
  assert.equal(p.bases()[0], 'https://relay.example.com');
  await p.cancel();
  assert.equal(calls.at(-1).path, '/_device/pair/cancel');
  assert.equal(calls.at(-1).body.poll, 'secret-poll');
});

test('不是 clarelay / 不支持扫码：不记住', async () => {
  const DATA = tmp();
  const { f } = fakeRelay({ '/_device/hello': () => [200, { clarelay: true, pair: false }] });
  const p = makeRelayPair({ DATA, log() {}, join: async () => ({}), fetch: f });
  await assert.rejects(p.start('relay.example.com'), /还不支持扫码/);
  assert.deepEqual(p.bases(), []);
});

test('手机确认后：拿到邀请码走加入流程；中继重启过（gone）自动重新出码', async () => {
  const DATA = tmp();
  fs.writeFileSync(path.join(DATA, 'install-origin.json'), JSON.stringify({ relay: 'https://relay.example.com/claclaw' }));
  let n = 0, polls = 0;
  const { f, calls } = fakeRelay({
    '/_device/pair/start': () => [200, { code: 'CODE000' + (++n), poll: 'p' + n, expires: Date.now() + 600e3, interval: 0.05, url: 'https://relay.example.com/pair#X' + n }],
    '/_device/pair/poll': b => { polls++; return b.poll === 'p1' ? [200, { status: 'gone' }] : polls < 4 ? [200, { status: 'waiting' }] : [200, { status: 'done', invite: 'clarelay-device1.xyz', account: 'bo***@example.com' }]; },
  });
  const joined = [];
  const p = makeRelayPair({ DATA, log() {}, join: async inv => { joined.push(inv); return {}; }, fetch: f, minInterval: 0 });
  assert.equal((await p.start()).code, 'CODE-0001');   // 安装时记下的中继，不用填
  assert.equal(calls[0].origin, 'https://relay.example.com');
  for (let i = 0; i < 100 && p.status().status !== 'done'; i++) await wait(20);
  const v = p.status();
  assert.equal(v.status, 'done');
  assert.equal(v.code, 'CODE-0002', 'gone 之后换了新码');
  assert.equal(v.account, 'bo***@example.com');
  assert.deepEqual(joined, ['clarelay-device1.xyz']);
});
