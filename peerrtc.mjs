// 协同直连（打洞）：两台电脑之间一条 WebRTC DataChannel，不经中继。
// - 牵线：发起方生成 offer，经现有的任一条路（局域网 / 中继，都带配对钥匙、中继那条还端到端加密）POST 给对方的 /rtc，
//   对方回 answer。SDP 里带着双方 DTLS 证书指纹，中间人改不了；之后的数据走 DTLS 加密。
// - 打通后：这条通道和局域网、中继互不依赖（中继断了它照样通）；两边都能用它向对方发请求。
// - 通道上的请求照样带配对钥匙，收到后原样转给本机的协同收件服务（和中继隧道一样），门卫、去重全都照旧。
// - node-datachannel 是可选依赖：没装就不开这个功能（rtcLib() 返回 null）。
//
// 消息（一条有序可靠的 'claclaw-peer' 通道）：文本 = JSON 控制消息；二进制 = [4 字节编号][数据]（请求体 / 响应体分片）
//   req{id,m,p,h} … 分片 … eob{id}     → 对方先回 got{id}（收到了：之后出错不能换路重发），再回 res{id,s} … 分片 … end{id} / err{id,e}
//   ping{n} → pong{n}（量来回时间、发现断线）
import http from 'node:http';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';

export const RTC_ICE = ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478', 'stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
const CHUNK = 16 * 1024, MAX_BODY = 32 << 20;
const PING_MS = 15e3, DEAD_MS = 50e3;
const FWD = ['authorization', 'content-type', 'x-claclaw-relays'];   // 转给本机收件服务时只带这些头

let ndc;   // undefined = 还没试，null = 没装
export async function rtcLib() {
  if (ndc === undefined) {
    try { const m = await import('node-datachannel'); ndc = m.default || m; } catch { ndc = null; }
    try { ndc?.setSctpSettings?.({ initialRetransmitTimeout: 500, minRetransmitTimeout: 200, maxRetransmitTimeout: 3000, delayedSackTime: 20 }); } catch {}
  }
  return ndc;
}

// 打通的是哪条路：对方地址是内网 → lan；Tailscale（100.64/10）→ tailscale；其余 → wan
export function classifyAddr(a, ifs) {   // ifs：测试用，替代本机网卡表
  a = String(a || '').replace(/^::ffff:/, '').split('%')[0];
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 10 || x === 127 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168) || (x === 169 && y === 254)) return 'lan';
    if (x === 100 && y >= 64 && y < 128) return 'tailscale';
    return 'wan';
  }
  if (/^fd7a:115c:a1e0:/i.test(a)) return 'tailscale';   // Tailscale 的 IPv6 段
  if (/^(fe80|fc|fd)/i.test(a)) return 'lan';
  if (net.isIPv6(a) && localV6Prefixes(ifs).has(v6Prefix(a))) return 'lan';   // 公网 IPv6 但和本机网卡同一个 /64：同一个局域网（路由器发的同一段）
  return a ? 'wan' : '';
}
// IPv6 前 64 位（展开 ::，统一小写），比较是不是同一段
function v6Prefix(a) {
  const [h, t = ''] = a.toLowerCase().split('::');
  const hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
  const full = a.includes('::') ? [...hs, ...Array(8 - hs.length - ts.length).fill('0'), ...ts] : hs;
  return full.slice(0, 4).map(x => parseInt(x, 16) || 0).join(':');
}
let v6Cache = null;
function localV6Prefixes(ifs) {
  if (!ifs && v6Cache && Date.now() - v6Cache.at < 60e3) return v6Cache.set;
  const set = new Set();
  for (const list of Object.values(ifs || os.networkInterfaces())) for (const x of list || []) if (x.family === 'IPv6' && !x.internal && !/^(fe80|fc|fd)/i.test(x.address)) set.add(v6Prefix(x.address.split('%')[0]));
  if (!ifs) v6Cache = { at: Date.now(), set };
  return set;
}

let cfg = { target: () => '', log: () => {}, ice: RTC_ICE, base: '/claclaw-peer' };
export function rtcConfig(o) { cfg = { ...cfg, ...o }; }

