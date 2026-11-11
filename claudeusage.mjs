// Claude 订阅的用量（5 小时窗口、周窗口）：每轮回复时 Claude Code 发来 rate_limit_event，里面 unifiedWindows 带两个窗口的用量（0～1）和重置时间。
// 整个账号共用，记最新一份到 data/claude-usage.json，会话设置里显示；用模型库 Key 的会话没有这个事件。
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './auth.mjs';

const WINS = ['five_hour', 'seven_day'];

export function makeClaudeUsage(DATA) {
  const file = path.join(DATA, 'claude-usage.json');
  let cur = null, saveT = null;
  try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  function win(w) {
    const u = Number(w?.utilization), r = Number(w?.resetsAt);
    return Number.isFinite(u) ? { used: Math.max(0, Math.min(1, u)), resetsAt: Number.isFinite(r) && r > 0 ? r * 1000 : null } : null;
  }
  // info：SDKRateLimitInfo；没有 unifiedWindows 的旧版只带当前那个窗口（rateLimitType + utilization）
  function note(info, at = Date.now()) {
    if (!info || typeof info !== 'object') return false;
    const ws = info.unifiedWindows && typeof info.unifiedWindows === 'object' ? info.unifiedWindows
      : WINS.includes(info.rateLimitType) && info.utilization != null ? { [info.rateLimitType]: { utilization: info.utilization, resetsAt: info.resetsAt } } : null;
    if (!ws) return false;
    const next = { ...(cur || {}), at, status: info.status || null };
    let any = false;
    for (const k of WINS) { const w = win(ws[k]); if (w) { next[k] = w; any = true; } }
    if (!any) return false;
    cur = next;
    clearTimeout(saveT); saveT = setTimeout(() => { try { writeJsonAtomic(file, cur); } catch {} }, 2000);
    saveT.unref?.();
    return true;
  }
  // 过了重置时间的窗口：用量按 0 算（下一轮回复会带回真实数）
  function get(now = Date.now()) {
    if (!cur) return null;
    const out = { at: cur.at, status: cur.status };
    for (const k of WINS) {
      const w = cur[k];
      if (w) out[k] = w.resetsAt && w.resetsAt <= now ? { used: 0, resetsAt: null, stale: true } : w;
    }
    return out;
  }
  return { note, get };
}
