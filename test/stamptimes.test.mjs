import test from 'node:test';
import assert from 'node:assert/strict';
import { stampTimes } from '../acp.mjs';

test('stampTimes：用户按文字对齐，回复取这一轮最后一条回复的时间', () => {
  const items = [
    { kind: 'user', text: 'hi' }, { kind: 'ai', text: 'Hello' },
    { kind: 'tool', name: 'x' },
    { kind: 'user', text: '第二个  问题\n多行' }, { kind: 'ai', text: 'a' }, { kind: 'ai', text: 'b' },
  ];
  const recs = [
    { kind: 'user', text: 'hi', at: 1 }, { kind: 'ai', at: 2 },
    { kind: 'user', text: '系统塞的', at: 3 },
    { kind: 'user', text: '第二个 问题 多行', at: 4 }, { kind: 'ai', at: 5 }, { kind: 'ai', at: 6 },
  ];
  stampTimes(items, recs);
  assert.deepEqual(items.map(x => x.at), [1, 2, undefined, 4, 6, 6]);
});

test('stampTimes：用户消息对不上就不给这一轮的回复打时间；已有时间不动', () => {
  const items = [{ kind: 'user', text: '找不到' }, { kind: 'ai', text: 'x' }, { kind: 'user', text: 'new', at: 99 }];
  stampTimes(items, [{ kind: 'user', text: 'other', at: 1 }, { kind: 'ai', at: 2 }]);
  assert.deepEqual(items.map(x => x.at), [undefined, undefined, 99]);
});
