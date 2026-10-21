// claclaw 协同：两台电脑上的 AI 会话直接互发消息（第一版只走局域网）。
//
// 对外只有一个固定地址：http://<局域网 IP>:<端口>/claclaw-peer（地址里不含密码）。
// 配对（像蓝牙）：
//   1. 对方 POST /claclaw-peer/pair {name, inbox?}           → {requestId}；我们这边页面上出现申请（对方 IP、名字、两位数配对码）
//   2. 我们的人核对后，把两位数配对码告诉对方（微信 / 口头）
//   3. 对方 POST /claclaw-peer/pair/confirm {requestId, code, token?} → {token, name, inbox}
//      token：以后对方找我们用的钥匙；对方带上的 token：以后我们找对方用的钥匙（双向一次配好）
//   配对码只对这一次申请有效，5 分钟过期，最多输错 3 次。
// 配对后（请求头 Authorization: Bearer <token>）：
//   GET  /claclaw-peer/sessions → 加入协同的会话
//   POST /claclaw-peer {from, text, session?} → 送进会话，等这一轮回复完，返回 {ok, reply}
// 配置只能在本机（127.0.0.1）打开网页时修改；存在 data/peer.json（只有本人可读），我们发出去的钥匙只存哈希。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DATA } from './auth.mjs';

const FILE = path.join(DATA, 'peer.json');
export const PEER_BASE = '/claclaw-peer';
const DEFAULTS = { enabled: false, port: 8788, dir: '', sessions: [], name: '', peers: [] };

export function loadPeer() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const out = { ...DEFAULTS, ...c, peers: Array.isArray(c.peers) ? c.peers : [], last: c.last && typeof c.last === 'object' ? c.last : {} };
  // 每个已配对的对方一个固定编号（①②③…），会话列表里用编号 + 颜色标「最近和谁通信」
  let n = Math.max(0, ...out.peers.map(p => p.no || 0));
  for (const p of out.peers) if (!p.no) p.no = ++n;
  return out;
}
export const nextPeerNo = c => Math.max(0, ...c.peers.map(p => p.no || 0)) + 1;
// 记下这个会话最近一次和哪个对方通信（收到或发出都算）
export function markLast(sessionId, peerId) {
  const c = loadPeer();
  c.last[sessionId] = { peer: peerId, at: Date.now() };
  savePeer(c);
}
export function savePeer(c) {
  const { code, remote, ...keep } = c;   // 旧版的「地址里带配对码」配置不再保存
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(keep, null, 2), { mode: 0o600 });
}
export const myName = c => c.name || os.hostname().replace(/\.local$/, '');

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const hashToken = t => crypto.createHash('sha256').update(String(t)).digest('hex');
export const newId = () => crypto.randomBytes(6).toString('hex');
export function findPeerByToken(c, token) {
  if (!token) return null;
  const h = Buffer.from(hashToken(token));
  return c.peers.find(p => p.tokenHash && p.tokenHash.length === h.length && crypto.timingSafeEqual(Buffer.from(p.tokenHash), h)) || null;
}

// 局域网 IP：en* 网卡上的私有 IPv4
export function lanIp() {
  for (const [ifn, list] of Object.entries(os.networkInterfaces())) {
    if (!/^en\d/.test(ifn)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}
export const ourBase = c => { const ip = lanIp(); return ip ? 'http://' + ip + ':' + c.port + PEER_BASE : ''; };

// ---------- 配对申请（只放内存：重启就作废，本来就只有 5 分钟） ----------
export const PAIR_TTL = 5 * 60 * 1000;
const pending = new Map();   // requestId → {id, name, ip, inbox, code, expiresAt, tries}
export function pendingList() {
  const now = Date.now();
  for (const [k, p] of pending) if (p.expiresAt < now) pending.delete(k);
  return [...pending.values()];
}
export function addPending(name, ip, inbox) {
  const list = pendingList();
  if (list.length >= 5) throw Object.assign(new Error('配对申请太多，稍后再试'), { code: 429 });
  for (const p of list) if (p.ip === ip) pending.delete(p.id);   // 同一台电脑只保留最新一条
  const p = { id: newId(), name, ip, inbox, code: String(10 + crypto.randomInt(90)), expiresAt: Date.now() + PAIR_TTL, tries: 0 };
  pending.set(p.id, p);
  return p;
}
export const getPending = id => (pendingList(), pending.get(id) || null);
export const dropPending = id => pending.delete(id);

// ---------- 收件服务 ----------
let srv = null, srvKey = '', srvErr = '';
export function peerStatus() { return { listening: !!srv && srv.listening, error: srvErr }; }
export function applyListener(c, handler, log) {
  const ip = lanIp();
  const key = c.enabled && ip ? ip + ':' + c.port : '';
  if (key === srvKey && (srv || !key)) return;
  if (srv) { try { srv.close(); } catch {} srv = null; log?.('peer listener stopped'); }
  srvKey = key; srvErr = '';
  if (!key) { if (c.enabled && !ip) srvErr = '没找到局域网 IP（连上 Wi-Fi 或网线后再试）'; return; }
  srv = http.createServer(handler);
  srv.on('error', e => { srvErr = e.code === 'EADDRINUSE' ? '端口 ' + c.port + ' 已被占用，换一个' : e.message; log?.('peer listener error', e.message); srv = null; srvKey = ''; });
  srv.listen(c.port, ip, () => log?.('peer listener on', key));
}

// ---------- 请求对方 ----------
// base：对方的协同地址（可以带 ?参数）；sub 接在路径后面；token 放请求头
export async function callPeer(base, sub, { token, body, ms = 10 * 60 * 1000 } = {}) {
  if (!base) throw new Error('没有对方的地址');
  const u = new URL(base);
  if (sub) u.pathname = u.pathname.replace(/\/+$/, '') + sub;
  const headers = {};
  if (token) headers.authorization = 'Bearer ' + token;
  if (body) headers['content-type'] = 'application/json';
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    const r = await fetch(u, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined, signal: ctl.signal });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { ok: r.ok, reply: text }; }
    if (!r.ok) { j.ok = false; if (!j.error) j.error = 'HTTP ' + r.status; }
    j.status = r.status;
    return j;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '对方超时没有回复' : '连不上对方：' + (e.cause?.code || e.message));
  } finally { clearTimeout(t); }
}