const conns = new Map();   // 对方 id → Set<Conn>（两边同时发起时可能有两条，挑通着的用）

class Conn {
  constructor(pc, peerId, role) {
    Object.assign(this, { pc, peerId, role });
    this.dc = null; this.closed = false; this.born = Date.now();
    this.next = 1; this.calls = new Map(); this.serving = new Map();
    this.rtt = 0; this.lastPong = Date.now(); this.n = 0;
    this.opened = new Promise((ok, bad) => { this._ok = ok; this._bad = bad; });
    this.opened.catch(() => {});
    this.openTimer = setTimeout(() => this.close('20 秒没打通'), 20e3);
    pc.onStateChange(s => { if (s === 'failed' || s === 'closed') this.close('连接' + (s === 'failed' ? '失败' : '关闭')); });
  }
  attach(dc) {
    if (this.dc) { try { dc.close(); } catch {} return; }
    this.dc = dc;
    dc.onOpen(() => this.onOpen());
    dc.onMessage(m => { try { this.onMessage(m); } catch (e) { cfg.log('peer direct 消息出错', e.message); } });
    dc.onClosed(() => this.close('通道关闭'));
    if (dc.isOpen()) this.onOpen();
  }
  onOpen() {
    if (this.up || this.closed) return;
    this.up = Date.now(); clearTimeout(this.openTimer);
    try { const p = this.pc.getSelectedCandidatePair(); this.remote = p?.remote?.address || ''; this.via = classifyAddr(this.remote); this.pair = p ? p.local.type + '↔' + p.remote.type : ''; } catch {}
    cfg.log('peer direct up', this.peerId, this.role, this.pair || '', this.remote || '', this.via || '');
    this.lastPong = Date.now(); this.ping();
    this.pinger = setInterval(() => { if (Date.now() - this.lastPong > DEAD_MS) return this.close('心跳超时'); this.ping(); }, PING_MS);
    this.pinger.unref?.();
    this._ok(this);
  }
  get open() { return !this.closed && !!this.dc?.isOpen(); }
  ping() { this.pingAt = Date.now(); this.send({ t: 'ping', n: this.pingAt }); }
  close(why) {
    if (this.closed) return; this.closed = true;
    clearTimeout(this.openTimer); clearInterval(this.pinger);
    if (this.up) cfg.log('peer direct down', this.peerId, why, '用了', Math.round((Date.now() - this.up) / 1000) + 's', '转了', this.n);
    for (const c of this.calls.values()) c.fail(new Error('直连断了：' + why), !c.got);
    this.calls.clear();
    for (const r of this.serving.values()) { try { r.up?.destroy(); } catch {} }
    this.serving.clear();
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    const set = conns.get(this.peerId); set?.delete(this); if (set && !set.size) conns.delete(this.peerId);
    this._bad(new Error(why));
  }
  send(o) { try { if (this.dc?.isOpen()) this.dc.sendMessage(JSON.stringify(o)); } catch {} }
  sendBin(id, buf) {
    for (let i = 0; i < buf.length; i += CHUNK) {
      const part = buf.subarray(i, i + CHUNK), b = Buffer.allocUnsafe(4 + part.length);
      b.writeUInt32BE(id, 0); part.copy(b, 4);
      try { this.dc.sendMessageBinary(b); } catch {}
    }
  }
  onMessage(m) {
    if (typeof m !== 'string') {
      const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
      if (b.length < 4) return;
      const id = b.readUInt32BE(0), data = b.subarray(4);
      const c = this.calls.get(id);
      if (c) { c.len += data.length; if (c.len > MAX_BODY) { c.fail(new Error('对方的回复太大'), false); this.calls.delete(id); } else c.chunks.push(Buffer.from(data)); return; }
      const r = this.serving.get(id);
      if (r) { r.len += data.length; if (r.len > MAX_BODY) { this.send({ t: 'err', id, e: '请求太大' }); this.serving.delete(id); try { r.up?.destroy(); } catch {} } else r.chunks.push(Buffer.from(data)); }
      return;
    }
    const j = JSON.parse(m), id = j.id >>> 0;
    if (j.t === 'ping') return this.send({ t: 'pong', n: j.n });
    if (j.t === 'pong') { this.lastPong = Date.now(); if (j.n === this.pingAt) this.rtt = this.rtt ? Math.round(this.rtt * 0.7 + (Date.now() - j.n) * 0.3) : Date.now() - j.n; return; }
    // 发出去的请求的回音
    if (j.t === 'got') { const c = this.calls.get(id); if (c) c.got = true; return; }
    if (j.t === 'res') { const c = this.calls.get(id); if (c) { c.got = true; c.status = j.s | 0; } return; }
    if (j.t === 'end') { const c = this.calls.get(id); if (c) { this.calls.delete(id); c.done(); } return; }
    if (j.t === 'err') { const c = this.calls.get(id); if (c) { this.calls.delete(id); c.fail(new Error(String(j.e || '对方出错')), !c.got); } return; }
    // 对方发来的请求：收齐了转给本机协同收件服务
    if (j.t === 'req') {
      const p = String(j.p || '');
      if (!(p === cfg.base || p.startsWith(cfg.base + '/') || p.startsWith(cfg.base + '?')) || p.includes('..')) return this.send({ t: 'err', id, e: 'bad path' });
      this.serving.set(id, { m: j.m === 'POST' ? 'POST' : 'GET', p, h: j.h || {}, chunks: [], len: 0 });
      return this.send({ t: 'got', id });
    }
    if (j.t === 'eob') { const r = this.serving.get(id); if (r && !r.up) this.forward(id, r); return; }
    if (j.t === 'cancel') { const r = this.serving.get(id); if (r) { try { r.up?.destroy(); } catch {} this.serving.delete(id); } }
  }
  forward(id, r) {
    this.n++;
    const target = cfg.target();
    if (!target) { this.serving.delete(id); return this.send({ t: 'err', id, e: '协同没开' }); }
    const t = new URL(target), body = Buffer.concat(r.chunks);
    const h = {};
    for (const k of FWD) if (r.h[k] != null) h[k] = String(r.h[k]);
    h['x-forwarded-for'] = (this.remote || '').replace(/^::ffff:/, '');
    h['x-claclaw-via'] = 'direct';
    if (body.length) h['content-length'] = body.length;
    r.up = http.request({ host: t.hostname, port: t.port, method: r.m, path: r.p, headers: h, timeout: 11 * 60e3 }, res => {
      if (!this.serving.has(id)) return res.destroy();
      this.send({ t: 'res', id, s: res.statusCode });
      res.on('data', d => this.sendBin(id, d));
      res.on('end', () => { this.serving.delete(id); this.send({ t: 'end', id }); });
      res.on('error', e => { this.serving.delete(id); this.send({ t: 'err', id, e: e.message }); });
    });
    r.up.on('timeout', () => r.up.destroy(new Error('本机收件服务超时')));
    r.up.on('error', e => { if (this.serving.delete(id)) this.send({ t: 'err', id, e: '本机收件服务连不上：' + e.message }); });
    r.up.end(body);
  }
  // 发请求；结果和 callPeer 一样是 JSON 对象（带 status）。没送到对方就报错带 connect:true（可以换路重发）
  call(path, { method, headers = {}, body, ms = 10 * 60e3 } = {}) {
    if (!this.open) return Promise.reject(Object.assign(new Error('直连没通'), { connect: true }));
    const id = this.next++ >>> 0;
    return new Promise((resolve, reject) => {
      const c = { got: false, status: 0, chunks: [], len: 0 };
      // 8 秒内对方没回「收到」：当没送到，可以换路；回了就等到 ms 为止
      c.t = setTimeout(() => {
        if (!this.calls.has(id)) return;
        if (!c.got) { this.calls.delete(id); this.send({ t: 'cancel', id }); return c.fail(new Error('直连没响应'), true); }
        c.t = setTimeout(() => { if (this.calls.delete(id)) { this.send({ t: 'cancel', id }); c.fail(new Error('对方超时没有回复'), false); } }, Math.max(0, ms - 8000));
      }, Math.min(ms, 8000));
      c.fail = (e, connect) => { clearTimeout(c.t); reject(Object.assign(e, { connect })); };
      c.done = () => {
        clearTimeout(c.t);
        const text = Buffer.concat(c.chunks).toString('utf8'), ok = c.status >= 200 && c.status < 300;
        let j; try { j = JSON.parse(text); } catch { j = { ok, reply: text }; }
        if (!j || typeof j !== 'object') j = { ok, reply: String(j ?? '') };
        if (!ok) { j.ok = false; if (!j.error) j.error = 'HTTP ' + c.status; }
        j.status = c.status; resolve(j);
      };
      this.calls.set(id, c);
      const data = body == null ? null : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
      const h = { ...headers }; if (data) h['content-type'] = 'application/json';
      this.send({ t: 'req', id, m: method || (data ? 'POST' : 'GET'), p: path, h });
      if (data) this.sendBin(id, data);
      this.send({ t: 'eob', id });
    });
  }
}

