#!/usr/bin/env node
// 隧道（跑在你自己的电脑上）：主动连到中继，领一个公开地址，把别人发到这个地址的请求转给本地服务。
// 和 relay.mjs 配套，不依赖任何第三方包；本地服务是什么都行（claclaw 协同、你自己的工具……）。
//
// 运行：
//   node relay-tunnel.mjs --relay https://服务器IP:8790 --pin sha256//… --key 注册口令 --to http://127.0.0.1:8788
//   --relay  中继地址（relay.mjs 启动时打印的）
//   --pin    中继证书指纹（relay.mjs 启动时打印的；中继用 --plain 时不用填）
//   --key    注册口令（relay.mjs 启动时打印的）
//   --to     要暴露的本地服务地址，例如 claclaw 协同的 http://192.168.1.x:8788
//   --state  记住名字和隧道密钥的文件（默认 ~/.relay-tunnel.json）：重启后公开地址不变
// 启动后打印公开地址，例如 https://服务器IP:8790/t/AbC…xyz —— 把它（连同 pin）给要访问你的人。
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';

const arg = k => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : undefined; };
const RELAY = String(arg('relay') || '').replace(/\/+$/, ''), PIN = arg('pin') || '', KEY = arg('key') || '', TO = String(arg('to') || '').replace(/\/+$/, '');
const STATE = arg('state') || path.join(os.homedir(), '.relay-tunnel.json');
const POLLERS = 4;   // 同时等几个请求（对方可能同时发好几个）
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (!RELAY || !KEY || !TO) { console.log('用法：node relay-tunnel.mjs --relay https://服务器IP:8790 --pin sha256//… --key 注册口令 --to http://127.0.0.1:端口'); process.exit(1); }
if (RELAY.startsWith('https:') && !PIN) { console.log('中继是 https：要加 --pin（relay.mjs 启动时打印的证书指纹）'); process.exit(1); }

// 名字 + 隧道密钥：第一次生成，存下来，以后公开地址不变（每个中继一份）
let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
st[RELAY] ||= { name: crypto.randomBytes(15).toString('base64url'), secret: crypto.randomBytes(24).toString('base64url') };
fs.writeFileSync(STATE, JSON.stringify(st, null, 2), { mode: 0o600 });
const { name, secret } = st[RELAY];

// 请求中继：https 时只认 pin 对得上的证书
const pinOf = cert => 'sha256//' + crypto.createHash('sha256').update(cert.publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
function pinnedConnect(opts, cb) {
  const s = tls.connect({ host: opts.host, port: opts.port, servername: opts.servername, rejectUnauthorized: false });
  s.once('secureConnect', () => {
    const got = pinOf(s.getPeerX509Certificate());
    if (got === PIN) cb(null, s);
    else { s.destroy(); cb(new Error('中继证书指纹对不上（' + got + '），拒绝连接')); }
  });
  s.once('error', e => cb(e));
}
function relayCall(method, p, body, ms) {
  const u = new URL(RELAY + p);
  const mod = u.protocol === 'https:' ? https : http;
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((ok, bad) => {
    const req = mod.request(u, {
      method, timeout: ms,
      headers: { 'x-relay-key': KEY, 'x-tunnel-secret': secret, ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}) },
      // 自签证书：不走 CA 校验，改成握手完成后、发出任何数据之前核对指纹（对不上就断开，注册口令不会发出去）
      ...(u.protocol === 'https:' ? { createConnection: pinnedConnect } : {}),
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let j = null; try { j = t ? JSON.parse(t) : null; } catch {} ok({ status: res.statusCode, j }); });
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', bad);
    if (data) req.write(data);
    req.end();
  });
}

// 把一个请求转给本地服务，拿回响应
function local(job) {
  const u = new URL(TO + job.path);
  const mod = u.protocol === 'https:' ? https : http;
  const body = Buffer.from(job.body || '', 'base64');
  return new Promise(ok => {
    const req = mod.request(u, { method: job.method, headers: { ...job.headers, host: u.host, 'content-length': body.length }, timeout: 11 * 60 * 1000 }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => ok({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('base64') }));
    });
    req.on('timeout', () => req.destroy(new Error('本地服务超时')));
    req.on('error', e => ok({ status: 502, headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify({ ok: false, error: '本地服务连不上：' + e.message })).toString('base64') }));
    req.end(body);
  });
}

const q = '?name=' + encodeURIComponent(name);
async function poller() {
  for (;;) {
    try {
      const r = await relayCall('GET', '/_relay/poll' + q, null, 40e3);
      if (r.status === 200 && r.j?.id) {
        const out = await local(r.j);
        await relayCall('POST', '/_relay/reply' + q + '&id=' + encodeURIComponent(r.j.id), out, 30e3).catch(e => log('交回响应失败', e.message));
      } else if (r.status !== 204) { log('中继返回', r.status, r.j?.error || ''); await new Promise(s => setTimeout(s, 5000)); }
    } catch (e) { log('连不上中继：', e.message, '，5 秒后重试'); await new Promise(s => setTimeout(s, 5000)); }
  }
}

const r = await relayCall('POST', '/_relay/register' + q, {}, 15e3).catch(e => ({ status: 0, j: { error: e.message } }));
if (r.status !== 200) { console.log('登记失败：', r.j?.error || 'HTTP ' + r.status); process.exit(1); }
console.log('隧道已连上。公开地址：' + RELAY + r.j.path + '  →  转给 ' + TO);
if (PIN) console.log('访问的人要核对中继证书指纹：' + PIN);
for (let i = 0; i < POLLERS; i++) poller();
