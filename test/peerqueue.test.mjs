import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { classify, nextDelay, isoLocal, lateText, DiskMap, RETRY_STEPS, RETRY_EVERY, BUSY_RETRY } from '../peerqueue.mjs';

test('发送结果归类：只有连不上才排队，对方明确拒绝的不重试', () => {
  assert.equal(classify({ ok: true, status: 200 }), 'ok');
  assert.equal(classify({ ok: true, status: 202, accepted: true }), 'ok');
  assert.equal(classify(null, new Error('ECONNREFUSED')), 'offline');
  assert.equal(classify(null, new Error('socket hang up')), 'offline');
  for (const s of [502, 503, 504]) assert.equal(classify({ ok: false, status: s }), 'offline', String(s));
  assert.equal(classify({ ok: false, status: 409 }), 'busy');
  assert.equal(classify({ ok: false, status: 429 }), 'busy');
  assert.equal(classify({ ok: false, status: 429, code: 'quota_exhausted' }), 'fail');
  for (const s of [400, 401, 403, 404, 413]) assert.equal(classify({ ok: false, status: s }), 'fail', String(s));
});

test('重发间隔：1、2、5、10 分钟，之后每 10 分钟；忙就 1 分钟；±20% 抖动', () => {
  const mid = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 9].map(n => nextDelay('offline', n, mid)), [...RETRY_STEPS, RETRY_EVERY, RETRY_EVERY]);
  assert.equal(nextDelay('busy', 3, mid), BUSY_RETRY);
  assert.equal(nextDelay('offline', 0, () => 0), 0.8 * RETRY_STEPS[0]);
  assert.equal(nextDelay('offline', 0, () => 1), 1.2 * RETRY_STEPS[0]);
});

test('sent_at：ISO 8601 带时区偏移，能被解析回同一时刻', () => {
  const t = Date.UTC(2026, 9, 30, 8, 50, 0);
  const s = isoLocal(t);
  assert.match(s, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
  assert.equal(Date.parse(s), t);
});

test('晚到提示：晚 5 分钟以上才注明，按分钟 / 小时 / 天', () => {
  const now = Date.UTC(2026, 9, 30, 12, 0, 0);
  const ago = ms => isoLocal(now - ms);
  assert.equal(lateText(ago(4 * 60e3), now), '');
  assert.equal(lateText(ago(12 * 60e3), now), '12 分钟');
  assert.equal(lateText(ago(3 * 3600e3), now), '3 小时');
  assert.equal(lateText(ago(3 * 86400e3), now), '3 天');
  assert.equal(lateText('2026-10-30T19:50:00+08:00', now), '10 分钟');   // 对方给的别的时区也认
  assert.equal(lateText('', now), '');
  assert.equal(lateText('不是时间', now), '');
});

test('落盘小表：重启后还在，过期的清掉，条数有上限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pq-'));
  try {
    const f = path.join(dir, 'seen.json');
    const a = new DiskMap(f, { ttl: 1000 });
    a.set('p:1', { at: Date.now(), code: 200 });
    a.set('p:old', { at: Date.now() - 5000, code: 200 });
    const b = new DiskMap(f, { ttl: 1000 });   // 相当于重启后重新读
    assert.equal(b.get('p:1')?.code, 200);
    assert.equal(b.has('p:old'), false);
    const c = new DiskMap(path.join(dir, 'cap.json'), { max: 3 });
    for (let i = 0; i < 5; i++) c.set('k' + i, { at: Date.now() });
    assert.deepEqual(c.values().length, 3);
    assert.equal(c.has('k0'), false);
    assert.equal(c.has('k4'), true);
    b.delete('p:1');
    assert.equal(new DiskMap(f, { ttl: 1000 }).has('p:1'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
