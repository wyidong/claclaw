// clarelay 设备组网 · 手机 ↔ 电脑 WebRTC 直连（电脑端）。
//
// 牵线：宿主页面 POST /_clarelay/rtc 交出 offer（这条请求走中继，但 HTTPS 在电脑上解开，中继改不了 SDP 和指纹）→ 这里回 answer。
// 打通后，页面的接口请求和 WebSocket 经 DataChannel 送到这里，再转给本机应用（和中继那条路一样的头、门卫身份）。
// 打不通：页面照旧走中继。node-datachannel 是可选依赖，没装就整个功能不开。
//
// DataChannel 上的消息（一条 'clarelay' 通道，有序可靠）：
//   文本 = JSON 控制消息；二进制 = [4 字节编号][数据]（请求体 / 响应体分片）
//   页面 → 电脑：req{id,m,u,h,b} eob{id} cancel{id} | ws{id,u,p} wm{id,d} wc{id,c,r} | ping{n}
//   电脑 → 页面：res{id,s,st,h,ck?} end{id} err{id,e} | wo{id,p} wm{id,d} wc{id,c,r} | pong{n} bye{}
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import os from 'node:os';
import net from 'node:net';

// 直连走的是哪条路：对方地址是内网 / 和本机同一个 IPv6 /64 → 局域网；Tailscale 地址 → tailscale；其余 → 外网
const v6prefix = a => net.isIPv6(String(a).split('%')[0]) ? expand6(a).slice(0, 19) : '';   // 前 64 位
function expand6(a) {
  a = String(a).split('%')[0];
  const [h, t = ''] = a.split('::'), hs = h ? h.split(':') : [], ts = t ? t.split(':') : [];
  const mid = a.includes('::') ? Array(8 - hs.length - ts.length).fill('0') : [];
  return [...hs, ...mid, ...ts].map(x => x.padStart(4, '0')).join(':').toLowerCase();
}
export function classifyAddr(addr) {
  const a = String(addr || '').replace(/^::ffff:/, '').split('%')[0];
  if (net.isIPv4(a)) {
    const [x, y] = a.split('.').map(Number);
    if (x === 10 || (x === 172 && y >= 16 && y < 32) || (x === 192 && y === 168) || (x === 169 && y === 254) || x === 127) return 'lan';
    if (x === 100 && y >= 64 && y < 128) return 'tailscale';
    return 'internet';
  }
  if (net.isIPv6(a)) {
    const f = expand6(a);
    if (f.startsWith('fd7a:115c:a1e0')) return 'tailscale';
    if (/^f[cd]/.test(f) || f.startsWith('fe80') || f === '0000:0000:0000:0000:0000:0000:0000:0001') return 'lan';
    const p = v6prefix(a);
    for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv6' && !i.internal && v6prefix(i.address) === p) return 'lan';
    return 'internet';
  }
  return 'internet';
}

export const RTC_ICE = ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'];
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate', 'host', 'cookie', 'content-length', 'forwarded', 'x-real-ip']);
const CHUNK = 16 * 1024, HIGH = 1 << 20, LOW = 256 * 1024;
const BIG = 0xFFFFFFFF, BIG_MAX = 64 << 20;   // 超过单条消息上限的控制消息（比如带几 MB 图片的 ws 消息）：拆成编号 BIG 的二进制分片，再发一条 {t:'big'} 收尾
const MAX_PEERS = 4;   // 每个登录（sid）最多几条直连

let ndc;   // node-datachannel：undefined = 还没试，null = 没装
export async function rtcLib() {
  if (ndc === undefined) {
    try { const m = await import('node-datachannel'); ndc = m.default || m; } catch { ndc = null; }
    // 丢包时别傻等：SCTP 默认首次重传等 3 秒、再翻倍，4G 上一丢包就卡十几秒（只影响电脑 → 手机方向）
    try { ndc?.setSctpSettings?.({ initialRetransmitTimeout: 500, minRetransmitTimeout: 200, maxRetransmitTimeout: 3000, delayedSackTime: 20 }); } catch {}
  }
  return ndc;
}

