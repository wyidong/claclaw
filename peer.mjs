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
  return { ...DEFAULTS, ...c, peers: Array.isArray(c.peers) ? c.peers : [] };
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
