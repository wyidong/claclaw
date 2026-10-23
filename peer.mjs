// claclaw 协同：两台电脑上的 AI 会话直接互发消息（第一版只走局域网）。
//
// 对外只有一个固定地址：http://<局域网 IP>:<端口>/claclaw-peer（地址里不含密码）。
// 配对（像蓝牙）：
//   1. 对方 POST /claclaw-peer/pair {name, inbox?}           → {requestId}；我们这边页面上出现申请（对方 IP、名字、两位数配对码）
//   2. 我们的人核对后，把两位数配对码告诉对方（微信 / 口头）
//   3. 对方 POST /claclaw-peer/pair/confirm {requestId, code, token?} → {token, name, inbox}
//      token：以后对方找我们用的钥匙；对方带上的 token：以后我们找对方用的钥匙（双向一次配好）
//   配对码只对这一次申请有效，5 分钟过期。输错不马上说错：返回 {pairing:true, retryIn}，对方隔 retryIn 秒再用同一个 requestId 来问，
//   冷却结束才回「配对码错误，配对失败」。冷却 30 秒 → 3 分钟 → 30 分钟 → 之后每次 2 小时（全局）。
// 配对后（请求头 Authorization: Bearer <token>）：
//   GET  /claclaw-peer/sessions → 加入协同的会话
//   POST /claclaw-peer {from, text, session?} → 送进会话，等这一轮回复完，返回 {ok, reply}
// 配置只能在本机（127.0.0.1）打开网页时修改；存在 data/peer.json（只有本人可读），我们发出去的钥匙只存哈希。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DATA, writeJsonAtomic } from './auth.mjs';

const FILE = path.join(DATA, 'peer.json');
export const PEER_BASE = '/claclaw-peer';
const DEFAULTS = { enabled: false, port: 8788, dir: '', sessions: [], name: '', peers: [] };