/**
 * @param {object} o
 * @param {string} o.target      本机应用地址 http://127.0.0.1:8787
 * @param {string} o.host        对应用报的 Host（宿主网址的主机名）
 * @param {(sid:string)=>boolean} o.alive   这个登录还有效吗（被撤销就断开直连）
 * @param {(...a)=>void} [o.log]
 * @param {string[]} [o.ice]
 */
export function rtcHost(o) {
  const log = o.log || (() => {});
  const peers = new Set();

  // 牵线：offer → answer（等候选地址收集完，一次给齐，不做 trickle）
  async function answer({ sdp, sid, cookie, ip, prev }) {
    log('直连牵线：' + ip + (prev ? '（页面上次失败：' + String(prev).slice(0, 120) + '）' : ''));
    const lib = await rtcLib();
    if (!lib) throw Object.assign(new Error('这台电脑没装 node-datachannel'), { status: 501 });
    if (typeof sdp !== 'string' || sdp.length > 20000 || !/^v=0/.test(sdp)) throw Object.assign(new Error('bad offer'), { status: 400 });
    const mine = [...peers].filter(p => p.sid === sid);
    while (mine.length >= MAX_PEERS) mine.shift().close('too many');
    const pc = new lib.PeerConnection('clarelay-' + crypto.randomBytes(4).toString('hex'), { iceServers: o.ice || RTC_ICE, maxMessageSize: 256 * 1024 });
    const peer = new Peer({ pc, sid, cookie, ip, o, log, peers });
    peers.add(peer);
    const done = new Promise(ok => {
      pc.onGatheringStateChange(s => { if (s === 'complete') ok(); });
      setTimeout(ok, 3000);
    });
    pc.setRemoteDescription(sdp, 'offer');
    await done;
    const d = pc.localDescription();
    if (!d?.sdp) { peer.close('没生成 answer'); throw new Error('没生成 answer'); }
    return d.sdp;
  }
  return {
    answer,
    get count() { return peers.size; },
    takeSync(k, sid) { for (const p of peers) if (p.sid === sid) { const l = p.takeSync(k); if (l) return l; } return null; },
    revoke() { for (const p of peers) if (!o.alive(p.sid)) p.close('revoked'); },
    closeAll() { for (const p of peers) p.close('stop'); },
  };
}

class Peer {
  constructor({ pc, sid, cookie, ip, o, log, peers }) {
    Object.assign(this, { pc, sid, ip, o, log, peers });
    this.jar = parseCookies(cookie);
    this.reqs = new Map();      // 编号 → { up, res }
    this.socks = new Map();     // 编号 → WebSocket 连接
    this.paused = new Set();    // 因为通道积压暂停的上游响应
    this.dc = null; this.closed = false;
    this.syncs = new Map();     // 一次性凭证 → Set-Cookie 列表（让浏览器自己的 cookie 跟上）
    this.born = Date.now();
    this.connectTimer = setTimeout(() => { if (!this.dc?.isOpen()) this.close('30 秒没打通'); }, 30e3);
    pc.onStateChange(s => { if (s === 'failed' || s === 'closed') this.close(s); else if (s === 'connected') this.onConnected(); });
    pc.onDataChannel(dc => {
      if (this.dc) { try { dc.close(); } catch {} return; }
      this.dc = dc;
      setTimeout(() => this.checkVia(), 200);
      dc.setBufferedAmountLowThreshold(LOW);
      dc.onBufferedAmountLow(() => { for (const r of this.paused) r.resume(); this.paused.clear(); });
      dc.onMessage(m => { try { this.onMessage(m); } catch (e) { log('直连消息出错：' + e.message); } });
      dc.onClosed(() => this.close('dc closed'));
    });
  }
  checkVia() {   // 选中的线路可能变：变了就告诉页面
    try {
      const p = this.pc.getSelectedCandidatePair(); if (!p?.remote?.address) return;
      const via = classifyAddr(p.remote.address);
      if (via !== this.via && this.dc?.isOpen()) { this.via = via; this.send({ t: 'via', via }); }
    } catch {}
  }
  onConnected() {
    clearTimeout(this.connectTimer); this.upAt ||= Date.now();
    this.viaTimer ||= setInterval(() => this.checkVia(), 10e3);
    try { const p = this.pc.getSelectedCandidatePair(); if (p?.remote?.address) this.ip = p.remote.address.replace(/^::ffff:/, ''); this.log('手机直连已打通：' + (p ? p.local.type + ' ↔ ' + p.remote.type + ' ' + p.remote.address : '')); } catch {}
  }
  close(why) {
    if (this.closed) return; this.closed = true;
    if (why !== 'stop') {
      const mins = s => s < 90e3 ? Math.round(s / 1000) + ' 秒' : Math.round(s / 60e3) + ' 分钟';
      this.log(this.upAt ? '直连断开：' + why + '（' + this.ip + '，用了 ' + mins(Date.now() - this.upAt) + '，转了 ' + (this.n || 0) + ' 个请求，其中图片 / 视频 / 文件 ' + (this.media || 0) + ' 个）' : '直连没打通：' + why + '（' + this.ip + '）');
    }
    clearTimeout(this.connectTimer); clearInterval(this.viaTimer);
    for (const r of this.reqs.values()) { try { r.up?.destroy(); r.res?.destroy(); } catch {} }
    for (const w of this.socks.values()) w.destroy();
    this.reqs.clear(); this.socks.clear();
    try { if (why === 'revoked' && this.dc?.isOpen()) this.dc.sendMessage(JSON.stringify({ t: 'bye' })); } catch {}
    try { this.dc?.close(); } catch {}
    try { this.pc.close(); } catch {}
    this.peers.delete(this);
  }
  send(obj) {
    if (!this.dc?.isOpen()) return;
    const s = JSON.stringify(obj);
    try { if (Buffer.byteLength(s) <= 60000) this.dc.sendMessage(s); else { this.sendBin(BIG, Buffer.from(s, 'utf8')); this.dc.sendMessage('{"t":"big"}'); } } catch {}
  }
  sendBin(id, buf) {
    if (!this.dc?.isOpen()) return;
    for (let i = 0; i < buf.length; i += CHUNK) {
      const part = buf.subarray(i, i + CHUNK), b = Buffer.allocUnsafe(4 + part.length);
      b.writeUInt32BE(id, 0); part.copy(b, 4);
      try { this.dc.sendMessageBinary(b); } catch {}
    }
  }
  congested() { try { return this.dc.bufferedAmount() > HIGH; } catch { return false; } }

