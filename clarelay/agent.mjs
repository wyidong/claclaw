// clarelay 设备组网 · 电脑端：加入设备圈、保持和中继的连接、在本机解开 HTTPS、门卫检查，再转给本机应用（如 claclaw）。
//
//   import { startDevice } from 'clarelay/device';
//   const dev = await startDevice({ invite, state, name, services: { claclaw: 'http://127.0.0.1:8787' } });
//
// 命令行：node device/agent.mjs <设备邀请码> --name 办公室Mac --to http://127.0.0.1:8787 [--state 文件]
//   测试用：--acme devca --ca 测试CA.pem --connect 127.0.0.1:端口
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import tls from 'node:tls';
import zlib from 'node:zlib';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import { DEVICE_VERSION, prefixed, serveTls, realIp, parseDeviceInvite, verifyTicket, lineChannel, limiter, rand, b64u } from './common.mjs';
import { newKey, keyPem, loadKey, certificate, csr, expiresIn } from './x509.mjs';
import { acmeIssue, LETSENCRYPT, LETSENCRYPT_STAGING } from './acme.mjs';
import { rtcHost, rtcLib } from './rtc.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'proxy-authenticate']);
const GATE = '__Host-clarelay-gate';

/**
 * @param {object} o
 * @param {string} [o.invite]   设备邀请码（第一次加入时需要；之后从 state 读）
 * @param {string} [o.state]    状态文件（默认 ~/.clarelay-device.json）：设备身份、证书都在里面，权限 600
 * @param {string} [o.name]     在设备列表里显示的名字
 * @param {Record<string,string>} o.services  开放的应用 { claclaw: 'http://127.0.0.1:8787' }（v1 只用第一个）
 * @param {'letsencrypt'|'staging'|'devca'} [o.acme]  证书来源（默认 letsencrypt；devca 只用于测试）
 * @param {string} [o.ca]       额外信任的 CA（PEM，测试用）
 * @param {{host:string,port:number}} [o.connect]  连中继时实际连的地址（测试用；默认就是圈子域名）
 * @param {Record<string,string>} [o.open]  不过门卫的路径前缀 → 本机地址，例如 { '/claclaw-peer': 'http://127.0.0.1:8788' }（协同：钥匙由应用自己验；按来源 IP 限速）
 * @param {number} [o.openRate]  开放路径每个来源 IP 每分钟最多几个请求（默认 60）
 * @param {(s:object)=>void} [o.onStatus]
 * @param {(...a)=>void} [o.log]
 */
