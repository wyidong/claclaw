import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeClaudeUsage } from '../claudeusage.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cu-'));

test('unifiedWindows 记下两个窗口，秒转毫秒', () => {
  const u = makeClaudeUsage(tmp());
  assert.equal(u.get(), null);
  const now = 1_700_000_000_000, r5 = now / 1000 + 3600, r7 = now / 1000 + 86400 * 3;
  assert.ok(u.note({ status: 'allowed', rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.06, resetsAt: r5 }, seven_day: { utilization: 0.31, resetsAt: r7 } } }, now));
  const g = u.get(now);
  assert.deepEqual(g.five_hour, { used: 0.06, resetsAt: r5 * 1000 });
  assert.deepEqual(g.seven_day, { used: 0.31, resetsAt: r7 * 1000 });
  assert.equal(g.at, now);
});

test('没有 unifiedWindows：只更新当前那个窗口，另一个保留', () => {
  const u = makeClaudeUsage(tmp());
  u.note({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 2e9 }, seven_day: { utilization: 0.2, resetsAt: 2e9 } } }, 1);
  assert.ok(u.note({ rateLimitType: 'five_hour', utilization: 0.5, resetsAt: 2e9 }, 2));
  const g = u.get(3);
  assert.equal(g.five_hour.used, 0.5);
  assert.equal(g.seven_day.used, 0.2);
});

test('无关事件不记；过了重置时间按 0 算', () => {
  const u = makeClaudeUsage(tmp());
  assert.equal(u.note(null), false);
  assert.equal(u.note({ status: 'allowed', rateLimitType: 'overage' }), false);
  u.note({ unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 100 } } }, 1);
  assert.deepEqual(u.get(200_000).five_hour, { used: 0, resetsAt: null, stale: true });
});
