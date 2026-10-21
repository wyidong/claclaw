// 多宿主：手机只连一台 claclaw（首连宿主），在「宿主」页切到同一 Tailscale 里的另一台。
// - 发现：tailscale status 列出在线的电脑，只问默认端口上的 /api/claclaw/hello；不是默认端口的由用户输入。
// - 添加：用户输入对方网页的用户名密码，这里代为登录，只存对方发的登录令牌（不存密码）。
// - 访问：/h/<宿主ID>/api/… 和 /h/<宿主ID>/ws 原样转给对方。对方看这边是一个普通的 Tailscale 访问者（非本机）。
// - 推送：添加时给对方一个转发令牌；对方的通知先交给这边，用这边的推送密钥发到手机（见 push.mjs）。
// 都存在 data/hosts.json（权限 600，不进 git）。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { WebSocket } from 'ws';
import { DATA } from './auth.mjs';

const FILE = path.join(DATA, 'hosts.json');
export const DEFAULT_PORT = 8787;
const COOKIE = 'claclaw_sid';
const TS_BINS = ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];

function load() {
  let j = {};
  try { j = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  j.hosts ||= []; j.relays ||= {};
  if (!j.selfId) { j.selfId = crypto.randomBytes(6).toString('hex'); save(j); }
  return j;
}
function save(j) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(j, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE);
}
const sha = t => crypto.createHash('sha256').update(String(t)).digest('hex');

export const selfId = () => load().selfId;
export const getHost = id => load().hosts.find(h => h.id === id) || null;

// ---------- 发现 ----------

function tsStatus() {
  return new Promise(ok => {
    let i = 0;
    const next = () => {
      if (i >= TS_BINS.length) return ok(null);
      execFile(TS_BINS[i++], ['status', '--json'], { timeout: 4000, maxBuffer: 8 << 20 }, (e, out) => {
        if (e) return next();
        try { ok(JSON.parse(out)); } catch { next(); }
      });
    };
    next();
  });
}

// 同一 Tailscale 里的其他电脑（不含自己、不含手机平板）
export async function tailnet() {
  const st = await tsStatus();
  if (!st) return null;
  return Object.values(st.Peer || {}).map(p => ({
    ip: (p.TailscaleIPs || []).find(x => /^100\./.test(x)) || '',
    name: p.HostName || String(p.DNSName || '').split('.')[0] || '',
    os: p.OS || '',
    online: !!p.Online,
  })).filter(p => p.ip && !/^(iOS|android|tvOS)$/i.test(p.os)).sort((a, b) => (b.online - a.online) || a.name.localeCompare(b.name));
}

// 问一台电脑的某个端口是不是 claclaw；不是 / 连不上返回 null；旧版 claclaw 返回 { old: true }
export async function probe(ip, port, ms = 1500) {
  try {
    const r = await fetch(`http://${ip}:${port}/api/claclaw/hello`, { signal: AbortSignal.timeout(ms) });
    if (r.status === 401) {   // 旧版 claclaw 没有这个接口，未登录一律回 login required
      const j = await r.json().catch(() => ({}));
      return j.error === 'login required' ? { old: true } : null;
    }
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.app === 'claclaw' && typeof j.id === 'string' ? { id: j.id, name: String(j.name || ''), version: String(j.version || '') } : null;
  } catch { return null; }
}

// 宿主页要的全部：已添加的（在不在线）+ Tailscale 里在线的电脑（默认端口上有没有 claclaw）
export async function overview(self) {
  const j = load();
  const [net, ...alive] = await Promise.all([tailnet(), ...j.hosts.map(h => probe(h.ip, h.port))]);
  const hosts = j.hosts.map((h, i) => ({ id: h.id, name: h.name, ip: h.ip, port: h.port, online: !!alive[i]?.id && alive[i].id === h.id, addedAt: h.addedAt }));
  let others = null;
  if (net) {
    const found = await Promise.all(net.map(p => p.online ? probe(p.ip, DEFAULT_PORT) : null));
    others = net.map((p, i) => ({ ...p, claclaw: found[i]?.id && found[i].id !== j.selfId ? found[i] : null, old: !!found[i]?.old }))
      .filter(p => !j.hosts.some(h => h.ip === p.ip));
  }
  return { self: { id: '', name: self.name }, hosts, tailnet: others };
}

// ---------- 添加 / 移除 ----------