export async function startDevice(o = {}) {
  const log = o.log || (() => {});
  const STATE = o.state || path.join(os.homedir(), '.clarelay-device.json');
  let st = {}; try { st = JSON.parse(fs.readFileSync(STATE, 'utf8')); } catch {}
  const saveState = () => { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE + '.tmp', JSON.stringify(st, null, 1), { mode: 0o600 }); fs.renameSync(STATE + '.tmp', STATE); };
  const services = o.services || {};
  const target = Object.values(services)[0];
  if (!target || !/^https?:\/\//.test(target)) throw new Error('services 里要有一个本机应用地址，例如 { claclaw: "http://127.0.0.1:8787" }');
  const caOpt = o.ca ? { ca: [...tls.rootCertificates, o.ca] } : {};

  // ---------- 加入 ----------
  if (o.invite) {
    const inv = parseDeviceInvite(o.invite);
    if (!st.id || st.domain !== inv.domain || st.revoked) {
      const r = await req(inv.domain, inv.port, 'POST', '/_device/join', { code: inv.code, name: o.name || os.hostname() }, {});
      if (r.status !== 200) throw new Error('加入设备圈失败：' + (r.j?.error || 'HTTP ' + r.status));
      st = { domain: r.j.domain, port: r.j.port, id: r.j.id, token: r.j.token, label: r.j.label, gatePub: r.j.gatePub, shell: r.j.shell, status: r.j.status, name: o.name || os.hostname(),
        gateSecret: rand(32), acmeAccount: keyPem(newKey()) };
      saveState();
      log('已加入设备圈：' + st.domain + '（' + (st.status === 'pending' ? '等管理员批准' : '已生效') + '）');
    }
  }
  if (!st.id) throw new Error('还没加入设备圈：需要设备邀请码');
  if (!st.gateSecret) { st.gateSecret = rand(32); saveState(); }
  const portSuffix = st.port && st.port !== 443 ? ':' + st.port : '';
  const URL_SELF = 'https://' + st.label + '.' + st.domain + portSuffix, SHELL = 'https://' + st.domain + portSuffix, HOST_SELF = st.label + '.' + st.domain;

  function req(domain, port, method, p, body, extra) {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    return new Promise((ok, bad) => {
      const r = https.request({ host: o.connect?.host || domain, port: o.connect?.port || port, servername: domain, method, path: p, timeout: 20e3, ...caOpt,
        headers: { host: domain + (port === 443 ? '' : ':' + port), ...(data ? { 'content-type': 'application/json', 'content-length': data.length } : {}), ...extra } }, res => {
        const c = []; res.on('data', d => c.push(d)); res.on('end', () => { let j = null; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch {} ok({ status: res.statusCode, j }); });
      });
      r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', bad); r.end(data || undefined);
    });
  }
  const authHeaders = () => ({ authorization: 'Bearer ' + st.token, 'x-device-id': st.id });

  // ---------- 本机 HTTPS（证书在本机，中继看不到内容） ----------
  const cert = () => (st.cert && st.certKey && expiresIn(st.cert) > 0) ? { cert: st.cert, key: st.certKey } : (() => { const k = newKey(); return { cert: certificate({ key: k, hosts: [HOST_SELF], days: 7 }), key: keyPem(k) }; })();
  let localCtx = tls.createSecureContext({ ...cert(), minVersion: 'TLSv1.2' });
  const local = http.createServer((q, s) => onRequest(q, s));   // TLS 在 serveTls() 里做（证书在本机）
  local.on('upgrade', (q, sock, head) => onUpgrade(q, sock, head));
  local.headersTimeout = 60e3; local.requestTimeout = 0; local.keepAliveTimeout = 65e3;

  // ---------- 门卫 ----------
  // 放行条件（任一）：本网址的门卫 cookie（由一次性通行票换来，绑定圈子登录 sid）。
  // 没有门卫 cookie：若带着中继签发的「已授权设备」凭证（Domain=圈子域名 的 cookie）→ 送去外壳换通行票；否则一律 404。
  // 独立主屏幕 App（iOS 的 cookie 和 Safari 分开）：页面里的 manifest 链接改写成带一次性凭证的地址，start_url 指向 /_clarelay/start 换门卫 cookie。
  let sids = new Set(), enrolls = new Set(), snippetChars = 20, push = null, stun = null;   // stun：中继给的 STUN 地址（stun:域名:端口），老中继没有 = null   // push：中继推送总开关（null = 老中继没说）
  const usedTickets = new Map();
  st.usedStarts ||= {};
  const hmac = s => crypto.createHmac('sha256', st.gateSecret).update(s).digest('base64url');
  const seal = obj => { const p = b64u(JSON.stringify(obj)); return p + '.' + hmac(p); };
  const unseal = v => { const [p, sig] = String(v || '').split('.'); if (!p || !sig || hmac(p) !== sig) return null; try { return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')); } catch { return null; } };
  const GATE_AGE = 400 * 86400;
  const gateCookie = sid => seal({ sid, exp: Date.now() + GATE_AGE * 1000 });
  const setGate = sid => `${GATE}=${gateCookie(sid)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${GATE_AGE}`;
  const cookieOf = (req, name) => { const m = String(req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name.replace(/[-]/g, '\\-') + '=([A-Za-z0-9_.-]+)')); return m ? m[1] : null; };
  function gateSid(req) { const j = unseal(cookieOf(req, GATE)); return j && j.exp > Date.now() && sids.has(j.sid) ? j.sid : null; }
  const gateOk = req => !!gateSid(req);
  function enrolledProof(req) {   // 中继签的「已授权设备」凭证
    const t = verifyTicket(st.gatePub, cookieOf(req, '__Secure-clarelay-proof'));
    return !!(t && t.k === 'proof' && t.exp > Date.now() && enrolls.has(t.e));
  }
  const clientIp = req => realIp(req.socket);
  const frameHeaders = { 'content-security-policy': `frame-ancestors 'self' ${SHELL}` };
  const notFound = res => { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...frameHeaders }); res.end('Not Found'); };
  const safeBack = b => /^\/(?!\/)/.test(String(b || '')) ? String(b) : '/';
  // ---------- 手机直连（WebRTC，见 rtc.mjs）----------
  const rtc = rtcHost({ target, host: HOST_SELF, alive: sid => sids.has(sid), log });
  const rtcTries = new Map();   // sid → 最近一分钟的牵线次数
  function rtcRoutes(req, res, u) {
    const sid = gateSid(req);
    if (u.pathname === '/_clarelay/rtc' && req.method === 'POST') {
      const n = (rtcTries.get(sid) || []).filter(t => t > Date.now() - 60e3); n.push(Date.now()); rtcTries.set(sid, n);
      if (n.length > 10) { if (n.length === 11) log('直连牵线太频繁（1 分钟超过 10 次），先拒绝'); return sendJson(res, 429, { error: '太频繁' }); }
      const c = []; let size = 0;
      req.on('data', d => { size += d.length; if (size > 64 * 1024) req.destroy(); else c.push(d); });
      req.on('end', async () => {
        let j; try { j = JSON.parse(Buffer.concat(c).toString('utf8')); } catch { return sendJson(res, 400, { error: 'bad json' }); }
        const cookie = String(req.headers.cookie || '').split(/;\s*/).filter(x => x && !x.startsWith(GATE + '=')).join('; ');
        try { sendJson(res, 200, { v: 3, sdp: await rtc.answer({ sdp: j.sdp, sid, cookie, ip: clientIp(req), prev: j.prev }) }); }   // v2：上传会回 ack；v3：每个请求先回 got
        catch (e) { sendJson(res, e.status || 500, { error: e.message }); }
      });
      return true;
    }
    if (u.pathname === '/_clarelay/rtc.js') {
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', ...frameHeaders });
      res.end(fs.readFileSync(path.join(HERE, 'rtc-client.js')));
      return true;
    }
    if (u.pathname === '/_clarelay/sw.js') {   // 宿主页面的 Service Worker 用 importScripts 引入
      res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', ...frameHeaders });
      res.end(fs.readFileSync(path.join(HERE, 'rtc-sw.js')));
      return true;
    }
    if (u.pathname === '/_clarelay/rtc-test') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...frameHeaders });
      res.end(fs.readFileSync(path.join(HERE, 'rtc-test.html')));
      return true;
    }
    if (u.pathname === '/_clarelay/cookie') {   // 直连上应用设的 cookie，经这条路领回浏览器
      const list = rtc.takeSync(String(u.searchParams.get('k') || ''), sid);
      if (!list) { notFound(res); return true; }
      res.writeHead(204, { 'set-cookie': list, 'cache-control': 'no-store' }); res.end();
      return true;
    }
    return false;
  }
  // 中继签的通行票按中继时间核对：hello 里带了中继时间就按差值换算（再宽限 30 秒），老中继没带就宽限 2 分钟。本机时钟不准（Windows 校时服务没开）也能进
  let skew = null;
  const relayNow = () => skew === null ? Date.now() - 120e3 : Date.now() + skew - 30e3;
  let gateLogs = [];   // 门卫拦下的请求：每分钟最多记 5 条，排查「Not Found」用
  const gateLog = m => { const now = Date.now(); gateLogs = gateLogs.filter(x => now - x < 60e3); if (gateLogs.length >= 5) return; gateLogs.push(now); log('门卫：' + m); };
  const sendJson = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...frameHeaders }); res.end(JSON.stringify(obj)); };
  // ---------- 开放路径（不过门卫）----------
  // 只认整段前缀（/claclaw-peer 或 /claclaw-peer/…）；路径先按 URL 规范化（.. 和 %2e%2e 都折掉）再匹配、再转发，绕不到别的路径
  let OPEN = [];
  const setOpen = m => { OPEN = Object.entries(m || {}).filter(([p, t]) => /^\/[A-Za-z0-9._~-]+$/.test(p) && /^https?:\/\/[^/]+\/?$/.test(String(t))).map(([p, t]) => [p, String(t)]); };
  setOpen(o.open);
  const openLimit = limiter(Number(o.openRate) || 60, 60e3);
  const openRoute = u => { for (const [p, t] of OPEN) if (u.pathname === p || u.pathname.startsWith(p + '/')) return t; return null; };
  function proxyOpen(req, res, to, u) {
    if (openLimit(clientIp(req))) { res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '60' }); return res.end('Too Many Requests'); }
    const t = new URL(to), mod = t.protocol === 'https:' ? https : http;
    const h = fwdHeaders(req); delete h.cookie;   // 本网址的 cookie（门卫、应用登录）一概不给开放路径
    const up = mod.request({ host: t.hostname, port: t.port, method: req.method, path: u.pathname + u.search, headers: h, setHost: false, timeout: 60e3 }, r => {
      const rh = { ...r.headers }; delete rh['set-cookie']; for (const k of Object.keys(rh)) if (HOP.has(k)) delete rh[k];
      res.writeHead(r.statusCode, rh); r.pipe(res);
    });
    up.on('timeout', () => up.destroy(new Error('timeout')));
    up.on('error', e => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' }); res.end('本机服务连不上：' + e.message); } else res.destroy(); });
    req.pipe(up);
  }
  function onRequest(req, res) {
    const u = new URL(req.url, URL_SELF);
    const openTo = openRoute(u); if (openTo) return proxyOpen(req, res, openTo, u);
    if (u.pathname === '/_clarelay/auth') {
      const t = verifyTicket(st.gatePub, u.searchParams.get('ticket'));
      const bad = !t ? '验签失败' : t.aud !== st.label ? '不是给本机的' : t.exp < relayNow() ? '过期 ' + Math.round((Date.now() - t.exp) / 1000) + ' 秒（看两边时钟）' : usedTickets.has(t.n) ? '用过了' : !sids.has(t.sid) ? '登录会话不在名单（共 ' + sids.size + ' 个）' : '';
      if (bad) { gateLog('通行票无效：' + bad); return notFound(res); }
      usedTickets.set(t.n, t.exp - relayNow() + Date.now() + 120e3);   // 换算成本机时间再多留 2 分钟，过期前一直记着防重放 for (const [n, e] of usedTickets) if (e < Date.now()) usedTickets.delete(n);
      res.writeHead(302, { location: safeBack(u.searchParams.get('back')), 'set-cookie': setGate(t.sid), 'cache-control': 'no-store', ...frameHeaders });
      return res.end();
    }
    if (u.pathname === '/_clarelay/start') {          // 独立主屏幕 App 第一次打开
      const j = unseal(u.searchParams.get('t'));
      if (!j || j.k !== 'start' || j.exp < Date.now() || st.usedStarts[j.n] || !sids.has(j.sid)) {
        if (gateOk(req)) { res.writeHead(302, { location: safeBack(u.searchParams.get('back')) }); return res.end(); }
        return notFound(res);
      }
      st.usedStarts[j.n] = j.exp; for (const [n, e] of Object.entries(st.usedStarts)) if (e < Date.now()) delete st.usedStarts[n]; saveState();
      res.writeHead(302, { location: safeBack(u.searchParams.get('back')), 'set-cookie': setGate(j.sid), 'cache-control': 'no-store' });
      return res.end();
    }
    if (u.pathname === '/_clarelay/manifest') {       // 浏览器取 manifest 可能不带 cookie：凭链接里的凭证
      const j = unseal(u.searchParams.get('m'));
      if (!j || j.k !== 'manifest' || j.exp < Date.now() || !sids.has(j.sid)) return notFound(res);
      return serveManifest(req, res, j.sid, safeBack(u.searchParams.get('src')));
    }
    if (!gateOk(req)) {
      if (req.method === 'GET' && /text\/html/.test(req.headers.accept || '') && enrolledProof(req)) {   // 已授权的设备直接打开本网址：去外壳换通行票
        res.writeHead(302, { location: SHELL + '/_auth?host=' + st.label + '&back=' + encodeURIComponent(req.url), 'cache-control': 'no-store' }); return res.end();
      }
      gateLog('拦下 ' + req.method + ' ' + u.pathname + (cookieOf(req, GATE) ? '（门卫 cookie 无效）' : '（没有门卫 cookie）'));
      return notFound(res);   // 其他人：什么都不给
    }
    if (u.pathname.startsWith('/_clarelay/rtc') || u.pathname === '/_clarelay/cookie' || u.pathname === '/_clarelay/sw.js') { if (rtcRoutes(req, res, u)) return; }
    proxy(req, res);
  }
  function serveManifest(req, res, sid, src) {
    const t = new URL(target), mod = t.protocol === 'https:' ? https : http;
    const h = fwdHeaders(req); h['accept-encoding'] = 'identity'; delete h.cookie;
    const up = mod.request({ host: t.hostname, port: t.port, method: 'GET', path: src, headers: h, setHost: false }, r => {
      const c = []; r.on('data', d => c.push(d));
      r.on('end', () => {
        let m; try { m = JSON.parse(Buffer.concat(c).toString('utf8')); } catch { return notFound(res); }
        const tok = seal({ k: 'start', sid, exp: Date.now() + 30 * 864e5, n: rand(12) });
        m.start_url = '/_clarelay/start?t=' + tok + '&back=' + encodeURIComponent(safeBack(m.start_url || '/'));
        m.scope ||= '/';
        if (!m.id) m.id = '/';
        res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(m));
      });
    });
    up.on('error', () => notFound(res)); up.end();
  }
  function fwdHeaders(req) {
    const h = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && !/^x-forwarded-/.test(k) && k !== 'forwarded' && k !== 'x-real-ip') h[k] = v;
    if (h.cookie) { h.cookie = h.cookie.split(/;\s*/).filter(c => !c.startsWith(GATE + '=')).join('; '); if (!h.cookie) delete h.cookie; }
    h['x-forwarded-for'] = clientIp(req); h['x-forwarded-proto'] = 'https'; h['x-forwarded-host'] = req.headers.host || HOST_SELF;
    return h;   // Host 原样保留
  }
  function proxy(req, res) {
    const t = new URL(target), mod = t.protocol === 'https:' ? https : http;
    const page = req.method === 'GET' && /text\/html/.test(req.headers.accept || '');   // 页面：要改写 manifest 链接，向应用要不压缩的
    const h0 = fwdHeaders(req); if (page) h0['accept-encoding'] = 'identity';
    const up = mod.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: h0, setHost: false }, r => {
      const h = { ...r.headers }; delete h['x-frame-options'];
      for (const k of Object.keys(h)) if (HOP.has(k)) delete h[k];
      if (!h['content-security-policy']?.includes('frame-ancestors')) Object.assign(h, frameHeaders);
      if (page && /text\/html/.test(h['content-type'] || '') && !h['content-encoding']) {
        const c = []; let n = 0;
        r.on('data', d => { n += d.length; c.push(d); });
        r.on('end', () => {
          let html = Buffer.concat(c).toString('utf8');
          const sid = gateSid(req);
          if (sid && n < 4 * 1024 * 1024) html = html.replace(/(<link\b[^>]*\brel=["']?manifest["']?[^>]*\bhref=["'])([^"']+)(["'])/i, (all, a, href, b) => {
            const src = href.startsWith('/') ? href : '/' + href.replace(/^\.\//, '');
            return a + '/_clarelay/manifest?m=' + seal({ k: 'manifest', sid, exp: Date.now() + 7 * 864e5 }) + '&amp;src=' + encodeURIComponent(src) + b;
          });
          delete h['content-length']; delete h['etag'];
          // 页面要不压缩地拿来改写，改完按浏览器原来的 accept-encoding 再压缩（claclaw 页面约 470KB → 约 140KB）
          let out = Buffer.from(html, 'utf8');
          const ae = String(req.headers['accept-encoding'] || ''), ok = n => new RegExp('(^|,)\\s*' + n + '\\s*(,|;(?!\\s*q=0(\\.0*)?\\s*(,|$))|$)', 'i').test(ae);
          if (out.length > 1024 && ok('br')) { out = zlib.brotliCompressSync(out, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: out.length } }); h['content-encoding'] = 'br'; }
          else if (out.length > 1024 && ok('gzip')) { out = zlib.gzipSync(out, { level: 6 }); h['content-encoding'] = 'gzip'; }
          h.vary = [h.vary, 'accept-encoding'].filter(Boolean).join(', ');
          h['content-length'] = out.length;
          res.writeHead(r.statusCode, h); res.end(out);
        });
        return;
      }
      res.writeHead(r.statusCode, h); r.pipe(res);
    });
    up.on('error', e => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8', ...frameHeaders }); res.end('本机应用连不上：' + e.message); } else res.destroy(); });
    req.pipe(up);
  }
  function onUpgrade(req, sock, head) {
    sock.on('error', () => {});
    if (!gateOk(req)) { sock.end('HTTP/1.1 404 Not Found\r\nconnection: close\r\n\r\n'); return; }
    const t = new URL(target), mod = t.protocol === 'https:' ? https : http;
    const h = fwdHeaders(req); h.connection = 'Upgrade'; h.upgrade = req.headers.upgrade;
    const up = mod.request({ host: t.hostname, port: t.port, method: req.method, path: req.url, headers: h, setHost: false });
    up.on('upgrade', (r, us, uhead) => {
      let out = `HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\n`;
      for (let i = 0; i < r.rawHeaders.length; i += 2) out += r.rawHeaders[i] + ': ' + r.rawHeaders[i + 1] + '\r\n';
      sock.write(out + '\r\n'); if (uhead?.length) sock.write(uhead); if (head?.length) us.write(head);
      us.pipe(sock); sock.pipe(us);
      const kill = () => { us.destroy(); sock.destroy(); }; us.on('error', kill); us.on('close', kill); sock.on('close', kill);
    });
    up.on('response', r => { sock.end(`HTTP/1.1 ${r.statusCode} ${r.statusMessage}\r\nconnection: close\r\n\r\n`); });
    up.on('error', () => sock.destroy());
    up.end();
  }

  // ---------- 控制连接 ----------
  const ev = new EventEmitter();
  let stopped = false, ctrl = null, sendCtrl = null, online = false, status = st.status || 'pending', backoff = 5000, certState = { ok: !!(st.cert && expiresIn(st.cert) > 0), expires: st.cert ? Date.now() + expiresIn(st.cert) : 0 };
  const acmeTokens = new Map();
  const pendingEvents = new Map();   // 掉线期间的提醒：每个对象只留最后一条
  const emitStatus = (extra = {}) => { const s = { online, status, url: URL_SELF, cert: certState, ...extra }; o.onStatus?.(s); ev.emit('status', s); };
  const upgradeReq = (p) => new Promise((ok, bad) => {
    const r = https.request({ host: o.connect?.host || st.domain, port: o.connect?.port || st.port, servername: st.domain, path: p, ...caOpt,
      headers: { host: st.domain + portSuffix, connection: 'Upgrade', upgrade: 'clarelay', ...authHeaders() }, timeout: 20e3 });
    r.on('upgrade', (res, sock, head) => { r.setTimeout(0); if (head?.length) sock.unshift(head); ok(sock); });
    r.on('response', res => { res.resume(); bad(Object.assign(new Error(res.statusCode === 401 ? '设备已被撤销或凭证无效' : 'HTTP ' + res.statusCode), { status: res.statusCode })); });
    r.on('timeout', () => r.destroy(new Error('timeout'))); r.on('error', bad); r.end();
  });
  // 数据连接收到第一行 PROXY 头后，就在本机解开 HTTPS
  function serveData(sock, onUsed) {
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    const onData = d => {
      buf = Buffer.concat([buf, d]);
      const i = buf.indexOf('\r\n'); if (i < 0) { if (buf.length > 200) sock.destroy(); return; }
      sock.removeListener('data', onData); sock.pause();
      onUsed?.();
      const line = buf.subarray(0, i).toString('latin1').split(' ');   // PROXY TCP4 ip 0.0.0.0 port 443
      serveTls(local, prefixed(sock, buf.subarray(i + 2)), () => localCtx, line[0] === 'PROXY' ? line[2] : '');
    };
    sock.on('data', onData); sock.on('error', () => {});
  }
  function openData(id) {
    upgradeReq('/_device/accept?id=' + encodeURIComponent(id)).then(sock => serveData(sock)).catch(e => log('数据连接失败：' + e.message));
  }
  // 预先连好几条空闲数据连接放在中继上：手机来访问时直接用，首次打开快很多（中继远的时候每条新连接要多花约 1 秒）
  const POOL = o.pool ?? 4;
  let pooled = 0;
  function fillPool() {
    if (stopped || status !== 'active' || !online) return;
    while (pooled < POOL) {
      pooled++;
      upgradeReq('/_device/accept?pool=1').then(sock => {
        let used = false;
        sock.on('close', () => { if (!used) { pooled--; setTimeout(fillPool, 3000); } });
        serveData(sock, () => { used = true; pooled--; fillPool(); });
      }).catch(() => { pooled--; setTimeout(fillPool, 5000); });
    }
  }
  async function connect() {
    while (!stopped) {
      try {
        const sock = await upgradeReq('/_device/control');
        ctrl = sock; sock.setKeepAlive(true, 30e3);
        sendCtrl = lineChannel(sock, onCtrl);
        sendCtrl({ t: 'services', services: Object.keys(services), version: DEVICE_VERSION });
        for (const m of pendingEvents.values()) sendCtrl(m); pendingEvents.clear();
        backoff = 5000;
        const ping = setInterval(() => sendCtrl?.({ t: 'ping' }), 30e3);
        await new Promise(r => { sock.on('close', r); sock.on('error', () => {}); });
        clearInterval(ping); ctrl = null; sendCtrl = null;
        if (online) { online = false; emitStatus({ error: '和中继断开，重连中' }); log('和中继断开，重连中'); }
      } catch (e) {
        if (e.status === 401) { status = 'revoked'; st.revoked = true; saveState(); emitStatus({ error: e.message }); log(e.message); return; }
        online = false; emitStatus({ error: e.message, retryIn: backoff });   // 每次连不上都报（从没连上过也报），界面直接显示原因
        log('连不上中继：' + e.message + '，' + backoff / 1000 + ' 秒后重试');
      }
      if (stopped) return;
      await new Promise(r => setTimeout(r, backoff)); backoff = Math.min(backoff * 2, 60e3);
    }
  }
  function onCtrl(m) {
    if (m.t === 'hello') {
      status = m.status; sids = new Set(m.sids || []); enrolls = new Set(m.enrolls || []); rtc.revoke(); snippetChars = m.snippetChars ?? 20; push = typeof m.push === 'boolean' ? m.push : null;
      if (m.name && m.name !== st.name) st.name = m.name;
      if (typeof m.now === 'number') { skew = m.now - Date.now(); if (Math.abs(skew) > 30e3) log('本机时钟和中继差 ' + Math.round(-skew / 1000) + ' 秒（正数 = 本机快），已自动按中继时间核对通行票；建议开启系统自动校时'); }
      if (m.gatePub && m.gatePub !== st.gatePub) st.gatePub = m.gatePub;
      stun = typeof m.stun === 'string' ? m.stun : null;
      st.status = status; saveState();
      online = true; emitStatus(); log('已连上中继（' + (status === 'active' ? '已生效' : '等管理员批准') + '）：' + URL_SELF);
      if (status === 'active') { ensureCert(); fillPool(); }
    } else if (m.t === 'open') openData(m.id);
    else if (m.t === 'pool-used') fillPool();
    else if (m.t === 'sessions') { sids = new Set(m.sids || []); if (m.enrolls) enrolls = new Set(m.enrolls); rtc.revoke(); }
    else if (m.t === 'settings') { snippetChars = m.snippetChars ?? snippetChars; if (typeof m.push === 'boolean') push = m.push; }
    else if (m.t === 'status') { status = m.status; st.status = status; if (m.name) st.name = m.name; saveState(); emitStatus(); if (status === 'active') { ensureCert(); fillPool(); } }
    else if (m.t === 'acme') sendCtrl?.({ t: 'acme', id: m.id, keyAuth: acmeTokens.get(m.token) || '' });
    else if (m.t === 'revoked') { status = 'revoked'; st.revoked = true; saveState(); emitStatus(); stopped = true; }
  }

  // ---------- 证书 ----------
  let certBusy = false;
  async function ensureCert() {
    if (certBusy || status !== 'active') return;
    const mode0 = o.acme || 'letsencrypt';
    let issuer = ''; try { issuer = new crypto.X509Certificate(st.cert).issuer; } catch {}
    const wrong = mode0 === 'letsencrypt' && /STAGING|Fake/i.test(issuer);
    if (st.cert && !wrong && expiresIn(st.cert) > Math.max(10 * 864e5, (st.certLife || 90 * 864e5) / 3)) return;
    certBusy = true;
    try {
      const mode = o.acme || 'letsencrypt';
      let out;
      if (mode === 'devca') {
        const k = newKey(), r = await req(st.domain, st.port, 'POST', '/_device/devcert', { csr: b64u(csr(k, [HOST_SELF])) }, authHeaders());
        if (r.status !== 200) throw new Error(r.j?.error || 'HTTP ' + r.status);
        out = { cert: r.j.cert, key: keyPem(k) };
      } else {
        out = await acmeIssue({ directory: mode === 'staging' ? LETSENCRYPT_STAGING : LETSENCRYPT, accountKey: loadKey(st.acmeAccount), hosts: [HOST_SELF], email: o.email,
          respond: async (t, ka) => { acmeTokens.set(t, ka); }, cleanup: t => acmeTokens.delete(t), log });
      }
      st.cert = out.cert; st.certKey = out.key; st.certLife = expiresIn(out.cert); saveState();
      localCtx = tls.createSecureContext({ cert: st.cert, key: st.certKey, minVersion: 'TLSv1.2' });
      certState = { ok: true, expires: Date.now() + expiresIn(st.cert) }; emitStatus(); log('证书已就绪：' + HOST_SELF);
    } catch (e) { certState = { ...certState, ok: certState.ok, error: e.message }; emitStatus({ error: '证书申请失败：' + e.message }); log('证书申请失败：' + e.message); }
    finally { certBusy = false; }
  }
  const certTimer = setInterval(ensureCert, 6 * 3600e3); certTimer.unref?.();

  const loop = connect();
  rtcLib().then(l => log(l ? '手机直连：可用' : '手机直连：没装 node-datachannel，只走中继'));

  // ---------- 提醒 ----------
  const clip = t => { const c = [...String(t || '')]; return c.length > snippetChars && snippetChars > 0 ? c.slice(0, snippetChars).join('') + '……' : c.slice(0, snippetChars).join(''); };
  function sendEvent(m) {
    const key = m.app + '\t' + m.target;
    if (sendCtrl && online) sendCtrl(m); else { pendingEvents.delete(key); pendingEvents.set(key, m); }
  }
  Object.defineProperties(ev, {
    url: { get: () => URL_SELF }, shellUrl: { get: () => SHELL }, online: { get: () => online }, push: { get: () => push }, status: { get: () => status }, cert: { get: () => certState },
    id: { get: () => st.id }, name: { get: () => st.name }, rtcPeers: { get: () => rtc.count }, stun: { get: () => stun },
  });
  return Object.assign(ev, {
    setOpen,   // 运行中改开放路径（比如协同端口改了）
    // 问中继：我的公网 IP 是多少；再请中继回连「公网 IP:端口 + path」，只报通不通（中继只回连本设备自己的公网 IP）
    // probe({ port | ports:[…], path: '/claclaw-peer/ping', tls: false }) → { ip4, ip6, reach: { 'ip:端口': true/false }, status: { 'ip:端口': HTTP 状态码 | 错误 } }
    async probe(q = {}) {
      const r = await req(st.domain, st.port, 'POST', '/_device/probe', { ports: q.ports || (q.port ? [q.port] : []), path: q.path || '/', tls: !!q.tls }, authHeaders());
      if (r.status !== 200) throw new Error('探测失败：' + (r.j?.error || 'HTTP ' + r.status));
      return r.j;
    },
    notify(e) {
      const snippet = clip(e.snippet);   // 只把前 N 个字交给中继，被截断的补「……」
      sendEvent({ t: 'notify', app: String(e.app), target: String(e.target), kind: e.kind || '', title: String(e.title || ''), snippet, unread: Number(e.unread) || 0 });
    },
    read(e) { sendEvent({ t: 'read', app: String(e.app), target: String(e.target) }); },
    // 全量同步某个应用的未读（启动时用）：中继里这个应用的未读整体换成这份，不发推送
    sync(e) {
      const items = (Array.isArray(e.items) ? e.items : []).slice(0, 500).map(x => ({ target: String(x.target), kind: x.kind || '', title: String(x.title || ''), snippet: clip(x.snippet), unread: Number(x.unread) || 0 })).filter(x => x.unread > 0);
      sendEvent({ t: 'sync', app: String(e.app), target: '*', items });
    },
    async stop() { stopped = true; clearInterval(certTimer); rtc.closeAll(); ctrl?.destroy(); await Promise.race([loop, new Promise(r => setTimeout(r, 1000))]); },
  });
}

