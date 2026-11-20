import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLrc, cleanTitle } from '../src/lyric.mjs';

test('歌词：LRC 解析成按时间排好的 [秒, 句]，一行多个时间标签拆开，没时间的行不要', () => {
  const l = parseLrc('{"t":0,"c":[{"tx":"作词"}]}\n[00:01.50]第一句\n[00:10.2][01:05.25]副歌\n[ti:标题]\n[00:20.000]第二句\n[00:30]');
  assert.deepEqual(l.map(x => x[1]), ['第一句', '副歌', '第二句', '', '副歌']);
  assert.equal(l[0][0], 1.5);
  assert.equal(l[4][0], 65.25);
  assert.deepEqual(parseLrc('[00:01]只有一句'), []);   // 太少不算歌词
});

test('歌词：B 站那种标题去掉修饰再搜', () => {
  assert.equal(cleanTitle('在百万豪装录音棚大声听刘若英《后来》【Hi-res】'), '刘若英 后来');
  assert.equal(cleanTitle('【杜比音效】周杰伦《晴天》4K「刮风这天」动态歌词'), '周杰伦 晴天');
  assert.equal(cleanTitle('南方姑娘 - 赵雷'), '南方姑娘 - 赵雷');
});