// ---------- 按名字找：Bonjour（mDNS）----------
// 开着协同时在局域网里广播「我是 claclaw 协同」（dns-sd -R），附近的 claclaw 一问就能列出来（dns-sd -B / -L）；
// 地址优先用「电脑名.local」，路由器换了 IP 也不用重新配对；名字查不到（有的网络屏蔽广播）再退回 IP。
import { spawn, execFileSync } from 'node:child_process';
import dns from 'node:dns';

const SVC = '_claclaw._tcp';
let localHost = null;
export function localHostName() {
  if (localHost !== null) return localHost;
  try { localHost = execFileSync('scutil', ['--get', 'LocalHostName'], { timeout: 3000 }).toString().trim(); } catch { localHost = ''; }
  return localHost;
}
export const ourBaseName = c => { const h = localHostName(); return h ? 'http://' + h + '.local:' + c.port + PEER_BASE : ''; };
export const instanceId = c => { if (!c.instanceId) { c.instanceId = newId(); savePeer(c); } return c.instanceId; };

let advert = null, advertKey = '';
export function applyAdvert(c, log) {
  const has = process.platform === 'darwin';
  const key = c.enabled && has ? myName(c) + '|' + c.port + '|' + instanceId(c) : '';
  if (key === advertKey) return;
  if (advert) { try { advert.kill(); } catch {} advert = null; }
  advertKey = key;
  if (!key) return;
  advert = spawn('dns-sd', ['-R', myName(c), SVC, 'local', String(c.port), 'path=' + PEER_BASE, 'id=' + instanceId(c), 'host=' + localHostName() + '.local'], { stdio: 'ignore' });
  advert.on('exit', () => { advert = null; advertKey = ''; });
  log?.('peer bonjour advertised as', myName(c));
}
process.on('exit', () => { try { advert?.kill(); } catch {} });

// 跑一个 dns-sd 命令若干毫秒，收集输出
function dnssd(args, ms) {
  return new Promise(ok => {
    let out = '';
    const p = spawn('dns-sd', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    p.stdout.on('data', d => { out += d; });
    p.on('error', () => ok(''));
    setTimeout(() => { try { p.kill(); } catch {} ok(out); }, ms);
  });
}
const lookup4 = host => new Promise(ok => dns.lookup(host, { family: 4 }, (e, a) => ok(e ? '' : a)));
// 附近的 claclaw：名字、主机名、IP、协同地址（不含自己）
export async function discover(c) {
  if (process.platform !== 'darwin') return [];
  const browse = await dnssd(['-B', SVC, 'local'], 2500);
  const names = [...new Set(browse.split('\n').map(l => l.match(/\sAdd\s+\d+\s+\d+\s+\S+\s+_claclaw\._tcp\.\s+(.+)$/)?.[1]?.trim()).filter(Boolean))];
  const found = await Promise.all(names.map(async raw => {
    const n = raw.replace(/\\(\d{3})/g, (_, d) => String.fromCharCode(+d));   // dns-sd 把空格等写成 \032
    const out = await dnssd(['-L', n, SVC, 'local'], 1500);
    const m = out.match(/can be reached at (\S+?)\.?:(\d+)/);
    if (!m) return null;
    const txt = k => (out.match(new RegExp('\\b' + k + '=(\\S+)')) || [])[1] || '';
    if (txt('id') === instanceId(c)) return null;   // 自己
    const host = m[1].replace(/\.$/, ''), port = Number(m[2]), path = txt('path') || PEER_BASE;
    const ip = await lookup4(host);
    return { name: n, host, ip, port, base: 'http://' + host + ':' + port + path, baseIp: ip ? 'http://' + ip + ':' + port + path : '' };
  }));
  return found.filter(Boolean);
}

// 请求已配对的对方：先用名字地址，连不上再用 IP 地址（成功的那个以后优先用）
export async function peerCall(c, p, sub, opts) {
  const tries = [p.inbox, p.inboxAlt].filter(Boolean);
  if (p.ip && p.inbox) { try { const u = new URL(p.inbox); if (u.hostname !== p.ip) { u.hostname = p.ip; tries.push(u.toString().replace(/\/$/, '')); } } catch {} }
  let err;
  for (const [i, url] of [...new Set(tries)].entries()) {
    try {
      const j = await callPeer(url, sub, { token: p.theirToken, ...opts, ms: i ? Math.min(opts?.ms || 8000, 8000) : opts?.ms });
      if (i && url !== p.inbox) { const old = p.inbox; p.inbox = url; p.inboxAlt = old; savePeer(c); }   // 换了能用的那个当首选
      return j;
    } catch (e) { err = e; }
  }
  throw err || new Error('没有对方的地址');
}