// ---------- 安装 / 卸载开机自启 ----------
// node device/agent.mjs install ["<设备邀请码>"] [--name 名字] [--to http://127.0.0.1:8787] [--state 路径]
//   有邀请码且还没加入：先加入设备圈；然后装开机自启（登录后自动运行，退出了 10 秒后自动重起），并马上启动。
//   macOS：~/Library/LaunchAgents/com.clarelay.device.plist（launchd KeepAlive），日志 ~/Library/Logs/clarelay-device.log
//   Windows：「启动」文件夹里放 clarelay-device.vbs（不弹窗、不要管理员权限），日志 %LOCALAPPDATA%\clarelay\device.log
//   程序就从当前这份 agent.mjs 所在目录运行：更新 = git pull 后重启（Windows 结束 node 进程即可，10 秒后自动重起）。
// node device/agent.mjs uninstall：去掉开机自启并停掉正在跑的电脑端（身份文件保留，再 install 不用邀请码）。
const IS_WIN = process.platform === 'win32', IS_MAC = process.platform === 'darwin';
const AGENT = fileURLToPath(import.meta.url);
const STARTUP_VBS = () => path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'clarelay-device.vbs');
const PLIST = () => path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.clarelay.device.plist');
const logFile = () => IS_WIN ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'clarelay', 'device.log') : path.join(os.homedir(), 'Library', 'Logs', 'clarelay-device.log');