function add(conn) {
  let set = conns.get(conn.peerId); if (!set) conns.set(conn.peerId, set = new Set());
  set.add(conn);
  // 最多留两条（两边同时发起）：多了关掉最老的
  while (set.size > 2) { const old = [...set].sort((a, b) => a.born - b.born)[0]; old.close('换新的'); }
}
const newPc = lib => new lib.PeerConnection('claclaw-' + crypto.randomBytes(4).toString('hex'), { iceServers: cfg.ice, maxMessageSize: 256 * 1024 });
const gathered = (pc, ms = 3000) => new Promise(ok => { pc.onGatheringStateChange(s => { if (s === 'complete') ok(); }); setTimeout(ok, ms); });

// 发起：signal(offerSdp) → answerSdp（经现有的路问对方）；打通返回 Conn，打不通抛错
export async function rtcConnect(peerId, signal) {
  const lib = await rtcLib();
  if (!lib) throw Object.assign(new Error('这台电脑没装 node-datachannel'), { code: 'NO_LIB' });
  const pc = newPc(lib), conn = new Conn(pc, peerId, 'out');
  const g = gathered(pc);
  conn.attach(pc.createDataChannel('claclaw-peer'));
  await g;
  const d = pc.localDescription();
  if (!d?.sdp) { conn.close('没生成 offer'); throw new Error('没生成 offer'); }
  let answer;
  try { answer = await signal(d.sdp); } catch (e) { conn.close('牵线失败'); throw e; }
  if (typeof answer !== 'string' || !/^v=0/.test(answer)) { conn.close('对方没给 answer'); throw new Error('对方没给 answer'); }
  pc.setRemoteDescription(answer, 'answer');
  add(conn);
  return conn.opened;
}
// 应答：对方（已凭钥匙认出是谁）发来 offer → 回 answer；通道由对方建，打通后两边都能用
export async function rtcAnswer(peerId, sdp) {
  const lib = await rtcLib();
  if (!lib) throw Object.assign(new Error('这台电脑没装 node-datachannel'), { status: 501 });
  if (typeof sdp !== 'string' || sdp.length > 20000 || !/^v=0/.test(sdp)) throw Object.assign(new Error('bad offer'), { status: 400 });
  const pc = newPc(lib), conn = new Conn(pc, peerId, 'in');
  pc.onDataChannel(dc => conn.attach(dc));
  const g = gathered(pc);
  pc.setRemoteDescription(sdp, 'offer');
  await g;
  const d = pc.localDescription();
  if (!d?.sdp) { conn.close('没生成 answer'); throw new Error('没生成 answer'); }
  add(conn);
  return d.sdp;
}
export function rtcOpen(peerId) {
  let best = null;
  for (const c of conns.get(peerId) || []) if (c.open && (!best || (c.rtt || 1e9) < (best.rtt || 1e9))) best = c;
  return best;
}
export function rtcState(peerId) {
  const c = rtcOpen(peerId);
  return c ? { open: true, rtt: c.rtt, via: c.via, pair: c.pair, since: c.up } : { open: false };
}
export function rtcClose(peerId) { for (const c of [...(conns.get(peerId) || [])]) c.close('关闭'); }
export function rtcCloseAll() { for (const id of [...conns.keys()]) rtcClose(id); }
