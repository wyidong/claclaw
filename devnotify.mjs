// 推送交给 clarelay：本机的 clarelay 设备客户端在 127.0.0.1 开了本机接口（地址和令牌在 ~/.clarelay-device.local.json，600），
// claclaw 把「来了新消息 / 已读 / 全量未读」报给它，由中继推到外壳（主屏幕 App）、算角标。
// 设备掉线时客户端会暂存、重连补发；claclaw 照常报，同时按设置决定自己的 Web Push 要不要兜底。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const FILE = process.env.CLACLAW_CLARELAY_LOCAL || path.join(os.homedir(), '.clarelay-device.local.json');
let conf = null, confAt = 0;
let status = { online: false, ok: false };   // ok = 本机接口通；online = 设备连着中继
let log = () => {};
let onOnline = () => {};

function loadConf() {
  try {
    const m = fs.statSync(FILE).mtimeMs;
    if (conf && m === confAt) return conf;
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    conf = j && j.url && j.token ? { url: String(j.url).replace(/\/$/, ''), token: String(j.token) } : null; confAt = m;
  } catch { conf = null; confAt = 0; }
  return conf;
}

async function call(method, route, body) {
  const c = loadConf();
  if (!c) return null;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch(c.url + route, { method, signal: ctl.signal,
      headers: { authorization: 'Bearer ' + c.token, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
    return j;
  } finally { clearTimeout(t); }
}

async function poll() {
  const was = status.online;
  try {
    const j = await call('GET', '/status');
    status = j ? { ok: true, online: !!j.online, status: j.status, name: j.name || '', shellUrl: j.shellUrl || '', url: j.url || '' } : { ok: false, online: false };
  } catch (e) { status = { ok: false, online: false, error: e.message }; }
  if (status.online && !was) { log('clarelay 推送接口在线', status.name || ''); try { await onOnline(); } catch (e) { log('clarelay sync failed', e.message); } }
  else if (was && !status.online) log('clarelay 推送接口离线');
}

export function startDevNotify(opts = {}) {
  log = opts.log || log; onOnline = opts.onOnline || onOnline;
  poll(); setInterval(poll, 30000).unref?.();
}
export const devStatus = () => status;
export const devConfigured = () => !!loadConf();

const fire = (route, body) => { if (!loadConf()) return; call('POST', route, body).then(j => { if (j && typeof j.online === 'boolean') status.online = j.online; })
  .catch(e => log('clarelay', route, 'failed', e.message)); };
export function devNotify({ target, kind, title, snippet, unread }) {
  fire('/notify', { app: 'claclaw', target: String(target), kind, title: String(title || '').slice(0, 120), snippet: String(snippet || ''), unread: unread | 0 });
}
export function devRead(target) { fire('/read', { app: 'claclaw', target: String(target) }); }
export function devSync(items) { return loadConf() ? call('POST', '/sync', { app: 'claclaw', items }) : null; }