async function runningAlready(arg) {
  const lport = Number(arg('local-port') ?? 8792); if (!lport) return false;
  const LF = (arg('state') || path.join(os.homedir(), '.clarelay-device.json')).replace(/\.json$/, '') + '.local.json';
  let lt; try { lt = JSON.parse(fs.readFileSync(LF, 'utf8')).token; } catch { return false; }
  return new Promise(ok => {
    const r = http.get({ host: '127.0.0.1', port: lport, path: '/status', headers: { authorization: 'Bearer ' + lt }, timeout: 1500 }, res => { res.resume(); ok(res.statusCode === 200); });
    r.on('error', () => ok(false)); r.on('timeout', () => { r.destroy(); ok(false); });
  });
}

async function install({ arg, invite, to, ts }) {
  const state = path.resolve(arg('state') || path.join(os.homedir(), '.clarelay-device.json'));
  if (invite) {   // 先加入（已经加入过同一个圈子就跳过）
    const dev = await startDevice({ invite, name: arg('name'), state, services: { [arg('app') || 'claclaw']: to }, log: (...a) => console.log(ts(), ...a) });
    await dev.stop();
  }
  if (!fs.existsSync(state)) throw new Error('还没加入设备圈：install 后面带上设备邀请码（外壳「管理」里生成）');
  const args = [AGENT, '--to', to, '--state', state];
  for (const k of ['app', 'local-port']) if (arg(k)) args.push('--' + k, arg(k));
  const log = logFile(); fs.mkdirSync(path.dirname(log), { recursive: true });
  const { execFileSync, spawn } = await import('node:child_process');
  if (IS_WIN) {
    await uninstall({ quiet: true, arg });
    const q = x => '"' + x + '"';
    const line = 'cmd /c "' + [process.execPath, ...args].map(x => /[\s"]/.test(x) || x.includes('\\') ? q(x) : x).join(' ') + ' >> ' + q(log) + ' 2>&1"';
    const vbs = [
      "' clarelay 电脑端：登录后自动运行，不弹窗；退出了 10 秒后重起。卸载：node " + q(AGENT) + ' uninstall',
      'Set sh = CreateObject("WScript.Shell")',
      'Do',
      '  sh.Run "' + line.replace(/"/g, '""') + '", 0, True',
      '  WScript.Sleep 10000',
      'Loop', ''].join('\r\n');
    fs.mkdirSync(path.dirname(STARTUP_VBS()), { recursive: true });
    fs.writeFileSync(STARTUP_VBS(), Buffer.concat([Buffer.from([0xFF, 0xFE]), Buffer.from(vbs, 'utf16le')]));   // UTF-16 带 BOM：路径里有中文也不乱
    spawn('wscript.exe', [STARTUP_VBS()], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    console.log('已装好开机自启：' + STARTUP_VBS() + '\n日志：' + log + '\n现在已在后台启动，几秒后看日志末尾是否「已连上中继」。');
  } else if (IS_MAC) {
    const x = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.clarelay.device</string>
  <key>ProgramArguments</key><array>${[process.execPath, ...args].map(a => '<string>' + x(a) + '</string>').join('')}</array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${x(log)}</string>
  <key>StandardErrorPath</key><string>${x(log)}</string>
</dict></plist>
`;
    const uid = process.getuid();
    try { execFileSync('launchctl', ['bootout', 'gui/' + uid + '/com.clarelay.device'], { stdio: 'ignore' }); } catch {}
    fs.mkdirSync(path.dirname(PLIST()), { recursive: true }); fs.writeFileSync(PLIST(), plist);
    execFileSync('launchctl', ['bootstrap', 'gui/' + uid, PLIST()]);
    console.log('已装好开机自启：' + PLIST() + '\n日志：' + log + '\n重启：launchctl kickstart -k gui/' + uid + '/com.clarelay.device');
  } else {
    throw new Error('这个系统还不支持自动安装：请用 systemd 等自行配置开机运行 ' + [process.execPath, ...args].join(' '));
  }
}

async function uninstall({ quiet, arg } = {}) {
  const { execFileSync } = await import('node:child_process');
  if (IS_WIN) {
    try { fs.unlinkSync(STARTUP_VBS()); } catch {}
    // 停掉守护脚本和它起的 node（按命令行里的路径认，不碰别的 node 进程）
    // 守护脚本 wscript；node 进程按命令行里含 agent.mjs 认（手动用相对路径起的也算），再加上占着本机接口端口的进程
    const lport = Number(arg?.('local-port') ?? 8792);
    const ps = `$ids = @(Get-CimInstance Win32_Process | Where-Object { ($_.Name -eq 'wscript.exe' -and $_.CommandLine -like '*clarelay-device.vbs*') -or ($_.Name -eq 'node.exe' -and $_.CommandLine -like '*agent.mjs*') } | ForEach-Object { $_.ProcessId })
$ids += @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${lport} -State Listen -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
$ids | Where-Object { $_ -and $_ -ne ${process.pid} } | Sort-Object -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`;
    try { execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', windowsHide: true }); } catch {}
  } else if (IS_MAC) {
    try { execFileSync('launchctl', ['bootout', 'gui/' + process.getuid() + '/com.clarelay.device'], { stdio: 'ignore' }); } catch {}
    try { fs.unlinkSync(PLIST()); } catch {}
  }
  if (!quiet) console.log('已去掉开机自启并停掉电脑端（身份文件保留，再 install 不用邀请码）');
}

// ---------- 命令行 ----------
const isMain = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; } })();
if (isMain) {
  const argv = process.argv.slice(2), arg = k => { const i = argv.indexOf('--' + k); return i >= 0 ? argv[i + 1] : undefined; };
  const invite = argv.find(a => a.includes('clarelay-device1.'));
  const to = arg('to') || 'http://127.0.0.1:8787';
  const ts = () => { const d = new Date(); return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':'); };   // 本地时间
  const cmd = argv[0];
  if (cmd === 'install' || cmd === 'uninstall') {
    try { await (cmd === 'install' ? install : uninstall)({ argv, arg, invite, to, ts }); process.exit(0); }
    catch (e) { console.log(e.message); process.exit(1); }
  }
  // 已经有一个电脑端在跑（开机自启的那个）：不再起第二个，免得两个进程抢同一个身份
  if (await runningAlready(arg)) { console.log(ts(), '本机已经有一个电脑端在运行，这次不启动'); process.exit(0); }
  try {
    const dev = await startDevice({ invite, name: arg('name'), state: arg('state'), services: { [arg('app') || 'claclaw']: to }, acme: arg('acme'),
      ca: arg('ca') ? fs.readFileSync(arg('ca'), 'utf8') : undefined, connect: arg('connect') ? { host: arg('connect').split(':')[0], port: Number(arg('connect').split(':')[1]) } : undefined,
      log: (...a) => console.log(ts(), ...a), onStatus: s => console.log(ts(), '状态：', s.online ? '在线' : '离线', s.status, s.cert?.ok ? '证书正常' : '证书未就绪', s.error || '') });
    console.log('本机网址：' + dev.url + '\n手机打开：' + dev.shellUrl);
    // 本机接口：给不在同一进程的应用（claclaw）发提醒。地址和令牌写在状态文件旁边的 .local.json（600）
    const lport = Number(arg('local-port') ?? 8792);
    if (lport) {
      const LF = (arg('state') || path.join(os.homedir(), '.clarelay-device.json')).replace(/\.json$/, '') + '.local.json';
      let lt = null; try { lt = JSON.parse(fs.readFileSync(LF, 'utf8')).token; } catch {}
      lt ||= crypto.randomBytes(24).toString('base64url');
      const srv = http.createServer((req, res) => {
        const send = (c, o) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
        const h = String(req.headers.authorization || '');
        if (h.length !== 7 + lt.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from('Bearer ' + lt))) return send(401, { error: 'token' });
        if (req.headers.origin) return send(403, { error: 'no browser' });   // 只给本机进程用，不给网页
        const p = req.url.split('?')[0];
        if (req.method === 'GET' && p === '/status') return send(200, { online: dev.online, push: dev.push, status: dev.status, url: dev.url, shellUrl: dev.shellUrl, name: dev.name, id: dev.id });
        if (req.method !== 'POST' || !['/notify', '/read', '/sync'].includes(p)) return send(404, { error: 'no' });
        let b = ''; req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
        req.on('end', () => { let j; try { j = JSON.parse(b || '{}'); } catch { return send(400, { error: 'json' }); } dev[p.slice(1)](j); send(200, { ok: true, online: dev.online }); });
      });
      srv.on('error', e => console.log(ts(), '本机接口没开起来：', e.message));
      srv.listen(lport, '127.0.0.1', () => { fs.writeFileSync(LF, JSON.stringify({ url: 'http://127.0.0.1:' + lport, token: lt }, null, 1), { mode: 0o600 }); fs.chmodSync(LF, 0o600); console.log(ts(), '本机接口：http://127.0.0.1:' + lport + '（令牌在 ' + LF + '）'); });
    }
    process.on('SIGINT', () => dev.stop().then(() => process.exit(0)));
  } catch (e) { console.log(e.message); process.exit(1); }
}

