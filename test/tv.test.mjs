// claw-tv 技能：找台的匹配（不联网：只测不在 YouTube 上的台）
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
const run = (...a) => execFileSync(process.execPath, ['skills/claw-tv/tv.mjs', ...a], { encoding: 'utf8' });
const names = out => out.split('\n').filter(l => l.includes(' | ')).map(l => l.split(' | ')[2]);

test('央视几套、CCTV 编号：五套带上 5+，13 不会匹配到 1，cctv5 不会匹配到「中视」(ctv)', () => {
  assert.deepEqual(names(run('央视五套')), ['CCTV-5 体育', 'CCTV-5+ 体育赛事']);
  assert.deepEqual(names(run('cctv13')), ['CCTV-13 新闻']);
  assert.deepEqual(names(run('CCTV-1')), ['CCTV-1 综合']);
  assert.deepEqual(names(run('新闻联播')), ['CCTV-13 新闻']);
});
test('简称、口语：四川台、芒果台、打开湖南卫视', () => {
  assert.deepEqual(names(run('四川台')), ['四川卫视']);
  assert.deepEqual(names(run('芒果台')), ['湖南卫视']);
  assert.deepEqual(names(run('打开湖南卫视')), ['湖南卫视']);
});
test('输出是 ```tv 块，每行 5 段；没有的台退出码 2', () => {
  const out = run('四川卫视');
  assert.match(out, /^```tv\n/);
  for (const l of out.split('\n').filter(l => l.includes(' | '))) assert.equal(l.split(' | ').length, 5);
  assert.equal(spawnSync(process.execPath, ['skills/claw-tv/tv.mjs', '不存在的台xyz']).status, 2);
});
