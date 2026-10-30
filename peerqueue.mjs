// 协同消息的「连不上就排队重发」和「收信去重」——和对方（后端 richard）商定的同一套规则：
//   - 只在连不上时排队：拒绝连接、超时、中继报对方隧道不在线（502/503/504）。401 / 400 / 404 / 413 不重试
//   - 409（会话正忙）、额度以外的 429（上一条还在处理）：隔 1 分钟重试，最多 5 次
//   - 重发间隔 1、2、5、10 分钟，之后每 10 分钟一次，带抖动，最长 24 小时；每次带同一个 msg_id 和 sent_at
//   - 收信去重保留 24 小时，落盘（重启后还认得）
//   - sent_at：第一次发送的时间（ISO 8601，带时区）；收到时晚了 5 分钟以上，交给会话时注明「X 前发出」
import fs from 'node:fs';
import path from 'node:path';

export const RETRY_STEPS = [60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3];
export const RETRY_EVERY = 10 * 60e3;
export const RETRY_MAX_AGE = 24 * 3600e3;
export const BUSY_RETRY = 60e3, BUSY_MAX = 5;
export const SEEN_TTL = 24 * 3600e3;
export const LATE_MS = 5 * 60e3;

// 一次发送的结果归类：ok 送到了 | offline 连不上（排队重发）| busy 对方忙（短间隔重试几次）| fail 对方明确拒绝（不重试）
export function classify(res, err) {
  if (err) return 'offline';   // 连接失败、超时、发出去后连接被掐：同一个 msg_id 重发，对方按编号去重，不会处理两遍
  if (!res) return 'offline';
  if (res.ok) return 'ok';
  const s = Number(res.status) || 0;
  if (s === 502 || s === 503 || s === 504) return 'offline';
  if (s === 409) return 'busy';
  if (s === 429 && res.code !== 'quota_exhausted') return 'busy';
  return 'fail';
}

// 下一次重发要等多久：tries = 已经重发过几次（第一次发送不算）；±20% 抖动，免得两边同时恢复时一起涌过来
export function nextDelay(kind, tries, rand = Math.random) {
  const base = kind === 'busy' ? BUSY_RETRY : (RETRY_STEPS[tries] ?? RETRY_EVERY);
  return Math.round(base * (0.8 + 0.4 * rand()));
}

// ISO 8601、带本地时区偏移（2026-10-30T16:50:00+08:00）：比末尾的 Z 更好认，老版本 Python 的 fromisoformat 也能解析
export function isoLocal(t = Date.now()) {
  const d = new Date(t), off = -d.getTimezoneOffset(), p = n => String(Math.floor(Math.abs(n))).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds()) +
    (off >= 0 ? '+' : '-') + p(off / 60) + ':' + p(off % 60);
}

// 收到时比 sent_at 晚 5 分钟以上：返回「12 分钟」「3 小时」「2 天」；没晚、没给、格式不对都返回空
export function lateText(sentAt, now = Date.now()) {
  const t = Date.parse(String(sentAt || ''));
  if (!Number.isFinite(t)) return '';
  const d = now - t;
  if (d < LATE_MS) return '';
  if (d < 3600e3) return Math.round(d / 60e3) + ' 分钟';
  if (d < 48 * 3600e3) return Math.round(d / 3600e3) + ' 小时';
  return Math.round(d / 86400e3) + ' 天';
}

// 落盘的小表：key → 记录（带 at）。超过 ttl 的读写时顺手清掉；写盘先写临时文件再改名
export class DiskMap {
  constructor(file, { ttl = 0, max = 2000 } = {}) {
    this.file = file; this.ttl = ttl; this.max = max;
    try { this.m = new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')) || {})); } catch { this.m = new Map(); }
    this.prune();
  }
  prune(now = Date.now()) {
    if (this.ttl) for (const [k, v] of this.m) if (now - (v?.at || 0) > this.ttl) this.m.delete(k);
    while (this.m.size > this.max) this.m.delete(this.m.keys().next().value);
  }
  get(k) { const v = this.m.get(k); if (v && this.ttl && Date.now() - (v.at || 0) > this.ttl) { this.m.delete(k); return undefined; } return v; }
  has(k) { return this.get(k) !== undefined; }
  set(k, v) { this.m.delete(k); this.m.set(k, v); this.prune(); this.save(); }
  delete(k) { if (this.m.delete(k)) this.save(); }
  values() { return [...this.m.values()]; }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(this.m)), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}
