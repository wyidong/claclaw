// claudehist.mjs：Claude 会话记录读取。重点是打开会话的历史按「轮」增量解析——分几次追加后读到的，要和整个文件冷启动解析的一样
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-hist-')));
process.env.HOME = HOME;   // 模块加载时取家目录：先改好再 import
const h = await import('../src/claws/claudehist.mjs');
test.after(() => fs.rmSync(HOME, { recursive: true, force: true }));

const CWD = path.join(HOME, 'proj');
const DIR = path.join(HOME, '.claude', 'projects', CWD.replace(/[^A-Za-z0-9]/g, '-'));
fs.mkdirSync(DIR, { recursive: true });
const ID1 = '11111111-1111-4111-8111-111111111111', ID2 = '22222222-2222-4222-8222-222222222222';

// 造一段会话：n 轮，每轮 用户问 → AI 说一句 + 跑一个命令 → 工具结果 → AI 收尾；第 3 轮后压缩一次
function lines(id) {
  const out = [];
  let parent = null, t = Date.parse('2026-11-01T00:00:00Z');
  const add = o => { const uuid = 'u' + out.length; out.push(JSON.stringify({ parentUuid: parent, sessionId: id, cwd: CWD, timestamp: new Date(t += 1000).toISOString(), uuid, isSidechain: false, userType: 'external', version: '2.0.0', ...o })); parent = uuid; };
  for (let k = 0; k < 6; k++) {
    add({ type: 'user', message: { role: 'user', content: '问题 ' + k } });
    add({ type: 'assistant', message: { id: 'm' + k, role: 'assistant', content: [{ type: 'text', text: '好的 ' + k }, { type: 'tool_use', id: 't' + k, name: 'Bash', input: { command: 'echo ' + k } }], usage: { input_tokens: 10, cache_read_input_tokens: 100 * k, output_tokens: 5 } } });
    add({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + k, content: 'out ' + k }] } });
    add({ type: 'assistant', message: { id: 'n' + k, role: 'assistant', content: [{ type: 'text', text: '完成 ' + k }], usage: { input_tokens: 1, output_tokens: 2 } } });
    if (k === 2) add({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 12000, postTokens: 3000 } });
  }
  return out;
}

test('历史增量解析：分三次追加读到的 == 整个文件一次解析', async () => {
  const all = lines(ID1), f1 = path.join(DIR, ID1 + '.jsonl');
  const cuts = [Math.floor(all.length / 3), Math.floor(all.length * 2 / 3), all.length];
  let from = 0, inc;
  for (const c of cuts) {
    fs.appendFileSync(f1, all.slice(from, c).join('\n') + '\n');
    from = c;
    inc = await h.loadHistoryCached(ID1, CWD);
  }
  fs.writeFileSync(path.join(DIR, ID2 + '.jsonl'), lines(ID2).join('\n') + '\n');
  const full = await h.loadHistoryCached(ID2, CWD);
  assert.equal(inc.total, full.total);
  assert.deepEqual(inc.items, full.items);
  assert.ok(full.items.some(x => x.kind === 'sys' && /已自动压缩/.test(x.text)), '压缩分界显示成一行');
  const tool = full.items.find(x => x.kind === 'tool');
  assert.equal(tool.target, 'echo 0');
  assert.equal(tool.output, 'out 0');
  // 文件没变：直接给上次的结果
  assert.equal(await h.loadHistoryCached(ID2, CWD), full);
  // 分页：最后一页
  const pg = h.historyPage(full, full.total, 3);
  assert.equal(pg.items.length, 3);
  assert.equal(pg.start, full.total - 3);
  assert.equal(pg.more, true);
});

test('列表用的尾部信息：最后一条用户消息、最后消息时间、累计用量、上下文大小', () => {
  const f = path.join(DIR, ID2 + '.jsonl');
  assert.equal(h.lastPromptOf(f), '问题 5');
  assert.equal(h.lastMsgAt(f), Date.parse('2026-11-01T00:00:00Z') + 25 * 1000);
  const u = h.usageOf(f);
  assert.equal(u.in, 6 * 11 + 100 * 15);
  assert.equal(u.out, 6 * 7);
  assert.equal(h.ctxFromFile({ sessionId: ID2, cwd: CWD }), 1);
  assert.equal(h.lastPromptOf(path.join(DIR, 'nope.jsonl')), '');
  assert.equal(h.lastMsgAt(path.join(DIR, 'nope.jsonl')), 0);
});

test('工具卡片：目标和改动', () => {
  assert.equal(h.toolTarget('Read', { file_path: CWD + '/a/b.js' }, CWD), 'a/b.js');
  assert.equal(h.toolTarget('mcp__claclaw__set_web_login', { username: 'u', password: 'abc' }), '网页登录改成：用户名 u，密码 •••');
  assert.deepEqual(h.toolDiff('Edit', { old_string: 'a', new_string: 'b' }), [['-', 'a'], ['+', 'b']]);
  assert.equal(h.toolDiff('Bash', { command: 'ls' }), null);
  assert.equal(h.peerPreview('【claclaw 协同 · 来自对方：小王 · 某机（你的会话 ID：x）】\n你好呀'), '「小王· 你好呀');
});