// 对方 claclaw 的接口（带上对方的登录令牌）
async function call(h, p, body, ms = 8000) {
  const r = await fetch(`http://${h.ip}:${h.port}${p}`, {
    method: body ? 'POST' : 'GET',
    headers: { cookie: `${COOKIE}=${h.token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(ms),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw Object.assign(new Error(j.error || 'HTTP ' + r.status), { status: r.status });
  return j;
}

// selfUrl：对方把通知交回来的地址（这边的 Tailscale IP + 端口）；selfName：在对方那边显示的名字
export async function add({ ip, port, username, password }, { selfUrl, selfName }) {
  ip = String(ip || '').trim(); port = Number(port) || DEFAULT_PORT;
  if (!/^[\w.:-]{1,100}$/.test(ip) || port < 1 || port > 65535) throw new Error('地址或端口不对');
  const hi = await probe(ip, port, 3000);
  if (!hi) throw new Error(`${ip}:${port} 上没有找到 claclaw（没启动，或者端口不对）`);
  if (hi.old) throw new Error('对方的 claclaw 是旧版本，先在那台电脑上更新（git pull 后重启）');
  const j0 = load();
  if (hi.id === j0.selfId) throw new Error('这就是当前这台宿主');
  let r;
  try {
    r = await fetch(`http://${ip}:${port}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: String(username || ''), password: String(password || '') }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (e) { throw new Error('连不上对方：' + e.message); }
  let lj = {};
  try { lj = await r.json(); } catch {}
  if (!r.ok) throw new Error(lj.error || '登录失败（HTTP ' + r.status + '）');
  const cookies = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
  const token = cookies.map(c => (c.match(new RegExp('^' + COOKIE + '=([^;]+)')) || [])[1]).find(Boolean);
  if (!token) throw new Error('对方没有发登录令牌');
  const relay = crypto.randomBytes(24).toString('base64url');
  const h = { id: hi.id, name: hi.name || ip, ip, port, token, relayHash: sha(relay), addedAt: Date.now() };
  // 让对方的通知交给这边发（这边没有 Tailscale 地址就算了，对方照常自己发）
  let relayOk = false;
  if (selfUrl) {
    try { await call(h, '/api/hosts/relay', { id: j0.selfId, name: selfName, url: selfUrl, token: relay }); relayOk = true; } catch {}
  }
  const j = load();
  j.hosts = j.hosts.filter(x => x.id !== h.id);
  j.hosts.push(h);
  save(j);
  return { id: h.id, name: h.name, relay: relayOk };
}

export async function remove(id) {
  const j = load();
  const h = j.hosts.find(x => x.id === id);
  if (!h) return false;
  try { await call(h, '/api/hosts/relay/remove', { id: j.selfId }, 4000); } catch {}
  try { await call(h, '/api/logout', {}, 4000); } catch {}
  j.hosts = j.hosts.filter(x => x.id !== id);
  save(j);
  return true;
}

// ---------- 对方那边：记下「通知交给谁发」 ----------

export function setRelay({ id, name, url, token }) {
  if (!/^[\w-]{4,64}$/.test(String(id || '')) || !/^http:\/\/[\w.:-]+$/.test(String(url || '')) || !token) throw new Error('参数不对');
  const j = load();
  j.relays[id] = { name: String(name || '').slice(0, 60), url, token: String(token), at: Date.now() };
  save(j);
}
export function dropRelay(id) {
  const j = load();
  if (j.relays[id]) { delete j.relays[id]; save(j); }
}
export const relays = () => Object.values(load().relays);
// 交过来的通知：凭转发令牌找到是哪台宿主
export const hostByRelayToken = t => (t && load().hosts.find(h => h.relayHash === sha(t))) || null;

// ---------- 转发 ----------

const HOP = new Set(['host', 'cookie', 'origin', 'referer', 'connection', 'upgrade', 'keep-alive', 'transfer-encoding', 'x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto']);

function fail(res, code, o) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(o));
}

// rest：/api/… 加查询串
export function proxyHttp(req, res, id, rest) {
  const h = getHost(id);
  if (!h) return fail(res, 404, { error: '这个宿主已经移除了', hostGone: true });
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !k.startsWith('tailscale-')) headers[k] = v;
  headers.host = `${h.ip}:${h.port}`;
  headers.cookie = `${COOKIE}=${h.token}`;
  headers['x-forwarded-for'] = req.socket.remoteAddress || '';   // 对方据此不把它当成本机请求
  const up = http.request({ host: h.ip, port: h.port, method: req.method, path: rest, headers, timeout: 15000 }, r => {
    if (r.statusCode === 401) { r.resume(); return fail(res, 424, { error: `「${h.name}」的登录已失效，请重新输入它的密码`, hostAuth: true, host: h.id }); }
    const out = { ...r.headers };
    delete out['set-cookie']; delete out.connection; delete out['keep-alive'];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('超时')));
  up.on('error', e => { if (!res.headersSent) fail(res, 502, { error: `连不上「${h.name}」：${e.code || e.message}`, hostDown: true, host: h.id }); else res.destroy(); });
  req.pipe(up);
}

export function proxyWs(req, socket, head, id, wss, log = () => {}) {
  const h = getHost(id);
  const no = code => { socket.write(`HTTP/1.1 ${code}\r\n\r\n`); socket.destroy(); };
  if (!h) return no('404 Not Found');
  const up = new WebSocket(`ws://${h.ip}:${h.port}/ws`, {
    headers: { cookie: `${COOKIE}=${h.token}`, origin: `http://${h.ip}:${h.port}`, 'x-forwarded-for': req.socket.remoteAddress || '' },
    handshakeTimeout: 8000,
  });
  let done = false;
  up.on('unexpected-response', (_q, r) => { done = true; log('host ws refused', h.name, r.statusCode); no(r.statusCode === 401 ? '401 Unauthorized' : '502 Bad Gateway'); up.terminate(); });
  up.on('error', e => { if (!done) { done = true; log('host ws error', h.name, e.code || e.message); no('502 Bad Gateway'); } });
  up.on('open', () => {
    done = true;
    let early = [];   // 浏览器那头还没接上时对方先发来的
    up.on('message', (d, bin) => early ? early.push([d, bin]) : null);
    wss.handleUpgrade(req, socket, head, ws => {
      for (const [d, bin] of early) ws.send(d, { binary: bin });
      early = null;
      ws.on('message', (d, bin) => up.readyState === 1 && up.send(d, { binary: bin }));
      up.on('message', (d, bin) => ws.readyState === 1 && ws.send(d, { binary: bin }));
      ws.on('close', () => up.close());
      up.on('close', () => ws.close());
      ws.on('error', () => up.terminate());
      up.on('error', () => ws.terminate());
    });
  });
}