// 协同对方的配色：预设组数，和页面上的 .pc0 … .pc6 对应（每组都配好了浅色、深色模式下的底色和字色）
export const PEER_COLORS = 7;
export function loadPeer() {
  let c = {};
  try { c = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  const out = { ...DEFAULTS, ...c, peers: Array.isArray(c.peers) ? c.peers : [], last: c.last && typeof c.last === 'object' ? c.last : {} };
  // 每个已配对的对方一个固定编号（①②③…），会话列表里用编号 + 颜色标「最近和谁通信」
  let n = Math.max(0, ...out.peers.map(p => p.no || 0));
  for (const p of out.peers) if (!p.no) p.no = ++n;
  // 每个对方一组固定配色（预设 PEER_COLORS 组里随机挑，先挑还没人用的）；第一次分到就存下来，以后不变
  let dirty = false;
  for (const p of out.peers) {
    if (Number.isInteger(p.color) && p.color >= 0 && p.color < PEER_COLORS) continue;
    const used = new Set(out.peers.map(x => x.color)), free = [...Array(PEER_COLORS).keys()].filter(i => !used.has(i));
    const pool = free.length ? free : [...Array(PEER_COLORS).keys()];
    p.color = pool[crypto.randomInt(pool.length)]; dirty = true;
  }
  if (dirty && fs.existsSync(FILE)) savePeer(out);
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
  writeJsonAtomic(FILE, keep);   // 原子写：崩溃不会写坏 peer.json
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
// 我们告诉对方的收件地址：设了中继地址（跨网络）就以它为主、局域网地址备用；没设就是局域网的名字地址 + IP 地址
export const ourInbox = c => { const rs = ourRelays(c); return { inbox: ourBaseName(c) || ourBase(c), inboxAlt: ourBase(c), ...(rs.length ? { relay: rs[0], relays: rs } : {}) }; };   // 局域网地址 + 中继地址（有的话），对方局域网优先
export const ourBase = c => { const ip = lanIp(); return ip ? 'http://' + ip + ':' + c.port + PEER_BASE : ''; };

// ---------- 配对申请（只放内存：重启就作废，本来就只有 5 分钟） ----------
export const PAIR_TTL = 5 * 60 * 1000;
export const PAIR_CODE_LEN = 2;                 // 两位数字，好口传；防猜靠下面的「输错后冷却」
const PAIR_MIN_INTERVAL = 10 * 1000;            // 同一个 IP 10 秒内只能申请一次
const PAIR_GLOBAL_MAX = 30;                     // 全局：每小时最多 30 次申请
const PAIR_GLOBAL_WINDOW = 60 * 60 * 1000;
// 输错冷却（全局，不分 IP，换 IP 也绕不过去）：第 1 次错 30 秒、第 2 次 3 分钟、第 3 次 30 分钟、之后每次 2 小时；
// 冷却期间所有配对都显示「配对中」，到时才告诉输错的一方「配对码错误，配对失败」。24 小时没再输错就清零。
// 90 种码平均要猜 45 次 ≈ 80 多小时。
export const PAIR_WAITS = [30e3, 3 * 60e3, 30 * 60e3, 2 * 60 * 60e3];
const PAIR_FAIL_RESET = 24 * 60 * 60e3;
let pairFail = { n: 0, last: 0 };
let pairHold = null;          // { requestId, until }：输错后的冷却
const pending = new Map();   // requestId → {id, name, ip, inbox, code, expiresAt, tries}
const pairLimit = new Map();  // ip → 上次申请的时间
let pairGlobal = [];         // 最近的申请时间，用来算每小时的上限
export function pendingList() {
  const now = Date.now();
  for (const [k, p] of pending) if (p.expiresAt < now) pending.delete(k);
  return [...pending.values()];
}
export function addPending(name, ip, inbox) {
  const now = Date.now();
  // 全局上限：每小时最多 30 次申请（不然可以一直刷，把主人烦死）
  pairGlobal = pairGlobal.filter(t => now - t < PAIR_GLOBAL_WINDOW);
  if (pairGlobal.length >= PAIR_GLOBAL_MAX) throw Object.assign(new Error('配对申请太频繁，稍后再试'), { code: 429 });
  // 同一个 IP 10 秒内只能申请一次
  const last = pairLimit.get(ip);
  if (last && now - last < PAIR_MIN_INTERVAL) {
    throw Object.assign(new Error('申请太频繁，' + Math.ceil((PAIR_MIN_INTERVAL - (now - last)) / 1000) + ' 秒后再试'), { code: 429 });
  }
  if (pairHold && pairHold.until > now) throw Object.assign(new Error('正在配对中，稍后再试'), { code: 429 });
  const list = pendingList();
  if (list.length >= 5) throw Object.assign(new Error('配对申请太多，稍后再试'), { code: 429 });
  for (const p of list) if (p.ip === ip) pending.delete(p.id);   // 同一台电脑只保留最新一条
  pairLimit.set(ip, now);
  pairGlobal.push(now);
  const code = String(10 + crypto.randomInt(90));
  const p = { id: newId(), name, ip, inbox, code, expiresAt: now + PAIR_TTL, tries: 0 };
  pending.set(p.id, p);
  return p;
}
export const getPending = id => (pendingList(), pending.get(id) || null);
export const dropPending = id => pending.delete(id);
// 输错：开始冷却，返回冷却毫秒数
export function notePairFail(requestId, now = Date.now()) {
  if (now - pairFail.last > PAIR_FAIL_RESET) pairFail.n = 0;
  const wait = PAIR_WAITS[Math.min(pairFail.n, PAIR_WAITS.length - 1)];
  pairFail = { n: pairFail.n + 1, last: now };
  pairHold = { requestId, until: now + wait };
  return wait;
}
// 冷却状态：null = 没在冷却；{mine, left} 冷却中；{mine, done:true} 这次申请的冷却刚结束（该告诉它失败了）
export function pairHoldState(requestId, now = Date.now()) {
  if (!pairHold) return null;
  const mine = !!requestId && requestId === pairHold.requestId;
  if (pairHold.until > now) return { mine, left: pairHold.until - now };
  if (mine) { pairHold = null; return { mine, done: true }; }
  return null;
}
export function clearPairFails() { pairFail = { n: 0, last: 0 }; pairHold = null; }

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
// 用 http.request 不用 fetch：fetch 等响应头最多 5 分钟就断，对方一轮回复可能要 10 分钟。
// 出错时标出是不是「连都没连上」（connect: true）：只有这种情况才换对方的另一个地址重试，
// 已经送到对方、只是等回复时出的错不能重试，不然同一条消息会被送两遍
// 经 clarelay 中继、端到端加密的地址（…/t/<名>/…#pin=…&key=…）：交给 clarelay 的 relayRequest（核对证书指纹 + 加解密）
let relayLib = null;
async function loadRelayLib() {
  if (relayLib) return relayLib;
  for (const p of ['clarelay/tunnel.mjs', pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'clarelay', 'tunnel.mjs')).href]) {
    try { const m = await import(p); if (m.relayRequest) return relayLib = m; } catch {}
  }
  return null;
}
async function callRelay(base, sub, { token, body, ms, extra = {} }) {
  const mod = await loadRelayLib();
  if (!mod) throw Object.assign(new Error('对方走中继，这台电脑没装 clarelay'), { connect: true });
  const i = base.indexOf('#'), addr = base.slice(0, i).replace(/\/+$/, '') + (sub || '') + base.slice(i);
  const headers = { ...extra };
  if (token) headers.authorization = 'Bearer ' + token;
  let r;
  try { r = await mod.relayRequest(addr, { method: body ? 'POST' : 'GET', headers, body: body || undefined, timeout: ms }); }
  catch (e) { throw Object.assign(new Error('连不上对方（中继）：' + (e.code || e.message)), { connect: /ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ENETUNREACH|EAI_AGAIN/.test(String(e.code || e.message)) }); }
  const ok = r.status >= 200 && r.status < 300;
  let j; try { j = r.json(); } catch { j = { ok, reply: r.text() }; }
  if (!j || typeof j !== 'object') j = { ok, reply: String(j ?? '') };
  if (!ok) { j.ok = false; if (!j.error) j.error = 'HTTP ' + r.status; }
  j.status = r.status;
  return j;
}
export function callPeer(base, sub, { token, body, ms = 10 * 60 * 1000, connectMs = 0, headers: extra = {} } = {}) {
  if (!base) return Promise.reject(Object.assign(new Error('没有对方的地址'), { connect: true }));
  if (/#.*\bkey=/.test(base)) return callRelay(base, sub, { token, body, ms, extra });
  const u = new URL(base);
  // 走中继的地址：https://中继IP:端口/t/名字/claclaw-peer#pin=sha256//…（中继是自签证书，只认这个指纹）
  const pin = (u.hash.match(/pin=(sha256\/\/[A-Za-z0-9+/=]+)/) || [])[1] || '';
  u.hash = '';
  if (sub) u.pathname = u.pathname.replace(/\/+$/, '') + sub;
  const headers = { ...extra };
  if (token) headers.authorization = 'Bearer ' + token;
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = data.length; }
  const mod = u.protocol === 'https:' ? https : http;
  const opt = { method: data ? 'POST' : 'GET', headers };
  if (pin && u.protocol === 'https:') opt.createConnection = (o, cb) => {   // 握手后、发出钥匙之前核对指纹
    const so = tls.connect({ host: o.host, port: o.port, servername: o.servername, rejectUnauthorized: false });
    so.once('secureConnect', () => { const got = 'sha256//' + crypto.createHash('sha256').update(so.getPeerX509Certificate().publicKey.export({ type: 'spki', format: 'der' })).digest('base64'); if (got === pin) cb(null, so); else { so.destroy(); cb(Object.assign(new Error('中继证书指纹对不上'), { code: 'PIN_MISMATCH' })); } });
    so.once('error', e => cb(e));
  };
  return new Promise((resolve, reject) => {
    let connected = false, done = false;
    const fail = (msg, connect) => { if (done) return; done = true; clearTimeout(t); req.destroy(); reject(Object.assign(new Error(msg), { connect })); };
    const req = mod.request(u, opt, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        if (done) return; done = true; clearTimeout(t);
        const text = Buffer.concat(chunks).toString('utf8'), ok = res.statusCode >= 200 && res.statusCode < 300;
        let j; try { j = JSON.parse(text); } catch { j = { ok, reply: text }; }
        if (!ok) { j.ok = false; if (!j.error) j.error = 'HTTP ' + res.statusCode; }
        j.status = res.statusCode;
        resolve(j);
      });
      res.on('error', e => fail('对方的回复中断了：' + e.message, false));
    });
    req.on('socket', so => { if (!so.connecting) connected = true; else so.once('connect', () => { connected = true; }); });
    // 局域网地址：几秒连不上就算不在同一个网络，赶紧换中继，别干等
    if (connectMs) setTimeout(() => { if (!connected) fail('连不上对方：超时', true); }, connectMs);
    req.on('error', e => fail('连不上对方：' + (e.code || e.message), !connected));
    const t = setTimeout(() => fail(connected ? '对方超时没有回复' : '连不上对方：超时', !connected), ms);
    if (data) req.write(data);
    req.end();
  });
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
// 对方的地址：局域网的（名字地址、IP 地址）优先，几毫秒就到；连不上（3 秒）再走中继（约 1 秒一个来回）。
// 局域网连不上之后 5 分钟内直接走中继，过了再试局域网——回到公司自动切回直连。
// 只在「连都没连上」时换地址；已经送到对方的请求出错不重发（不然同一条消息会送两遍）。
export const isRelayAddr = u => /^https:|#.*\bkey=/.test(String(u || ''));
const lanDownUntil = new Map();   // 对方 id → 这之前不先试局域网
export const peerRoute = new Map();   // 对方 id → { via: 'lan' | 'relay', at, ms }：最近一次实际走的路（协同页标「局域网 / 中继」）
// 对方的中继地址（主 → 备）：relays 数组；兼容旧的单个 relay 字段、以及配对时 inbox 本身就是中继地址的
export const peerRelays = p => [...new Set([...(Array.isArray(p.relays) ? p.relays : []), p.relay, p.inbox, p.inboxAlt].filter(u => u && isRelayAddr(u)))];
export const relayOf = p => peerRelays(p)[0] || '';
// 我们的中继地址（主 → 备）
export const ourRelays = c => (Array.isArray(c.relays) && c.relays.length ? c.relays : [c.relay]).filter(Boolean);
// 同步中继地址的请求头：我们每次请求对方都带上自己当前的中继地址（主 → 备，空格分隔；没有就是空串），对方据此更新记的地址
export const RELAYS_HEADER = 'x-claclaw-relays';
export const parseRelaysHeader = v => String(v || '').split(/\s+/).filter(u => /^https:\/\/\S+#pin=sha256\/\/\S+$/.test(u)).slice(0, 5);
// 单独试一次每个中继（局域网通着时也试）：协同页显示「离开局域网后能不能续上」。同一个地址 60 秒内只真试一次
const relayProbe = new Map();
async function probeOne(p, addr) {
  const hit = relayProbe.get(p.id + ' ' + addr);
  if (hit && Date.now() - hit.at < 60e3) return hit.res;
  const t0 = Date.now();
  let res;
  try { const j = await callPeer(addr, '/sessions', { token: p.theirToken, ms: 15000 }); res = j.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, error: j.error || 'HTTP ' + j.status }; }
  catch (e) { res = { ok: false, error: e.message }; }
  relayProbe.set(p.id + ' ' + addr, { at: Date.now(), res });
  return res;
}
export async function probeRelay(p) {   // 返回每个中继的结果（主 → 备）；没有中继地址返回 null
  const addrs = peerRelays(p).slice(0, 3);
  if (!addrs.length) return null;
  return Promise.all(addrs.map(a => probeOne(p, a)));
}
export async function peerCall(c, p, sub, opts) {
  const lan = [p.inbox, p.inboxAlt].filter(u => u && !isRelayAddr(u));
  if (p.ip && lan[0]) { try { const u = new URL(lan[0]); if (u.hostname !== p.ip) { u.hostname = p.ip; lan.push(u.toString().replace(/\/$/, '')); } } catch {} }
  const relays = peerRelays(p);   // 主中继 → 备用中继
  const lanFirst = !(lanDownUntil.get(p.id) > Date.now());
  const tries = [...new Set(lanFirst ? [...lan, ...relays] : [...relays, ...lan])];
  let err;
  for (const url of tries) {
    const viaRelay = isRelayAddr(url), t0 = Date.now();
    try {
      const j = await callPeer(url, sub, { token: p.theirToken, ...opts, headers: { [RELAYS_HEADER]: ourRelays(c).join(' ') }, connectMs: viaRelay ? 0 : 3000 });
      peerRoute.set(p.id, { via: viaRelay ? 'relay' : 'lan', at: Date.now(), ms: Date.now() - t0 });
      if (viaRelay) { if (lan.length) lanDownUntil.set(p.id, Date.now() + 5 * 60e3); }
      else {
        lanDownUntil.delete(p.id);
        if (url !== lan[0] && lan.includes(url) && p.inbox && !isRelayAddr(p.inbox)) { const old = p.inbox; p.inbox = url; p.inboxAlt = old; savePeer(c); }   // 局域网里换了能用的那个当首选
      }
      return j;
    } catch (e) { err = e; if (!e.connect) break; }   // 已经送到对方了：不换地址重发
  }
  throw err || new Error('没有对方的地址');
}
