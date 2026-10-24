// DeepSeek 费用估算：只用 provider 上报的 usage 桶，按每条消息的模型/北京时间时段乘公开价
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-usage-'));
const SID = '22222222-3333-4444-8555-666666666666';
const DIR = path.join(DSH, 'sessions', '--tmp-usage--', SID);
// 父会话 + 两层子代理（子代理的日志在别的组里也要找得到）
const PARENT = '33333333-4444-4555-8666-777777777777', SUB = '44444444-5555-4666-8777-888888888888', SUB2 = '55555555-6666-4777-8888-999999999999';
const CMP = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const SAT = Date.parse('2026-10-24T02:00:00Z');   // 周六 10:00 北京时间：空闲
const msg = (seq, model, usage) => ({ type: 'assistant/message', seq, time: SAT, data: { message: { source: { model } }, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...usage } } });
function writeSession(group, sid, recs) {
  const d = path.join(DSH, 'sessions', group, sid);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(recs.map(r => JSON.stringify(r)).join('\n') + '\n')));
}

if (HAS_ZSTD) {
  fs.mkdirSync(DIR, { recursive: true });
  const recs = [
    { type: 'session', version: 4, id: SID, createdAt: Date.now(), cwd: '/tmp/usage', isSeeded: false, delegationDepth: 0 },
    // 2026-10-22 10:00 北京时间，周四高峰：Flash 未命中 2 + 命中 0.04 + 输出 8
    { type: 'assistant/message', seq: 0, time: Date.parse('2026-10-22T02:00:00Z'), data: { message: { source: { model: 'deepseek-flash' } }, usage: { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 } } },
    // 2026-10-22 00:00 北京时间，周五空闲：Flash 1 + 0.02 + 4
    { type: 'assistant/message', seq: 1, time: Date.parse('2026-10-22T16:00:00Z'), data: { message: { source: { model: 'deepseek-v4-flash' } }, usage: { inputTokens: 1e6, outputTokens: 1e6, cacheReadTokens: 1e6, cacheWriteTokens: 0 } } },
  ];
  fs.writeFileSync(path.join(DIR, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(recs.map(r => JSON.stringify(r)).join('\n') + '\n')));
  const head = (id, parent) => ({ type: 'session', version: 4, id, createdAt: SAT, cwd: '/tmp/p', isSeeded: false, ...(parent ? { origin: 'subagent', parentSession: parent, delegationDepth: 1 } : { delegationDepth: 0 }) });
  writeSession('--tmp-p--', PARENT, [head(PARENT), msg(0, 'deepseek-v4-pro', { inputTokens: 1e6 })]);              // Pro 空闲未命中 4.5
  writeSession('--tmp-p--', SUB, [head(SUB, PARENT), msg(0, 'deepseek-flash', { outputTokens: 1e6 })]);           // Flash 空闲输出 4
  writeSession('--tmp-q--', SUB2, [head(SUB2, SUB), msg(0, 'deepseek-flash', { cacheReadTokens: 1e6 })]);         // Flash 空闲命中 0.02
  // 压缩本身也会调模型；compaction/summary 的 usage 要算进会话费用
  writeSession('--tmp-cmp--', CMP, [head(CMP), { type: 'compaction/summary', seq: 0, time: SAT, data: { model: 'deepseek-flash', usage: { inputTokens: 1e6, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } } }]);
}

process.env.DSH_HOME = DSH;
const { dsUsage, DsRunner } = await import('../dsh.mjs');

test('累计四个 provider 桶，并按消息时间和模型估算 CNY', { skip: !HAS_ZSTD }, () => {
  const u = dsUsage('ds:' + SID);
  assert.equal(u.tokens.uncachedInputTokens, 2e6);
  assert.equal(u.tokens.outputTokens, 2e6);
  assert.equal(u.tokens.cacheReadTokens, 2e6);
  assert.equal(u.tokens.cacheWriteTokens, 0);
  assert.equal(u.messages, 2);
  assert.equal(u.model, 'deepseek-v4-flash');
  assert.equal(u.costCny, 15.06);   // 高峰 10.04 + 空闲 5.02
});

test('子代理（多层）的用量算进父会话，模型仍显示父会话的', { skip: !HAS_ZSTD }, () => {
  const u = dsUsage('ds:' + PARENT);
  assert.equal(u.messages, 3);
  assert.equal(u.subagents, 2);
  assert.equal(u.model, 'deepseek-v4-pro');
  assert.equal(u.costCny, 8.52);
  assert.equal(dsUsage('ds:' + SUB).costCny, 4.02);   // 子代理自己只算自己和下层
  assert.equal(dsUsage('ds:' + SID).subagents, 0);
});

test('压缩调用的 usage 也算进费用', { skip: !HAS_ZSTD }, () => {
  const u = dsUsage('ds:' + CMP);
  assert.equal(u.messages, 1);
  assert.equal(u.costCny, 1);   // Flash 空闲未命中 1 元 / 百万
});

test('长回合里定时推累计费用：没变化不重复推，回合结束就停', { skip: !HAS_ZSTD }, async () => {
  const r = new DsRunner('ds:' + SID, { log: () => {}, usageEvery: 20 });
  const ev = [];
  r.subscribe({ readyState: 1, send: s => ev.push(JSON.parse(s)) });
  r.setBusy(true);
  await new Promise(res => setTimeout(res, 90));
  const pushed = ev.filter(e => e.t === 'usage');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].usage.costCny, 15.06);
  r.setBusy(false);
  assert.equal(r.usageTimer, null);
  r.dispose();
});

test('不存在的会话返回 null', { skip: !HAS_ZSTD }, () => {
  assert.equal(dsUsage('ds:00000000-0000-4000-8000-000000000000'), null);
});