  headers(h) {
    const out = {};
    for (const [k0, v] of Array.isArray(h) ? h : []) { const k = String(k0).toLowerCase(); if (!HOP.has(k) && !k.startsWith('x-forwarded-') && !k.startsWith('sec-websocket-')) out[k] = String(v); }
    const ck = Object.entries(this.jar).map(([k, v]) => k + '=' + v).join('; ');
    if (ck) out.cookie = ck;
    out.host = this.o.host; out['x-forwarded-for'] = this.ip; out['x-forwarded-proto'] = 'https'; out['x-forwarded-host'] = this.o.host;
    out['accept-encoding'] = 'identity';   // 页面里自己拼的 Response 不会自动解压
    return out;
  }
  onMessage(m) {
    if (typeof m !== 'string') {   // 请求体分片
      const b = Buffer.isBuffer(m) ? m : Buffer.from(m);
      if (b.length < 4) return;
      const id = b.readUInt32BE(0);
      if (id === BIG) { this.bigLen = (this.bigLen || 0) + b.length - 4; if (this.bigLen > BIG_MAX) return this.close('too big'); (this.big ||= []).push(b.subarray(4)); return; }
      const r = this.reqs.get(id); if (!r?.up) return;
      const n = b.length - 4;
      r.up.write(b.subarray(4), () => {   // 真正交给应用了：攒够 512KB 回一次 ack（页面按它控流、报上传进度）
        r.done = (r.done || 0) + n;
        if (r.done - (r.acked || 0) >= 512 * 1024) { r.acked = r.done; this.send({ t: 'ack', id, n: r.done }); }
      });
      return;
    }
    const j = JSON.parse(m);
    if (j.t === 'big') { const all = Buffer.concat(this.big || []).toString('utf8'); this.big = []; this.bigLen = 0; return this.onMessage(all); }
    if (j.t === 'ping') return this.send({ t: 'pong', n: j.n });
    if ((j.t === 'req' || j.t === 'ws') && !this.o.alive(this.sid)) return this.close('revoked');
    if (j.t === 'req') { this.send({ t: 'got', id: j.id >>> 0 }); return this.request(j); }   // 先回「收到」：页面据此分辨是路上卡还是应用慢
    if (j.t === 'eob') return this.reqs.get(j.id)?.up?.end();
    if (j.t === 'cancel') { const r = this.reqs.get(j.id); if (r) { r.up?.destroy(); r.res?.destroy(); this.reqs.delete(j.id); } return; }
    if (j.t === 'ws') return this.openWs(j);
    if (j.t === 'wm') return this.socks.get(j.id)?.sendText(String(j.d));
    if (j.t === 'wc') { const w = this.socks.get(j.id); if (w) { w.close(j.c, j.r); this.socks.delete(j.id); } }
  }
  request(j) {
    const id = j.id >>> 0, t = new URL(this.o.target), mod = t.protocol === 'https:' ? https : http;
    const path = String(j.u || '/');
    if (!path.startsWith('/') || path.startsWith('//')) return this.send({ t: 'err', id, e: 'bad url' });
    this.n = (this.n || 0) + 1; if (/^\/api\/(upload\/(file|thumb)|himg)|^\/sc-bg\//.test(path)) this.media = (this.media || 0) + 1;
    const up = mod.request({ host: t.hostname, port: t.port, method: String(j.m || 'GET'), path, headers: this.headers(j.h), setHost: false }, res => {
      const r = this.reqs.get(id); if (!r) return res.destroy();
      r.res = res;
      const h = [];
      let setCookies = [];
      for (let i = 0; i < res.rawHeaders.length; i += 2) {
        const k = res.rawHeaders[i].toLowerCase(), v = res.rawHeaders[i + 1];
        if (k === 'set-cookie') { setCookies.push(v); continue; }
        if (!HOP.has(k) || k === 'content-length') h.push([k, v]);   // content-length 留着：视频的 206 分段要用（不压缩，长度准）
      }
      const msg = { t: 'res', id, s: res.statusCode, st: res.statusMessage || '', h };
      if (setCookies.length) {   // 记进这条直连的 cookie，再给页面一张一次性凭证，去中继那条路把同样的 Set-Cookie 领回浏览器
        for (const c of setCookies) applySetCookie(this.jar, c);
        const k = crypto.randomBytes(18).toString('base64url');
        this.syncs.set(k, { list: setCookies, exp: Date.now() + 60e3 });
        msg.ck = k;
      }
      this.send(msg);
      res.on('data', d => { this.sendBin(id, d); if (this.congested()) { res.pause(); this.paused.add(res); } });
      res.on('end', () => { this.send({ t: 'end', id }); this.reqs.delete(id); });
      res.on('error', e => { this.send({ t: 'err', id, e: e.message }); this.reqs.delete(id); });
    });
    up.on('error', e => { if (this.reqs.has(id)) { this.send({ t: 'err', id, e: e.message }); this.reqs.delete(id); } });
    this.reqs.set(id, { up });
    if (!j.b) up.end();
  }
  takeSync(k) {
    for (const [x, v] of this.syncs) if (v.exp < Date.now()) this.syncs.delete(x);
    const v = this.syncs.get(k); if (!v) return null;
    this.syncs.delete(k); return v.list;
  }
  openWs(j) {
    const id = j.id >>> 0, path = String(j.u || '/');
    if (!path.startsWith('/') || path.startsWith('//')) return this.send({ t: 'wc', id, c: 1006, r: 'bad url' });
    const h = this.headers([]); delete h['accept-encoding'];
    const w = wsConnect(this.o.target, path, h, Array.isArray(j.p) ? j.p.map(String) : [], {
      open: p => this.send({ t: 'wo', id, p }),
      text: d => this.send({ t: 'wm', id, d }),
      close: (c, r) => { if (this.socks.delete(id)) this.send({ t: 'wc', id, c, r }); },
    });
    this.socks.set(id, w);
  }
}

// ---- cookie ----
function parseCookies(s) {
  const o = {};
  for (const p of String(s || '').split(/;\s*/)) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return o;
}
function applySetCookie(jar, sc) {
  const parts = String(sc).split(/;\s*/), i = parts[0].indexOf('=');
  if (i <= 0) return;
  const name = parts[0].slice(0, i).trim(), val = parts[0].slice(i + 1).trim();
  let gone = val === '';
  for (const a of parts.slice(1)) {
    const [k, v = ''] = a.split('=');
    if (/^max-age$/i.test(k.trim()) && Number(v) <= 0) gone = true;
    if (/^expires$/i.test(k.trim()) && Date.parse(v) < Date.now()) gone = true;
  }
  if (gone) delete jar[name]; else jar[name] = val;
}

// ---- 最小 WebSocket 客户端（只连本机应用；文本消息） ----
function wsConnect(target, path, headers, protocols, cb) {
  const t = new URL(target), mod = t.protocol === 'https:' ? https : http;
  const key = crypto.randomBytes(16).toString('base64');
  let sock = null, closed = false, buf = Buffer.alloc(0), frag = [], fragOp = 0;
  const h = { ...headers, connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': key };
  if (protocols.length) h['sec-websocket-protocol'] = protocols.join(', ');
  const end = (c = 1006, r = '') => { if (closed) return; closed = true; try { sock?.destroy(); } catch {} cb.close(c, r); };
  const up = mod.request({ host: t.hostname, port: t.port, path, headers: h, setHost: false });
  up.on('upgrade', (res, s, head) => {
    const want = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    if (res.headers['sec-websocket-accept'] !== want) { s.destroy(); return end(1006, 'bad accept'); }
    sock = s; s.setNoDelay(true);
    cb.open(res.headers['sec-websocket-protocol'] || '');
    s.on('data', d => { buf = Buffer.concat([buf, d]); parse(); });
    s.on('close', () => end(1006, ''));
    s.on('error', () => {});
    if (head?.length) { buf = Buffer.concat([buf, head]); parse(); }
  });
  up.on('response', res => { res.resume(); end(1006, 'HTTP ' + res.statusCode); });
  up.on('error', () => end(1006, ''));
  up.end();
  function frame(op, payload) {
    const len = payload.length, mask = crypto.randomBytes(4);
    const hd = len < 126 ? Buffer.from([0x80 | op, 0x80 | len]) : len < 65536 ? Buffer.from([0x80 | op, 0x80 | 126, len >> 8, len & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x80 | op; b[1] = 0x80 | 127; b.writeBigUInt64BE(BigInt(len), 2); return b; })();
    const p = Buffer.from(payload); for (let i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
    return Buffer.concat([hd, mask, p]);
  }
  function parse() {
    while (buf.length >= 2) {
      const fin = buf[0] & 0x80, op = buf[0] & 0x0f, masked = buf[1] & 0x80;
      let len = buf[1] & 0x7f, off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (masked) off += 4;
      if (buf.length < off + len) return;
      let p = buf.subarray(off, off + len);
      if (masked) { const m = buf.subarray(off - 4, off); p = Buffer.from(p); for (let i = 0; i < p.length; i++) p[i] ^= m[i & 3]; }
      buf = buf.subarray(off + len);
      if (op === 0x8) { const c = p.length >= 2 ? p.readUInt16BE(0) : 1005; try { sock.write(frame(0x8, p.subarray(0, 2))); } catch {} return end(c, p.subarray(2).toString('utf8')); }
      if (op === 0x9) { try { sock.write(frame(0xA, p)); } catch {} continue; }
      if (op === 0xA) continue;
      if (op === 0x1 || op === 0x2) { frag = [p]; fragOp = op; } else if (op === 0x0) frag.push(p); else continue;
      if (fin) { const all = Buffer.concat(frag); frag = []; cb.text(fragOp === 0x1 ? all.toString('utf8') : all.toString('base64')); }
    }
  }
  return {
    sendText(s) { if (sock && !closed) try { sock.write(frame(0x1, Buffer.from(s, 'utf8'))); } catch {} },
    close(c = 1000, r = '') {
      if (closed) return;
      if (sock) { const b = Buffer.alloc(2); b.writeUInt16BE(Number(c) >= 1000 && Number(c) < 5000 && c !== 1005 && c !== 1006 ? Number(c) : 1000, 0); try { sock.write(frame(0x8, Buffer.concat([b, Buffer.from(String(r || '').slice(0, 100))]))); } catch {} setTimeout(() => sock?.destroy(), 1000); }
      closed = true; if (!sock) up.destroy();
    },
    destroy() { closed = true; try { sock?.destroy(); up.destroy(); } catch {} },
  };
}
