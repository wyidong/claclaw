import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUTO_COMPACT, autoCompactDue, autoCompactRun } from '../autocompact.mjs';

test('自动压缩：从不 / 到线才压 / 压过没降不反复压', () => {
  const sent = [], ev = [];
  const r = { ctx: 250000, emit: e => ev.push(e), send: t => { sent.push(t); return true; } };
  AUTO_COMPACT.k = () => 0;
  assert.equal(autoCompactDue(r), false, '默认从不');
  AUTO_COMPACT.k = () => 300;
  assert.equal(autoCompactDue(r), false, '没到线');
  AUTO_COMPACT.k = () => 200;
  assert.equal(autoCompactDue(r), true);
  autoCompactRun(r);
  assert.deepEqual(sent, ['/compact']);
  assert.ok(ev.some(e => e.t === 'ctx.auto'));
  assert.equal(autoCompactDue(r), false, '压缩失败、大小没变：不再压');
  r.ctx = 260000;
  assert.equal(autoCompactDue(r), true, '又长了：再试');
  r.autoCompactAt = 0; r.ctx = 210000;   // 压缩成功后清掉记号，之后再长过线照常压
  assert.equal(autoCompactDue(r), true);
});
