// 投屏：把网页里在播的电影 / 视频投到局域网里的电视（DLNA）
//   1. 片源网页 → 真正的视频地址：skills/_lib/media/engine.mjs stream（yt-dlp），见那里的说明
//   2. 电视多半上不了 YouTube，也不会处理 YouTube 分开的音频、视频：claclaw 在局域网里开一个只给电视用的转发服务，
//      电视向它要，它走本机代理向片源要；YouTube 的音视频按段合成一路 TS（tsmux.mjs）
//   3. 转发服务只在投屏时开，只监听局域网地址，网址里带随机会话号；不投了（停止、换片、3 小时没人要）就关
// 同一时间只投一部：再投新的，旧的停掉
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { discover, cached, avt, lanAddrs } from './dlna.mjs';
import { mux } from './tsmux.mjs';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const IDLE = 3 * 3600e3;
export const CASTABLE = /^https?:\/\/(?:(?:www\.|m\.)?youtube\.com\/(?:watch\?|shorts\/|live\/|embed\/)|youtu\.be\/|(?:www\.)?dailymotion\.com\/video\/|dai\.ly\/|archive\.org\/details\/)|^https:\/\/[^\s?#]+\.m3u8(?:\?|$)/;   // 最后一种：直播流直链（CGTN 等）

// ---------- 走代理取上游（Node 的 fetch 不认代理）：HTTP CONNECT 隧道；Clash 的 7890 / 7897 混合端口也认 ----------
function tunnel(px, host, port) {
  return new Promise((ok, no) => {
    const p = new URL(/^\w+:\/\//.test(px) ? px : 'http://' + px);
    const r = http.request({ host: p.hostname, port: p.port || 80, method: 'CONNECT', path: `${host}:${port}`, headers: { host: `${host}:${port}` }, timeout: 15000 });
    r.on('connect', (res, sock) => res.statusCode === 200 ? ok(sock) : (sock.destroy(), no(new Error('代理拒绝连接 ' + res.statusCode))));
    r.on('error', no); r.on('timeout', () => r.destroy(new Error('连代理超时')));
    r.end();
  });
}
export async function upstream(u, { headers = {}, proxy = '', redirects = 5 } = {}) {
  const U = new URL(u), tlsOn = U.protocol === 'https:', port = +U.port || (tlsOn ? 443 : 80);
  let createConnection;
  if (proxy) {
    let sock = await tunnel(proxy, U.hostname, port);
    if (tlsOn) sock = await new Promise((ok, no) => { const t = tls.connect({ socket: sock, servername: U.hostname, ALPNProtocols: ['http/1.1'] }, () => ok(t)); t.once('error', no); });   // 握手完再交给 http；不能同时设 agent:false，否则请求发不出去
    createConnection = () => sock;
  }
  const res = await new Promise((ok, no) => {
    const mod = proxy || !tlsOn ? http : https;
    const r = mod.request({ host: U.hostname, port, path: U.pathname + U.search, method: 'GET', headers: { 'user-agent': UA, ...headers, host: U.host }, ...(createConnection ? { createConnection } : {}), timeout: 20000 }, ok);
    r.on('error', no); r.on('timeout', () => r.destroy(new Error('片源超时')));
    r.end();
  });
  if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) { res.resume(); return upstream(new URL(res.headers.location, u).href, { headers, proxy, redirects: redirects - 1 }); }
  return res;
}
async function fetchBuf(u, opts) {
  const r = await upstream(u, opts);
  const bufs = []; for await (const c of r) bufs.push(c);
  if (r.statusCode !== 200 && r.statusCode !== 206) throw new Error('片源回 HTTP ' + r.statusCode);
  return Buffer.concat(bufs);
}
const segUrls = text => text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));

