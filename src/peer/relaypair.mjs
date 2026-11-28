// 扫码加入 clarelay（clarelay PROTOCOL.md §8.4）：电脑这边出二维码，用户用手机上的 clarelay 扫码确认，中继把设备邀请码交回来，
// 再走现有的加入流程（relayDev.join）。粘贴邀请码那一套照旧保留。
// - 中继地址（加入前不知道）：安装时记下的（data/install-origin.json 的 relay）→ 以前加入过的（身份文件、记过的发布公钥）
//   → 用户填过一次的（data/clarelay-pair.json）；都没有就让用户填，先用 GET /_device/hello 确认真是 clarelay 再记住
// - 和中继的往来（start / poll / cancel）都在服务端：poll 钥匙只留在本机，网页只拿到二维码、配对码、过期时间
// - 网页每 2 秒来问一次状态；30 秒没人问（关了页面）就取消配对。中继重启过（gone、还没到过期时间）自动重新出码；过期了等用户点「刷新」
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { readJson, writeJsonAtomic } from '../util.mjs';
import { knownRelayBases, deviceName } from './relaydev.mjs';

const qrcode = createRequire(import.meta.url)('qrcode-generator');
const OS = { win32: 'windows', darwin: 'mac' }[process.platform] || 'linux';

// 用户填的中继地址 → https://域名[:端口]（不带路径）；不合法返回 ''
export function normBase(v) {
  let s = String(v || '').trim();
  if (!s) return '';
  if (!/^[a-z]+:\/\//i.test(s)) s = 'https://' + s;
  let u; try { u = new URL(s); } catch { return ''; }
  if (u.protocol !== 'https:' || !/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(u.hostname)) return '';
  return 'https://' + u.hostname.toLowerCase() + (u.port && u.port !== '443' ? ':' + u.port : '');
}

// 二维码：SVG（黑白、带白边），网页直接塞进去
export function qrSvg(text) {
  const qr = qrcode(0, 'M'); qr.addData(text); qr.make();
  const n = qr.getModuleCount(), m = 2, s = n + m * 2;
  let d = '';
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if (qr.isDark(y, x)) d += `M${x + m} ${y + m}h1v1h-1z`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${s} ${s}" shape-rendering="crispEdges"><rect width="${s}" height="${s}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
}

export const fmtCode = c => { c = String(c || '').toUpperCase(); return c.length === 8 ? c.slice(0, 4) + '-' + c.slice(4) : c; };

/**
 * @param {object} o
 * @param {string} o.DATA
 * @param {(invite: string) => Promise<object>} o.join   现有的加入流程（relayDev.join）
 * @param {(...a) => void} o.log
 * @param {typeof fetch} [o.fetch]  测试用
 * @param {number} [o.minInterval]  测试用：问进度的最短间隔（秒），默认 1
 */
export function makeRelayPair(o) {
  const fetchFn = o.fetch || fetch;
  const log = (...a) => o.log('clarelay 扫码', ...a);
  const SAVED = path.join(o.DATA, 'clarelay-pair.json'), ORIGIN = path.join(o.DATA, 'install-origin.json');
  let cur = null;   // { base, code, url, expires, interval, poll, status, account, error, asked, timer }

  // 知道的中继地址，第一个就是要用的
  function bases() {
    const out = [], add = b => { b = normBase(b); if (b && !out.includes(b)) out.push(b); };
    add(readJson(ORIGIN, {}).relay);
    for (const b of knownRelayBases(o.DATA)) add(b);
    add(readJson(SAVED, {}).base);
    return out;
  }

  async function call(base, route, body, method = 'POST') {
    const r = await fetchFn(base + route, {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000),
    });
    let j = null; try { j = await r.json(); } catch {}
    if (r.status === 429) throw new Error('请求太频繁，过几分钟再试');
    if (r.status === 503) throw new Error('中继正忙，过一会儿再试');
    if (!r.ok) throw new Error((j && j.error) || '中继回了 HTTP ' + r.status);
    return j || {};
  }

  // 用户填的地址：先确认它真是 clarelay、支持扫码加入，再记住
  async function check(base) {
    let j;
    try { j = await call(base, '/_device/hello', null, 'GET'); } catch (e) { throw new Error('连不上这个地址（' + (e.cause?.code || e.message) + '）'); }
    if (!j.clarelay) throw new Error('这不是 clarelay 中继');
    if (!j.pair) throw new Error('这个中继还不支持扫码加入，用「粘贴邀请码」');
    return j;
  }

  function stopTimer() { if (cur?.timer) { clearTimeout(cur.timer); cur.timer = null; } }
  const view = () => cur ? { status: cur.status, code: fmtCode(cur.code), url: cur.url, svg: cur.svg, expires: cur.expires, left: Math.max(0, cur.expires - Date.now()), account: cur.account || '', error: cur.error || '', relay: cur.base } : { status: 'idle' };

  async function issue(base) {
    const j = await call(base, '/_device/pair/start', { name: deviceName(), os: OS });
    if (!j.code || !j.poll || !j.url) throw new Error('中继的回复不完整');
    stopTimer();
    cur = { base, code: j.code, url: j.url, svg: qrSvg(j.url), expires: Number(j.expires) || Date.now() + 600e3, interval: Math.max(o.minInterval ?? 1, Number(j.interval) || 2), poll: j.poll, status: 'waiting', asked: Date.now(), timer: null };
    log('出码', base, fmtCode(j.code));
    schedule();
  }

  function schedule() { const c = cur; c.timer = setTimeout(() => tick(c).catch(e => { if (cur === c) { c.error = e.message; schedule(); } }), c.interval * 1000); c.timer.unref?.(); }

  async function tick(c) {
    if (cur !== c || c.status !== 'waiting') return;
    // 到点了（过期 / 网页不看了）也先再问一次中继：手机可能在最后一个轮询间隔里确认了（中继那边已批准、还续了期），
    // 这时直接取消会连已批准的邀请码一起作废，手机显示已添加、电脑却没加入。还在等才取消
    const unwatched = Date.now() - c.asked > 30000, expired = Date.now() > c.expires;
    let j;
    try { j = await call(c.base, '/_device/pair/poll', { poll: c.poll }); }
    catch (e) { if (!unwatched && !expired) throw e; j = { status: 'waiting' }; }
    if (cur !== c) return;
    if (j.status !== 'done' && unwatched) { log('网页不看了，取消配对'); await cancel(); return; }   // 没人看了（网页关了、换页了）：不再占着中继
    if (j.status !== 'done' && expired) { c.status = 'expired'; call(c.base, '/_device/pair/cancel', { poll: c.poll }).catch(() => {}); return; }
    c.error = '';
    if (j.status === 'done' && j.invite) {
      c.status = 'joining'; c.account = String(j.account || '');
      log('手机确认了，加入中', c.account);
      try { await o.join(j.invite); c.status = 'done'; log('已加入'); } catch (e) { c.status = 'error'; c.error = '加入没成功：' + e.message; log('加入没成功', e.message); }
      return;
    }
    if (j.status === 'gone') {
      if (Date.now() < c.expires - 5000) { log('配对没了（中继重启过？），重新出码'); await issue(c.base); }
      else c.status = 'expired';
      return;
    }
    schedule();   // waiting
  }

  async function start(relay) {
    let base = relay ? normBase(relay) : bases()[0];
    if (relay && !base) throw new Error('中继地址不对：填域名就行，比如 relay.example.com');
    if (!base) return { status: 'need-relay' };
    if (relay) { await check(base); writeJsonAtomic(SAVED, { base, at: Date.now() }); log('记下中继地址', base); }
    if (cur?.status === 'waiting') await cancel();
    await issue(base);
    return view();
  }

  function status() { if (cur) cur.asked = Date.now(); return view(); }

  async function cancel() {
    const c = cur; if (!c) return { status: 'idle' };
    stopTimer(); cur = null;
    if (c.status === 'waiting') await call(c.base, '/_device/pair/cancel', { poll: c.poll }).catch(() => {});
    return { status: 'idle' };
  }

  return { bases, start, status, cancel, stop: () => { stopTimer(); } };
}
