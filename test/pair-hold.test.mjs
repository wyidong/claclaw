import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-pair-'));
const { notePairFail, pairHoldState, clearPairFails, addPending, PAIR_WAITS } = await import('../peer.mjs');

test('输错冷却逐级变长，冷却中只有输错的一方显示配对中，结束后告诉它失败', () => {
  clearPairFails();
  const t0 = 1e12;
  assert.equal(notePairFail('a', t0), 30e3);
  assert.deepEqual(pairHoldState('a', t0 + 1000), { mine: true, left: 29e3 });
  assert.equal(pairHoldState('b', t0 + 1000).mine, false);
  assert.deepEqual(pairHoldState('a', t0 + 31e3), { mine: true, done: true });
  assert.equal(pairHoldState('a', t0 + 32e3), null);
  assert.equal(notePairFail('b', t0 + 40e3), 3 * 60e3);
  assert.equal(notePairFail('c', t0 + 300e3), 30 * 60e3);
  assert.equal(notePairFail('d', t0 + 3000e3), PAIR_WAITS.at(-1));
  assert.equal(notePairFail('e', t0 + 20000e3), PAIR_WAITS.at(-1));
  assert.equal(notePairFail('f', t0 + 20000e3 + 25 * 3600e3), 30e3, '24 小时没再错就清零');
  clearPairFails();
});

test('配对码两位数；冷却中不收新申请', () => {
  clearPairFails();
  const p = addPending('x', '10.0.0.1', '');
  assert.match(p.code, /^[1-9]\d$/);
  notePairFail(p.id);
  assert.throws(() => addPending('y', '10.0.0.2', ''), /正在配对中/);
  clearPairFails();
});
