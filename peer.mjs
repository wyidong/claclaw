// claclaw 协同：两台电脑上的 AI 会话直接互发消息（第一版只走局域网）。
// - 我们这边在局域网 IP 的一个端口（默认 8788）上开收件地址：http://<局域网 IP>:<端口>/claclaw-peer/<配对码>
//     GET  …/sessions  → 加入协同的会话列表
//     POST …            {from, text, session?} → 送进会话，等这一轮回复完，返回 {ok, reply}
// - 对方的地址（IP、端口、配对码）填进来以后，加入协同的会话里多两个工具：查看对方会话、给对方发消息。
// 配置只能在本机（127.0.0.1）打开网页时修改；配对码就是授权，存在 data/peer.json（只有本人可读）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { DATA } from './auth.mjs';

const FILE = path.join(DATA, 'peer.json');
export const PEER_PATH = '/claclaw-peer/';
const DEFAULTS = { enabled: false, port: 8788, code: '', dir: '', sessions: [], remote: { ip: '', port: 8788, code: '', url: '' } };

export function loadPeer() {
  try { const c = JSON.parse(fs.readFileSync(FILE, 'utf8')); return { ...DEFAULTS, ...c, remote: { ...DEFAULTS.remote, ...(c.remote || {}) } }; }
  catch { return { ...DEFAULTS, remote: { ...DEFAULTS.remote } }; }
}
export function savePeer(c) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(c, null, 2), { mode: 0o600 });
}

// 配对码：16 位（去掉易混的 0/O/1/I），四位一组，约 80 位随机
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function newCode() {
  const b = crypto.randomBytes(16);
  let s = '';
  for (let i = 0; i < 16; i++) s += ALPHA[b[i] % ALPHA.length];
  return s.match(/.{4}/g).join('-');
}
const norm = c => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export function codeMatches(given, code) {
  const a = Buffer.from(norm(given)), b = Buffer.from(norm(code));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

// 局域网 IP：en* 网卡上的私有 IPv4（第一版只支持局域网）
export function lanIp() {
  for (const [ifn, list] of Object.entries(os.networkInterfaces())) {
    if (!/^en\d/.test(ifn)) continue;
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address)) return a.address;
    }
  }
  return null;
}
export const ourUrl = c => { const ip = lanIp(); return ip && c.code ? 'http://' + ip + ':' + c.port + PEER_PATH + c.code : ''; };
// 对方地址：填了完整网址（再长都行，可以带 ?参数）就直接用；否则按 IP + 端口 + 配对码拼（和我们的格式一样）
export function remoteUrl(c) {
  const r = c.remote || {};
  if (r.url) return r.url;
  if (/^https?:\/\//i.test(r.ip || '')) return r.ip.replace(/\/+$/, '');
  if (!r.ip || !r.code) return '';
  return 'http://' + r.ip + ':' + (r.port || 8788) + PEER_PATH + r.code;
}

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

// ---------- 发给对方 ----------
export async function remoteCall(c, sub, body, ms = 10 * 60 * 1000) {
  const url = remoteUrl(c);
  if (!url) throw new Error('还没填对方的地址');
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try {
    // 子路径（/sessions）接在路径后面，保留网址里原有的 ?参数
    const u = new URL(url);
    if (sub) u.pathname = u.pathname.replace(/\/+$/, '') + sub;
    const r = await fetch(u, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal } : { signal: ctl.signal });
    const text = await r.text();
    let j; try { j = JSON.parse(text); } catch { j = { ok: r.ok, reply: text }; }
    if (!r.ok && !j.error) j.error = 'HTTP ' + r.status;
    return j;
  } catch (e) {
    throw new Error(e.name === 'AbortError' ? '对方超时没有回复' : '连不上对方：' + (e.cause?.code || e.message));
  } finally { clearTimeout(t); }
}
