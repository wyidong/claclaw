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

test('纯音频转发：CC 音乐站只认固定目录下的 https mp3，不当通用代理', () => {
  const q = u => audKey(new URLSearchParams({ u }));
  const fsm = 'https://www.free-stock-music.com/music/alex-productions/mp3/alex-productions-lunar-new-year.mp3';
  const cc = 'https://ccmixter.org/content/ramblinglibrarian/ramblinglibrarian_-_Nanyang_Journey_%28Instrumental%29.mp3';
  assert.equal(q(fsm), 'u:' + fsm);
  assert.equal(q(cc), 'u:' + cc);
  for (const bad of ['https://ccmixter.org/content/a/../b.mp3', 'https://ccmixter.org/content/a/%2e%2e/b.mp3', 'https://ccmixter.org/content/a/%2Fetc.mp3',
    'http://ccmixter.org/content/a/b.mp3', 'https://evil.com/music/a/mp3/b.mp3', 'https://ccmixter.org.evil.com/content/a/b.mp3', fsm + '?x=1', 'https://127.0.0.1/a.mp3']) assert.equal(q(bad), '');
});
