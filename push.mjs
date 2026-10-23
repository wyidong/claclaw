// 推送通知（Web Push）：iOS 16.4+ 从主屏幕打开的网页 App 才能收，且必须是 https。
// 推送密钥（VAPID）首次使用时生成，订阅存在 data/push.json；都不进 git。
// 推送内容只写「哪个会话 + 发生了什么」，不放对话内容 —— 它会经过苹果 / 浏览器厂商的推送服务器。
import fs from 'node:fs';
import path from 'node:path';
import webpush from 'web-push';
import { DATA } from './auth.mjs';

const VAPID_FILE = path.join(DATA, 'vapid.json');
const SUBS_FILE = path.join(DATA, 'push.json');

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, obj) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function vapid() {
  let v = readJson(VAPID_FILE, null);
  if (!v?.publicKey) {
    v = webpush.generateVAPIDKeys();
    writeJson(VAPID_FILE, v);
  }
  return v;
}

let configured = false;
function configure() {
  if (configured) return;
  const v = vapid();
  // subject 必须是 mailto: 或 https:，推送服务商出问题时用来联系发送方
  webpush.setVapidDetails('mailto:claclaw@users.noreply.github.com', v.publicKey, v.privateKey);
  configured = true;
}

export const publicKey = () => vapid().publicKey;

export function subscribe(sub, ua) {
  if (!sub || typeof sub.endpoint !== 'string' || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
    throw new Error('订阅信息不完整');
  }
  const all = readJson(SUBS_FILE, {});
  all[sub.endpoint] = { sub: { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } }, ua: String(ua || '').slice(0, 200), created: Date.now() };
  writeJson(SUBS_FILE, all);
}

export function unsubscribe(endpoint) {
  const all = readJson(SUBS_FILE, {});
  if (all[endpoint]) { delete all[endpoint]; writeJson(SUBS_FILE, all); }
}

export const hasSubscription = endpoint => !!readJson(SUBS_FILE, {})[endpoint];
export const subscriptionCount = () => Object.keys(readJson(SUBS_FILE, {})).length;

// 发给所有订阅的设备；失效的订阅（404 / 410）顺手删掉
export async function sendAll(payload, log = () => {}) {
  const all = readJson(SUBS_FILE, {});
  const list = Object.values(all);
  if (!list.length) return 0;
  configure();
  const body = JSON.stringify(payload);
  let ok = 0, dead = [];
  await Promise.all(list.map(async ({ sub }) => {
    // 网络抖动（socket hang up、超时……没有状态码）：隔一会儿再试，最多 3 次
    for (let n = 1; ; n++) {
      try {
        await webpush.sendNotification(sub, body, { TTL: 3600, urgency: 'high' });
        ok++;
        return;
      } catch (e) {
        if (e.statusCode === 404 || e.statusCode === 410) { dead.push(sub.endpoint); return; }
        if (!e.statusCode && n < 3) { await new Promise(r => setTimeout(r, 1500 * n)); continue; }
        log('push failed', e.statusCode || '', String(e.body || e.message).slice(0, 160));
        return;
      }
    }
  }));
  if (dead.length) {
    const cur = readJson(SUBS_FILE, {});
    for (const d of dead) delete cur[d];
    writeJson(SUBS_FILE, cur);
  }
  return ok;
}
