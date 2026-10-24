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
}

process.env.DSH_HOME = DSH;
const { dsUsage } = await import('../dsh.mjs');

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

test('不存在的会话返回 null', { skip: !HAS_ZSTD }, () => {
  assert.equal(dsUsage('ds:00000000-0000-4000-8000-000000000000'), null);
});