export function makeCaster({ ROOT, DATA = '', log = () => {} }) {
  const LAST = DATA && path.join(DATA, 'cast-last.json');   // 上次投到的电视：技能不指定电视时用它
  const lastDev = () => { try { return JSON.parse(fs.readFileSync(LAST, 'utf8')); } catch { return null; } };
  const st = { id: '', phase: '', error: '', title: '', page: '', device: null, startedAt: 0, start: 0, hits: 0, lastHit: 0, plan: null, kind: '' };
  const plans = new Map();   // 网页 → 解析结果（1 小时内再投不重新解析）
  let server = null, serverAddr = '', session = null, gen = 0;

  function resolve(page) {
    const c = plans.get(page);
    if (c && Date.now() - c.at < 3600e3) return c.p;
    const p = new Promise((ok, no) => execFile(process.execPath, [path.join(ROOT, 'skills', '_lib', 'media', 'engine.mjs'), 'stream', page], { timeout: 120000, maxBuffer: 4 << 20, windowsHide: true }, (e, out, err) => {
      if (e) return no(new Error((String(err || '').trim().split('\n').filter(l => !/^\s*at /.test(l)).pop() || e.message).replace(/^Error:\s*/, '').slice(0, 300)));
      try { ok(JSON.parse(String(out).trim().split('\n').pop())); } catch { no(new Error('解析视频地址失败')); }
    }));
    plans.set(page, { at: Date.now(), p });
    p.catch(() => plans.delete(page));
    return p;
  }

  // ---------- 局域网转发服务 ----------
  async function ensureServer(local) {
    if (server && serverAddr.startsWith(local + ':')) return;
    closeServer();
    const s = http.createServer((req, res) => serve(req, res).catch(e => { log('cast: 转发出错', e.message); if (!res.headersSent) res.writeHead(502); res.end(); }));
    s.on('clientError', (e, sock) => sock.destroy());
    await new Promise((ok, no) => { s.once('error', no); s.listen(0, local, ok); });
    server = s; serverAddr = local + ':' + s.address().port;
    log('cast: 局域网转发服务', serverAddr);
  }
  function closeServer() { if (server) { server.close(); server.closeAllConnections?.(); server = null; serverAddr = ''; } }

  const b64 = s => Buffer.from(s).toString('base64url'), unb64 = s => Buffer.from(s, 'base64url').toString();
  async function serve(req, res) {
    const m = /^\/c\/([0-9a-f]{32})\/(.*)$/.exec(req.url.split('?')[0]);
    if (!m || !session || m[1] !== session.sid || req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(404); return res.end(); }
    const S = session, rest = m[2], px = S.plan.proxy || '';
    S.lastHit = Date.now(); st.hits++; st.lastHit = S.lastHit;
    if (S.plan.kind === 'yt') {
      if (!S.vlist) {   // 两份分段列表取一次就留着（地址几个小时有效）
        const [v, a] = await Promise.all([fetchBuf(S.plan.video, { proxy: px }), fetchBuf(S.plan.audio, { proxy: px })]);
        S.vtext = v.toString(); S.vlist = segUrls(S.vtext); S.alist = segUrls(a.toString());
        if (!S.vlist.length || S.vlist.length !== S.alist.length) throw new Error(`音视频分段对不上（${S.vlist.length} / ${S.alist.length}）`);
      }
      if (rest === 'index.m3u8') {
        let i = 0;
        const body = S.vtext.split('\n').map(l => l.trim() && !l.startsWith('#') ? `${i++}.ts` : l).join('\n');
        res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      const k = /^(\d+)\.ts$/.exec(rest), i = k ? +k[1] : -1;
      if (i < 0 || i >= S.vlist.length) { res.writeHead(404); return res.end(); }
      const [v, a] = await Promise.all([fetchBuf(S.vlist[i], { proxy: px }), fetchBuf(S.alist[i], { proxy: px })]);
      const out = mux(v, a, S.cc ||= { a: { n: 0 }, pmt: { n: 0 } });
      res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': out.length });
      return res.end(req.method === 'HEAD' ? undefined : out);
    }
    if (S.plan.kind === 'hls') {   // /c/<sid>/p/<地址>/x.m3u8|x.ts：列表里的地址都改成经过这里
      const k = /^p\/([\w-]+)\//.exec(rest);
      if (!k) { res.writeHead(404); return res.end(); }
      const u = unb64(k[1]);
      if (!S.allowed.has(u)) { res.writeHead(404); return res.end(); }   // 只转发列表里出现过的地址
      const r = await upstream(u, { proxy: px, headers: req.headers.range ? { range: req.headers.range } : {} });
      const ct = r.headers['content-type'] || '';
      if (/mpegurl/i.test(ct) || /\.m3u8(\?|$)/.test(u)) {
        const bufs = []; for await (const c of r) bufs.push(c);
        const body = rewrite(S, Buffer.concat(bufs).toString(), u);
        res.writeHead(r.statusCode === 206 ? 200 : r.statusCode, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-cache' });
        return res.end(req.method === 'HEAD' ? undefined : body);
      }
      return pipe(r, res, ct || 'video/mp2t', req.method);
    }
    if (rest !== 'v.mp4') { res.writeHead(404); return res.end(); }   // file：mp4 直链，Range 原样转
    const r = await upstream(S.plan.url, { proxy: px, headers: req.headers.range ? { range: req.headers.range } : {} });
    return pipe(r, res, S.plan.mime || 'video/mp4', req.method);
  }
  function pipe(r, res, ct, method) {
    const h = { 'content-type': /^(video|audio|application\/octet)/.test(ct) ? ct : 'video/mp4', 'accept-ranges': 'bytes' };
    for (const k of ['content-length', 'content-range']) if (r.headers[k]) h[k] = r.headers[k];
    res.writeHead(r.statusCode, h);
    if (method === 'HEAD') { r.destroy(); return res.end(); }
    res.on('close', () => r.destroy());
    r.pipe(res);
  }
  function rewrite(S, text, base) {
    const wrap = x => { const u = new URL(x, base).href; S.allowed.add(u); return `/c/${S.sid}/p/${b64(u)}/${/\.m3u8(\?|$)/.test(u) ? 'x.m3u8' : 'x.ts'}`; };
    return text.split('\n').map(l => { const t = l.trim(); return t.startsWith('#') ? l.replace(/URI="([^"]+)"/g, (_, x) => `URI="${wrap(x)}"`) : t ? wrap(t) : l; }).join('\n');
  }

  // ---------- 设备 ----------
  async function device(id, { fresh = false } = {}) {
    let d = !fresh && cached(id);
    if (!d) d = (await discover({ fresh: true })).find(x => x.id === id);
    if (!d) throw new Error('找不到这台电视了（关机了、或不在同一个 Wi-Fi？）');
    return d;
  }
  async function onDevice(fn) {   // 接收端端口会变：连不上就重新找一遍再试
    try { return await fn(await device(st.device.id)); }
    catch (e) { if (!/ECONNREFUSED|fetch failed|EHOSTUNREACH|ETIMEDOUT/i.test(e.message + (e.cause?.code || ''))) throw e; return fn(await device(st.device.id, { fresh: true })); }
  }

  // ---------- 对外 ----------
  async function devices({ fresh = false } = {}) {
    if (!lanAddrs().length) return { ok: false, error: '这台电脑没连局域网（Wi-Fi / 网线），找不到电视', devices: [] };
    const list = await discover({ fresh });
    return { ok: true, devices: list.map(d => ({ id: d.id, name: d.name, model: d.model, host: d.host })), last: lastDev()?.id || '' };
  }

  // 开始投：马上返回，进度看 status()
  async function play({ page, title = '', device: devId, start = 0 }) {
    page = String(page || '').trim();
    if (!CASTABLE.test(page)) throw new Error('这个视频投不了屏（只支持 YouTube、Dailymotion、Internet Archive 和直播流）');
    const d = await device(String(devId || ''));
    const my = ++gen;
    polled = { at: 0, v: null };
    if (st.device && session && st.device.id !== d.id) { const old = st.device; device(old.id).then(x => avt.stop(x)).catch(() => {}); }
    Object.assign(st, { id: crypto.randomBytes(4).toString('hex'), phase: 'resolving', error: '', title, page, device: { id: d.id, name: d.name }, startedAt: Date.now(), start: Math.max(0, +start || 0), hits: 0, lastHit: 0, kind: '' });
    (async () => {
      try {
        const plan = await resolve(page);
        if (my !== gen) return;
        st.title = title || plan.title; st.kind = plan.kind;
        await ensureServer(d.local);
        session = { sid: crypto.randomBytes(16).toString('hex'), plan, allowed: new Set(), lastHit: Date.now() };
        const base = `http://${serverAddr}/c/${session.sid}/`;
        let url, mime;
        if (plan.kind === 'yt') { url = base + 'index.m3u8'; mime = 'application/vnd.apple.mpegurl'; }
        else if (plan.kind === 'hls') { session.allowed.add(plan.url); url = base + 'p/' + b64(plan.url) + '/x.m3u8'; mime = 'application/vnd.apple.mpegurl'; }
        else { url = base + 'v.mp4'; mime = plan.mime || 'video/mp4'; }
        st.phase = 'starting';
        await onDevice(x => avt.load(x, { url, title: st.title, mime }));
        log('cast: 投到', d.name, plan.kind, st.title);
        // 等电视开始播：从头播的直接算好；要从中间接着播的，开始播了再跳过去（有的接收端没播起来时不认跳转）
        const t0 = Date.now();
        while (my === gen && Date.now() - t0 < 45000) {
          await new Promise(r => setTimeout(r, 1500));
          const s = await onDevice(x => avt.state(x)).catch(() => null);
          if (s?.state === 'PLAYING' && st.hits) {   // 还没来取过视频的 PLAYING 是上一个片子的状态
            if (st.start > 5) await onDevice(x => avt.seek(x, st.start)).catch(e => log('cast: 跳转失败', e.message));
            if (my === gen) st.phase = 'playing';
            if (LAST) try { fs.writeFileSync(LAST, JSON.stringify({ id: d.id, name: d.name })); } catch {}
            return;
          }
          if (Date.now() - t0 > 20000 && !st.hits) throw new Error('电视没来取视频：电脑的防火墙可能挡住了局域网访问（Windows 要允许 Node.js 在专用网络上通信）');
        }
        if (my === gen && st.phase === 'starting') st.phase = 'playing';   // 状态一直不报 PLAYING 的接收端：当作在播
      } catch (e) {
        if (my !== gen) return;
        st.phase = 'error'; st.error = e.message; log('cast: 失败', e.message);
        session = null; closeServer();
      }
    })();
    return status();
  }

  async function ctl(action, t) {
    if (!st.device || !['pause', 'play', 'stop', 'seek'].includes(action)) throw new Error('没有在投屏');
    if (action === 'seek') await onDevice(x => avt.seek(x, Math.max(0, +t || 0)));
    else await onDevice(x => avt[action](x));
    if (action === 'stop') end();
    return status();
  }
  function end() { gen++; session = null; closeServer(); Object.assign(st, { phase: '', device: null, id: '' }); }

  let polled = { at: 0, v: null };
  async function status() {
    const out = { ok: true, active: !!st.device, id: st.id, phase: st.phase, error: st.error, title: st.title, page: st.page, kind: st.kind, device: st.device, hits: st.hits };
    if (st.device && (st.phase === 'playing' || st.phase === 'starting' && st.hits)) {
      if (Date.now() - polled.at > 1000) polled = { at: Date.now(), v: await onDevice(x => avt.state(x)).catch(e => ({ state: 'UNKNOWN', err: e.message })) };
      Object.assign(out, { state: polled.v.state, pos: polled.v.pos || 0, dur: polled.v.dur || 0 });
      // 电视那边换了别的东西播（用户用遥控器退出、或别的手机投了）：算结束
      if (polled.v.uri && serverAddr && !polled.v.uri.includes(serverAddr) && st.phase === 'playing') { end(); out.active = false; out.phase = ''; out.ended = '电视已经在播别的了'; }
    }
    return out;
  }

  // 3 小时电视没来取：关掉转发服务
  setInterval(() => { if (session && Date.now() - session.lastHit > IDLE) { log('cast: 很久没在播，关掉转发服务'); end(); } }, 60000).unref();

  return { devices, play, ctl, status, stop: () => ctl('stop') };
}
