// clarelay 直连（页面端）：由电脑端 clarelay 在 /_clarelay/rtc.js 提供，宿主页面在主脚本之前加载。
//
//   clarelay.fetch(url, init)      和 fetch 一样；直连通了走 DataChannel，否则走原生（经中继）
//   new clarelay.WebSocket(url)    和 WebSocket 一样；直连断了或换路线时直接触发 close，由页面自己重连
//   clarelay.route                 'direct' | 'relay'；clarelay.addEventListener('route', e => e.detail.route)
//   clarelay.info()                当前路线详情（候选类型、地址、往返时间）
//
// 走原生的情况：直连没通、跨域地址、keepalive 请求、/_clarelay/ 自己的地址。
//
// 质量门槛（4G 上 UDP 常丢包限速，直连反而比中继慢）：
//   打通后先「试用」：每 3 秒 ping 一次，最近 30 秒的往返中位数 < 300ms、最多丢 1 次，才把 route 切成直连（试用期请求照常走中继）；90 秒没达标就放弃。
//   10 分钟内直连好好用过（回前台、刷新、断线重连）：快速通道，连 2 次 ping 达标就切直连。
//   在用时每 5 秒 ping 一次（顺带给 4G 的 UDP 映射保活）：一次超过 1.5 秒、或连丢 2 次 → 降回中继。
//   单个 GET/HEAD 2.5 秒内电脑端还没回「收到」→ 这一个改走中继；1 分钟内两次 → 降回中继。
//   降级后 10 分钟内不再试直连（换了网络就马上再试）。
(function () {
  'use strict';
  if (typeof window === 'undefined' || window.clarelay) return;
  const NativeFetch = window.fetch.bind(window), NativeWS = window.WebSocket;
  const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }, { urls: ['stun:stun.miwifi.com:3478', 'stun:stun.chat.bilibili.com:3478'] }];
  const CHUNK = 16 * 1024, HIGH = 1 << 20, BIG = 0xFFFFFFFF;   // 超过单条消息上限的控制消息：拆成编号 BIG 的二进制分片 + {t:'big'} 收尾
  let bigParts = [], acks = false;   // acks：电脑端会回「已交给应用多少字节」（新版才有），上传按它控流、报进度
  const WINDOW = 8 << 20, READ = 256 * 1024;
  const uploads = new Map();   // 编号 → { acked, wake }
  const bus = new EventTarget();
  const CFG = Object.assign({ probation: 30e3, fast: 2, good: 300, slow: 1500, giveUp: 90e3, penalty: 10 * 60e3, trialPenalty: 3 * 60e3, recent: 10 * 60e3, openWait: 20e3, reqWait: 2500 }, window.CLARELAY_RTC || {});
  let samples = [];   // 试用期的 ping：{t, rtt}（丢了 rtt = null）
  const LS = 'clarelay:directOk';   // 上次直连好好用着的时间（跨刷新）
  const recentOk = () => { try { return Date.now() - (+localStorage.getItem(LS) || 0) < CFG.recent; } catch (e) { return false; } };
  const markOk = () => { try { localStorage.setItem(LS, String(Date.now())); } catch (e) {} };
  const clearOk = () => { try { localStorage.removeItem(LS); } catch (e) {} };
  let badUntil = 0, healthTimer = null, misses = 0, openedAt = 0, lastRtt = null, strikes = [], gotAck = false;
  let lastError = '', nextTry = 0, offUntil = 0;   // 诊断：上次失败原因、下次重试时间；offUntil：电脑端暂时不给直连（404 / 被撤销），到点再试
  let route = 'relay', pc = null, dc = null, connecting = null, nextId = 1, retryMs = 15e3, retryTimer = null, lastTry = 0, disabled = false;
  const reqs = new Map(), socks = new Map(), pings = new Map();
  const enc = new TextEncoder();

  let via = null;   // 直连走的路：'lan' | 'internet' | 'tailscale'（电脑端告诉我们；老电脑端不说就是 null）
  const viaNow = () => route === 'relay' ? 'relay' : (via || 'direct');
  const emit = () => { bus.dispatchEvent(Object.assign(new Event('route'), { detail: { route, via: viaNow() } })); tellSW(); };
  const setRoute = r => { if (route === r) return; route = r; if (r === 'relay') via = null; emit(); };
  const sameOrigin = u => u.origin === location.origin;

  // ---------- 连接 ----------
  function teardown(why) {
    const wasDirect = route === 'direct';
    clearTimeout(healthTimer); healthTimer = null; misses = 0; lastRtt = null; samples = [];
    try { dc && dc.close(); } catch (e) {}
    try { pc && pc.close(); } catch (e) {}
    pc = null; dc = null;
    for (const r of reqs.values()) r.fail(new TypeError('直连断开：' + why));
    reqs.clear();
    for (const w of socks.values()) w._closed(1006, '');
    socks.clear();
    for (const p of pings.values()) p(false);
    pings.clear();
    for (const u of uploads.values()) u.wake?.();
    uploads.clear();
    setRoute('relay');
    lastError = String(why);
    if (wasDirect) { retryMs = 15e3; schedule(1000); } else schedule();   // 直连刚断：马上重新打洞
  }
  function schedule(ms) {
    clearTimeout(retryTimer);
    if (disabled) return;
    let wait = ms ?? retryMs;
    const until = Math.max(offUntil, badUntil);
    if (until > Date.now()) wait = Math.max(wait, until - Date.now());
    nextTry = Date.now() + wait;
    retryTimer = setTimeout(connect, wait);
    if (ms === undefined) retryMs = Math.min(retryMs * 2, 2 * 60e3);   // 中转时一直定时重试：15 秒起翻倍，最长 2 分钟
  }
  function connect() {
    if (connecting || dc || disabled || typeof RTCPeerConnection === 'undefined') return connecting;
    lastTry = Date.now();
    connecting = (async () => {
      const p = new RTCPeerConnection({ iceServers: ICE });
      const ch = p.createDataChannel('clarelay', { ordered: true });
      ch.binaryType = 'arraybuffer';
      try {
        await p.setLocalDescription(await p.createOffer());
        await new Promise(ok => { if (p.iceGatheringState === 'complete') return ok(); p.addEventListener('icegatheringstatechange', () => p.iceGatheringState === 'complete' && ok()); setTimeout(ok, 3000); });
        const r = await NativeFetch('/_clarelay/rtc', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sdp: p.localDescription.sdp, prev: lastError.slice(0, 120) }) });
        if (r.status === 501) { disabled = true; throw new Error('电脑端没装直连组件'); }
        if (r.status === 404) { offUntil = Date.now() + 5 * 60e3; throw new Error('电脑端暂不接受直连（404）'); }
        if (!r.ok) throw new Error('牵线失败 HTTP ' + r.status);
        const j = await r.json();
        acks = (j.v || 0) >= 2; gotAck = (j.v || 0) >= 3;
        await p.setRemoteDescription({ type: 'answer', sdp: j.sdp });
        await new Promise((ok, bad) => {
          if (ch.readyState === 'open') return ok();
          ch.addEventListener('open', ok); ch.addEventListener('close', () => bad(new Error('通道关闭')));
          setTimeout(() => bad(new Error('打洞超时')), CFG.openWait);   // 跨运营商连通检查有时要十几秒；电脑端等 30 秒
        });
        pc = p; dc = ch;
        ch.bufferedAmountLowThreshold = 256 * 1024;
        ch.addEventListener('message', onMessage);
        ch.addEventListener('close', () => { if (dc === ch) teardown('通道关闭'); });
        p.addEventListener('connectionstatechange', () => { if (pc === p && /failed|closed/.test(p.connectionState)) teardown(p.connectionState); });
        retryMs = 15e3; lastError = ''; nextTry = 0;
        openedAt = Date.now(); misses = 0; strikes = []; samples = [];
        health();   // 先试用，达标了才切成直连
      } catch (e) {
        try { ch.close(); p.close(); } catch (x) {}
        lastError = (e && e.message) || String(e);
        setRoute('relay'); schedule();
      } finally { connecting = null; }
    })();
    return connecting;
  }
  // 降级：关掉直连，一段时间内不再试（换网络会清掉）
  function demote(why, ms = CFG.penalty) { badUntil = Date.now() + ms; clearOk(); teardown('质量差：' + why); }
  async function health() {
    healthTimer = null;
    const ch = dc; if (!ch) return;
    const t0 = Date.now(), ok = await ping(route === 'direct' ? 3000 : CFG.slow), rtt = Date.now() - t0;
    if (dc !== ch) return;
    lastRtt = ok ? rtt : null;
    if (route === 'direct') {
      // 偶尔一次慢或丢（跨运营商常见）不算；连着 2 次才降级
      if (ok && rtt <= CFG.slow) { misses = 0; markOk(); }
      else if (++misses >= 2) return demote(ok ? '连续 2 次往返超过 ' + CFG.slow + 'ms（' + rtt + 'ms）' : '连丢 2 次 ping');
    } else {
      samples.push({ t: t0, rtt: ok ? rtt : null });
      if (passTrial()) { markOk(); setRoute('direct'); }
      else if (Date.now() - openedAt > CFG.giveUp) return demote('试用 ' + Math.round(CFG.giveUp / 1000) + ' 秒没达标', CFG.trialPenalty);
    }
    healthTimer = setTimeout(health, route === 'direct' ? 5000 : 3000);
  }
  function passTrial() {
    const good = x => x.rtt !== null && x.rtt < CFG.good;
    if (recentOk() && samples.length >= CFG.fast && samples.slice(-CFG.fast).every(good)) return true;   // 快速通道
    const now = Date.now(); if (now - openedAt < CFG.probation) return false;   // 试用期还没满
    const win = samples.filter(x => now - x.t <= CFG.probation + 3500);   // 最近一个试用期（多留一个 ping 间隔）
    const got = win.filter(x => x.rtt !== null).map(x => x.rtt).sort((a, b) => a - b);
    if (win.length - got.length > 1) return false;
    return got.length > 0 && got[got.length >> 1] < CFG.good;
  }
  function strike(why) {   // 单个请求在直连上卡住
    const now = Date.now(); strikes = strikes.filter(t => now - t < 60e3); strikes.push(now);
    lastError = why;
    if (strikes.length >= 2 && route === 'direct') demote('1 分钟内 2 个请求卡住');
  }
  function ping(ms = 2000) {
    if (!dc || dc.readyState !== 'open') return Promise.resolve(false);
    const n = nextId++;
    return new Promise(ok => { const t = setTimeout(() => { pings.delete(n); ok(false); }, ms); pings.set(n, v => { clearTimeout(t); ok(v); }); send({ t: 'ping', n }); });
  }
  // 切回前台：直连可能被冻死了，先探一下；没直连就早点重试
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    if (dc) { if (!(await ping(2000))) teardown('回前台探测失败'); }
    else if (!connecting && Date.now() - lastTry > 5e3) { retryMs = 15e3; schedule(0); }
  });
  window.addEventListener('online', () => { badUntil = 0; if (!dc && !connecting) { retryMs = 15e3; schedule(0); } });   // 网络切换（Wi‑Fi ↔ 流量）：换了网络，之前的降级不算数

  function send(o) {
    try {
      const s = JSON.stringify(o);
      if (s.length <= 30000) { dc.send(s); return true; }   // 30000 个字符转 UTF-8 最多约 90KB，在各家浏览器的单条上限内
      const all = enc.encode(s);
      for (let i = 0; i < all.length; i += CHUNK) {
        const part = all.subarray(i, i + CHUNK), b = new Uint8Array(4 + part.length);
        new DataView(b.buffer).setUint32(0, BIG); b.set(part, 4); dc.send(b);
      }
      dc.send('{"t":"big"}'); return true;
    } catch (e) { return false; }
  }
  // 请求体：Blob / File 按块读（不整个读进内存），16KB 一片发；通道积压、或电脑端还没交给应用的超过 8MB 就等
  async function sendBody(id, body, prog) {
    const blob = typeof Blob !== 'undefined' && body instanceof Blob, total = blob ? body.size : body.byteLength;
    const u = { acked: 0, wake: null, total }; uploads.set(id, u);
    let sent = 0;
    const report = u.report = () => { if (prog) try { prog(Math.min(acks ? u.acked : sent, total), total); } catch (e) {} };
    try {
      for (let off = 0; off < total; off += READ) {
        const buf = blob ? new Uint8Array(await body.slice(off, off + READ).arrayBuffer()) : new Uint8Array(body, off, Math.min(READ, total - off));
        for (let i = 0; i < buf.length; i += CHUNK) {
          const ch = dc; if (!ch || !uploads.has(id)) throw new TypeError('直连断开');
          if (ch.bufferedAmount > HIGH) await new Promise(ok => { const go = () => { ch.removeEventListener('bufferedamountlow', go); ch.removeEventListener('close', go); ok(); }; ch.addEventListener('bufferedamountlow', go); ch.addEventListener('close', go); });
          while (acks && dc && uploads.has(id) && sent - u.acked > WINDOW) await new Promise(ok => { u.wake = ok; });
          if (!dc || dc !== ch || !uploads.has(id)) throw new TypeError('直连断开');
          const part = buf.subarray(i, i + CHUNK), b = new Uint8Array(4 + part.length);
          new DataView(b.buffer).setUint32(0, id); b.set(part, 4);
          dc.send(b); sent += part.length;
          if (!acks) report();
        }
      }
    } catch (e) { uploads.delete(id); throw e instanceof TypeError ? e : new TypeError('直连上传失败：' + (e && e.message)); }
  }
  function uploadDone(id) { const u = uploads.get(id); if (!u) return; uploads.delete(id); u.acked = u.total; u.report(); u.wake?.(); }
  function uploadDrop(id) { const u = uploads.get(id); if (!u) return; uploads.delete(id); u.wake?.(); }
  function onMessage(e) {
    if (typeof e.data !== 'string') {
      const b = new Uint8Array(e.data); if (b.length < 4) return;
      const id = new DataView(b.buffer, b.byteOffset).getUint32(0);
      if (id === BIG) { bigParts.push(b.slice(4)); return; }
      reqs.get(id)?.chunk(b.subarray(4));
      return;
    }
    let j; try { j = JSON.parse(e.data); } catch (x) { return; }
    if (j.t === 'big') {
      const n = bigParts.reduce((a, p) => a + p.length, 0), all = new Uint8Array(n); let o = 0;
      for (const p of bigParts) { all.set(p, o); o += p.length; }
      bigParts = [];
      return onMessage({ data: new TextDecoder().decode(all) });
    }
    if (j.t === 'pong') { pings.get(j.n)?.(true); pings.delete(j.n); }
    else if (j.t === 'ack') { const u = uploads.get(j.id); if (u) { u.acked = j.n; u.wake?.(); u.wake = null; u.report?.(); } }
    else if (j.t === 'got') reqs.get(j.id)?.got?.();
    else if (j.t === 'res') reqs.get(j.id)?.head(j);
    else if (j.t === 'end') { reqs.get(j.id)?.end(); reqs.delete(j.id); }
    else if (j.t === 'err') { reqs.get(j.id)?.fail(new TypeError(j.e || '直连请求失败')); reqs.delete(j.id); }
    else if (j.t === 'wo') socks.get(j.id)?._open(j.p);
    else if (j.t === 'wm') socks.get(j.id)?._message(j.d);
    else if (j.t === 'wc') { socks.get(j.id)?._closed(j.c, j.r); socks.delete(j.id); }
    else if (j.t === 'bye') { offUntil = Date.now() + 60e3; teardown('电脑端要求断开（登录失效）'); }
    else if (j.t === 'via') { if (via !== j.via) { via = j.via; if (route === 'direct') emit(); } }
  }

  // ---------- fetch ----------
  const NULL_BODY = new Set([101, 103, 204, 205, 304]);
  async function directFetch(input, init) {
    const req = new Request(typeof input === 'string' || input instanceof URL ? new URL(input, location.href) : input, init);
    const u = new URL(req.url);
    if (route !== 'direct' || !dc || !sameOrigin(u) || u.pathname.startsWith('/_clarelay/') || (init && init.keepalive) || req.mode === 'navigate') return NativeFetch(input, init);
    const signal = req.signal;
    if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const raw = init && init.body, prog = init && typeof init.onUploadProgress === 'function' ? init.onUploadProgress : null;
    const body = /^(GET|HEAD)$/.test(req.method) ? null : typeof Blob !== 'undefined' && raw instanceof Blob ? raw : await req.arrayBuffer();
    const id = nextId++, h = [];
    req.headers.forEach((v, k) => h.push([k, v]));
    return new Promise((resolve, reject) => {
      let ctrl = null, started = false, done = false;
      const fallback = /^(GET|HEAD)$/.test(req.method);
      let waitT = null;
      const entry = {
        got() { clearTimeout(waitT); },
        head(j) {
          started = true; uploadDone(id); clearTimeout(waitT);
          const nb = NULL_BODY.has(j.s) || req.method === 'HEAD';
          const stream = nb ? null : new ReadableStream({ start(c) { ctrl = c; }, cancel() { cancel(); } });   // 先建好：后面的分片不会丢
          if (nb) done = true;
          (async () => {
            if (j.ck) { try { await NativeFetch('/_clarelay/cookie?k=' + encodeURIComponent(j.ck), { credentials: 'same-origin', cache: 'no-store' }); } catch (e) {} }
            if (j.s >= 300 && j.s < 400 && fallback) { cancel(); return resolve(NativeFetch(input, init)); }   // 跳转：交给浏览器自己跟
            const headers = new Headers(); for (const [k, v] of j.h || []) try { headers.append(k, v); } catch (e) {}
            resolve(new Response(stream, { status: j.s >= 200 && j.s <= 599 ? j.s : 502, statusText: j.st || '', headers }));
          })();
        },
        chunk(b) { if (ctrl) try { ctrl.enqueue(b.slice()); } catch (e) {} },
        end() { done = true; if (ctrl) try { ctrl.close(); } catch (e) {} },
        fail(err) {
          clearTimeout(waitT);
          if (done) return; done = true;
          if (!started) { if (fallback) resolve(NativeFetch(input, init)); else reject(err); }
          else if (ctrl) try { ctrl.error(err); } catch (e) {}
        },
      };
      const cancel = () => { uploadDrop(id); if (reqs.delete(id)) send({ t: 'cancel', id }); };
      if (signal) signal.addEventListener('abort', () => {
        const err = new DOMException('Aborted', 'AbortError'); cancel();
        if (!started) { done = true; reject(err); } else entry.fail(err);
      }, { once: true });
      reqs.set(id, entry);
      if (!send({ t: 'req', id, m: req.method, u: u.pathname + u.search, h, b: !!body })) { reqs.delete(id); return fallback ? resolve(NativeFetch(input, init)) : reject(new TypeError('直连发送失败')); }
      if (body) sendBody(id, body, prog).then(() => send({ t: 'eob', id })).catch(err => { cancel(); entry.fail(err); });
      // 电脑端 2.5 秒还没回「收到」：路上卡住了（不是应用慢）→ 这个请求改走中继
      if (fallback && gotAck) waitT = setTimeout(() => { if (started || done) return; cancel(); done = true; strike('请求 ' + u.pathname + ' 在直连上卡住'); resolve(NativeFetch(input, init)); }, CFG.reqWait);
    });
  }

  // ---------- WebSocket ----------
  class DirectWS extends EventTarget {
    constructor(url, protocols) {
      super();
      this.url = url.href; this.readyState = 0; this.protocol = ''; this.extensions = ''; this.binaryType = 'blob'; this.bufferedAmount = 0;
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this._id = nextId++;
      socks.set(this._id, this);
      const p = protocols == null ? [] : [].concat(protocols);
      if (!send({ t: 'ws', id: this._id, u: url.pathname + url.search, p })) setTimeout(() => this._closed(1006, ''), 0);
    }
    _fire(type, props) { const e = Object.assign(new Event(type), props || {}); this.dispatchEvent(e); const f = this['on' + type]; if (typeof f === 'function') f.call(this, e); }
    _open(p) { if (this.readyState !== 0) return; this.readyState = 1; this.protocol = p || ''; this._fire('open'); }
    _message(d) { if (this.readyState === 1) this._fire('message', { data: d, origin: location.origin }); }
    _closed(code, reason) {
      if (this.readyState === 3) return;
      const clean = code === 1000;
      this.readyState = 3; socks.delete(this._id);
      if (!clean) this._fire('error');
      this._fire('close', { code: code || 1006, reason: reason || '', wasClean: clean });
    }
    send(d) {
      if (this.readyState === 0) throw new DOMException('Still in CONNECTING state.', 'InvalidStateError');
      if (this.readyState !== 1) return;
      if (typeof d !== 'string') throw new TypeError('直连 WebSocket 只支持文本消息');
      send({ t: 'wm', id: this._id, d });
    }
    close(code, reason) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      send({ t: 'wc', id: this._id, c: code || 1000, r: reason || '' });
      setTimeout(() => this._closed(code || 1000, reason || ''), 0);
    }
  }
  for (const [k, v] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) { DirectWS[k] = v; DirectWS.prototype[k] = v; }
  function ClarelayWebSocket(url, protocols) {
    const u = new URL(url, location.href);
    if (route === 'direct' && dc && u.host === location.host && !u.pathname.startsWith('/_clarelay/')) return new DirectWS(u, protocols);
    return protocols === undefined ? new NativeWS(url) : new NativeWS(url, protocols);
  }
  for (const k of ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED']) ClarelayWebSocket[k] = NativeWS[k];

  // ---------- 对外 ----------
  async function info() {
    const out = { route, via: viaNow(), trial: !!dc && route === 'relay' || undefined, rtt: lastRtt ?? undefined, badUntil: badUntil > Date.now() ? new Date(badUntil).toISOString() : undefined, lastError: lastError || undefined, lastTry: lastTry ? new Date(lastTry).toISOString() : undefined, nextTry: !dc && nextTry ? new Date(nextTry).toISOString() : undefined, disabled: disabled || undefined };
    if (!pc) return out;
    try {
      const stats = await pc.getStats(); let pair = null;
      stats.forEach(s => { if (s.type === 'transport' && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId); });
      if (!pair) stats.forEach(s => { if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') pair = s; });
      if (pair) {
        const l = stats.get(pair.localCandidateId), r = stats.get(pair.remoteCandidateId);
        out.local = l && { type: l.candidateType, address: l.address || l.ip, protocol: l.protocol };
        out.remote = r && { type: r.candidateType, address: r.address || r.ip, protocol: r.protocol };
        out.rtt = pair.currentRoundTripTime;
      }
    } catch (e) {}
    return out;
  }
  window.clarelay = {
    fetch: directFetch, WebSocket: ClarelayWebSocket, info, ping,
    get route() { return route; },
    get via() { return viaNow(); },   // 'lan' 直连·局域网 | 'internet' 直连·外网 | 'tailscale' 直连·经 Tailscale | 'relay' 中转 | 'direct'（老电脑端，不知道哪种）
    addEventListener: bus.addEventListener.bind(bus), removeEventListener: bus.removeEventListener.bind(bus),
    reconnect() { disabled = false; if (dc) teardown('手动重连'); retryMs = 15e3; return connect(); },
  };
  // ---------- 图片 / 视频 / 文件预览（src 地址浏览器自己取，fetch 包装管不到）：交给页面的 Service Worker ----------
  // 页面的 SW 里 importScripts('/_clarelay/sw.js')，它把这类请求转给这里，这里走直连取回来再一块块交回去。
  const swc = typeof navigator !== 'undefined' && navigator.serviceWorker;
  function tellSW() { try { swc && swc.controller && swc.controller.postMessage({ t: 'clarelay:route', route }); } catch (e) {} }
  async function bridge(m, port) {
    if (route !== 'direct' || !dc) return port.postMessage({ t: 'nope' });
    const ac = new AbortController();
    port.onmessage = e => { if (e.data && e.data.t === 'cancel') ac.abort(); };
    try {
      const r = await directFetch(m.url, { method: 'GET', headers: m.headers || [], signal: ac.signal, credentials: 'same-origin' });
      const h = []; r.headers.forEach((v, k) => h.push([k, v]));
      port.postMessage({ t: 'head', s: r.status, st: r.statusText, h });
      if (!r.body) return port.postMessage({ t: 'end' });
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read(); if (done) break;
        const b = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        port.postMessage({ t: 'chunk', b }, [b]);
      }
      port.postMessage({ t: 'end' });
    } catch (e) { try { port.postMessage({ t: 'error', e: String((e && e.message) || e) }); } catch (x) {} }
  }
  if (swc) {
    swc.addEventListener('message', e => { const m = e.data; if (m && m.t === 'clarelay:fetch' && e.ports && e.ports[0]) bridge(m, e.ports[0]); });
    swc.addEventListener('controllerchange', tellSW);
    setInterval(tellSW, 20e3);
    tellSW();
  }

  connect();
})();
