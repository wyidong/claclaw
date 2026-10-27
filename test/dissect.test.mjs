import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dissectClaudeLines, dissectClaude, dissectDs, toolBrief, userTextOf } from '../dissect.mjs';

const T0 = Date.parse('2026-10-26T12:00:00Z');
const iso = (ms) => new Date(T0 + ms).toISOString();
const user = (ms, content, extra) => ({ type: 'user', timestamp: iso(ms), message: { role: 'user', content }, ...extra });
const asst = (ms, id, content, usage, extra) => ({ type: 'assistant', timestamp: iso(ms), message: { id, model: 'claude-opus-5-5', role: 'assistant', content, usage, stop_reason: 'end_turn' }, ...extra });
const U = (inp, out, think) => ({ input_tokens: inp, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: out, output_tokens_details: { thinking_tokens: think || 0 } });

function sample() {
  return [
    { type: 'custom-title', customTitle: 'x' },
    user(0, '把列表排个序'),
    asst(1000, 'm1', [{ type: 'thinking', thinking: '…' }], U(5, 10, 8)),            // 同一条回复流式写两行
    asst(1500, 'm1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'git status' } }], U(5, 40, 8)),
    user(3000, [{ type: 'tool_result', tool_use_id: 't1', content: 'On branch main', is_error: false }], { toolUseResult: 'x', permissionDecision: { decision: 'accept', source: 'user_temporary' } }),
    asst(5000, 'm2', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/a/b.js' } }], U(7, 20, 0)),
    user(5500, [{ type: 'tool_result', tool_use_id: 't2', content: 'nope', is_error: true }], { toolUseResult: 'x' }),
    asst(8000, 'm3', [{ type: 'text', text: '排好了。' }], U(9, 30, 0)),
    { type: 'system', subtype: 'compact_boundary', timestamp: iso(9000), compactMetadata: { trigger: 'manual', preTokens: 90000, postTokens: 12000 } },
    user(9100, 'summary…', { isCompactSummary: true }),
    { type: 'attachment', timestamp: iso(20000), attachment: { type: 'queued_command', prompt: '再快一点' } },
    asst(21000, 'm4', [{ type: 'text', text: '好。' }], U(3, 5, 0)),
    user(22000, '[Request interrupted by user]'),
    user(30000, [{ type: 'text', text: '看图' }, { type: 'image', source: {} }]),
    { type: 'system', subtype: 'api_error', timestamp: iso(30500) },
    asst(32000, 'm5', [{ type: 'text', text: '看到了' }], U(4, 6, 0)),
    { type: 'cost-state', totalCostUSD: 1 },
  ];
}

test('Claude：按用户的话分轮，步 / 工具 / token 去重', () => {
  const { summary, turns } = dissectClaudeLines(sample());
  assert.equal(turns.length, 3);
  const a = turns[0];
  assert.equal(a.text, '把列表排个序');
  assert.equal(a.nSteps, 3, '同一条回复的两行只算一步');
  assert.equal(a.nTools, 2);
  assert.equal(a.out, 40 + 20 + 30, '流式两行取最后一行的 usage');
  assert.equal(a.think, 8);
  assert.equal(a.in, 1005 + 1007 + 1009);
  assert.equal(a.ctx, 1009);
  assert.equal(a.errors, 1);
  assert.equal(a.asks, 1);
  assert.equal(a.durMs, 8000, '到这一轮最后一条回复 / 工具结果为止；之后的压缩记录、下一句话之前的空闲都不算');
  assert.equal(a.reply, '排好了。');
  assert.deepEqual(a.compact, { pre: 90000, post: 12000, trigger: 'manual' });
  const bash = a.steps[0].tools[0];
  assert.equal(bash.name, 'Bash'); assert.equal(bash.brief, 'git status'); assert.equal(bash.ms, 1500); assert.equal(bash.size, 'On branch main'.length); assert.equal(bash.err, false);
  assert.equal(a.steps[1].tools[0].err, true);
  assert.equal(a.steps[1].latMs, 2000, '上一条记录到这步回复的间隔');
  const b = turns[1];
  assert.equal(b.text, '再快一点'); assert.equal(b.queued, true); assert.equal(b.interrupted, true);
  const c = turns[2];
  assert.equal(c.text, '看图'); assert.equal(c.images, 1); assert.equal(c.retries, 1);
  assert.equal(summary.turns, 3); assert.equal(summary.steps, 5); assert.equal(summary.tools, 2);
  assert.deepEqual(summary.toolsBy, [['Bash', 1], ['Read', 1]]);
  assert.equal(summary.compactions, 1); assert.equal(summary.interrupted, 1); assert.equal(summary.errors, 1);
  assert.deepEqual(summary.models, ['claude-opus-5-5']);
  assert.equal(summary.longestTurn, 1); assert.equal(summary.maxCtx, 1009);
  assert.equal(summary.in, a.in + b.in + c.in); assert.equal(summary.out, 90 + 5 + 6);
});

test('Claude：从文件读，坏行跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diss-'));
  const f = path.join(dir, 's.jsonl');
  fs.writeFileSync(f, sample().map((x) => JSON.stringify(x)).join('\n') + '\nnot json\n{"type":"user","timestamp":"' + iso(40000) + '","message":{"role":"user","content":"<command-name>/compact</command-name>"}}\n');
  const r = await dissectClaude(f);
  assert.equal(r.turns.length, 3, '斜杠命令不算一轮');
  assert.equal(r.summary.steps, 5);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('工具摘要', () => {
  assert.equal(toolBrief('Bash', { command: 'ls -la', description: 'x' }), 'ls -la');
  assert.equal(toolBrief('Edit', { file_path: '/p/q.mjs', old_string: 'a' }), '/p/q.mjs');
  assert.equal(toolBrief('Grep', { pattern: 'foo', path: 'src' }), 'foo src');
  assert.equal(toolBrief('Agent', { description: '查资料', prompt: '…' }), '查资料');
  assert.equal(toolBrief('mcp__x__y', { text: 'hi' }), 'hi');
  assert.equal(toolBrief('mcp__x__y', { n: 1 }), '{"n":1}');
  assert.equal(toolBrief('bash', { command: 'x'.repeat(300) }).length, 110);
});

test('userTextOf：系统注入、命令、工具结果不算用户的话', () => {
  assert.equal(userTextOf({ type: 'user', message: { content: '<system-reminder>a</system-reminder>你好' } }), '你好');
  assert.equal(userTextOf({ type: 'user', message: { content: '<command-name>/x</command-name>' } }), '');
  assert.equal(userTextOf({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), '');
  assert.equal(userTextOf({ type: 'user', isMeta: true, message: { content: 'x' } }), '');
  assert.equal(userTextOf({ type: 'user', message: { content: [{ type: 'image' }] } }), '[图片]');
});

test('DeepSeek：dsh 记录分轮', () => {
  const recs = [
    { type: 'session', id: 's1', cwd: '/w' },
    { type: 'request/header', time: T0, data: { header: { config: { model: 'deepseek-flash' } } } },
    { type: 'user/message', time: T0 + 10, data: { content: [{ type: 'text', text: '列文件' }], source: { kind: 'user' } } },
    { type: 'assistant/message', time: T0 + 2000, data: { usage: { inputTokens: 100, cacheReadTokens: 900, outputTokens: 50, reasoningTokens: 20 }, message: { content: [{ type: 'reasoning', text: '…' }, { type: 'text', text: '我看看' }] } } },
    { type: 'tool/call', time: T0 + 2100, data: { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' } },
    { type: 'tool/result', time: T0 + 2600, data: { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'a\nb' }] }] } } },
    { type: 'assistant/message', time: T0 + 4000, data: { usage: { inputTokens: 120, cacheReadTokens: 1000, outputTokens: 30 }, message: { content: [{ type: 'text', text: '有两个文件' }] } } },
    { type: 'turn/end', time: T0 + 4100, data: { turn: 1, reason: { kind: 'completed' } } },
    { type: 'user/message', time: T0 + 9000, data: { content: [{ type: 'text', text: '删掉' }], source: { kind: 'user' } } },
    { type: 'assistant/message', time: T0 + 9500, data: { usage: { inputTokens: 10, outputTokens: 5 }, message: { content: [] } } },
    { type: 'turn/end', time: T0 + 9600, data: { turn: 2, reason: { kind: 'cancelled' } } },
  ];
  const { summary, turns } = dissectDs(recs);
  assert.equal(turns.length, 2);
  const a = turns[0];
  assert.equal(a.nSteps, 2); assert.equal(a.nTools, 1); assert.equal(a.in, 1000 + 1120); assert.equal(a.out, 80); assert.equal(a.think, 20);
  assert.equal(a.steps[0].tools[0].brief, 'ls'); assert.equal(a.steps[0].tools[0].ms, 500); assert.equal(a.steps[0].tools[0].size, 3);
  assert.equal(a.durMs, 4090); assert.equal(a.reply, '有两个文件');
  assert.equal(turns[1].interrupted, true);
  assert.equal(summary.model, 'deepseek-flash'); assert.equal(summary.steps, 3); assert.equal(summary.tools, 1);
});
