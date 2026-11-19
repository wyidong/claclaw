import test from 'node:test';
import assert from 'node:assert/strict';
import { audKey } from '../src/audproxy.mjs';

test('纯音频转发只认 B 站 BV 号（带分 P）和网易云数字 ID', () => {
  const q = s => audKey(new URLSearchParams(s));
  assert.equal(q('bv=BV1zV411x7BH'), 'bv:BV1zV411x7BH:1');
  assert.equal(q('bv=BV1zV411x7BH&p=3'), 'bv:BV1zV411x7BH:3');
  assert.equal(q('ne=1357374736'), 'ne:1357374736');
  for (const bad of ['bv=BV1', 'bv=../../etc', 'ne=abc', 'ne=1;rm', '', 'u=https://x.com/a.mp3']) assert.equal(q(bad), '');
});
