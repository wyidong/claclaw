// DeepSeek 命令菜单：本地命令真的能返回内容，不把不支持的 dsh 原生命令当成提示词发出去
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-cmd-'));
process.env.DSH_HOME = DSH;
const { DsRunner, COMMANDS } = await import('../dsh.mjs');

const tick = () => new Promise(r => setImmediate(r));
function runner() {
  const r = new DsRunner('ds:11111111-2222-4333-8444-555555555555', { log: () => {} });
  const events = [];
  r.subscribe({ readyState: 1, send: s => events.push(JSON.parse(s)) });
  return { r, events };
}
// 本地命令的答复是异步的；先把 server 的 user 回显记下，验证顺序
async function run(text, { busy = false } = {}) {
  const { r, events } = runner();
  r.busy = busy;
  assert.equal(r.send(text), true);
  r.emit({ t: 'user', text });   // server 在 send() 返回后推回显
  await tick();
  return { r, events, reply: events.find(e => e.t === 'ai.full' || e.t === 'sys')?.text || '' };
}

test('命令列表包含本地可执行命令，不含 ACP 接不到的原生命令', () => {
  const names = COMMANDS.map(c => c.name);
  for (const n of ['model', 'effort', 'cost', 'status', 'stop', 'help']) assert.ok(names.includes(n), n);
  for (const n of ['compact', 'goal', 'feedback']) assert.ok(!names.includes(n), n);
});

test('答复排在 user 回显之后', async () => {
  const { events } = await run('/cost');
  const order = events.map(e => e.t);
  assert.deepEqual(order.slice(0, 2), ['user', 'ai.full']);
  assert.equal(order.at(-1), 'turn.done');
});

test('/help 返回命令说明，包含 dsh 原生命令的限制', async () => {
  const { reply } = await run('/help');
  assert.match(reply, /\/cost/);
  assert.match(reply, /\/compact/);
  assert.match(reply, /ACP/);
});

test('/cost 和 /status 不会走 ACP，直接返回本地结果', async () => {
  assert.match((await run('/cost')).reply, /usage|估算/);
  assert.match((await run('/status')).reply, /模型/);
});

test('/compact、多行 /feedback 不发给模型，直接说明 ACP 接不到', async () => {
  for (const t of ['/compact', '/feedback 第一行\n第二行']) {
    const { r, reply } = await run(t);
    assert.match(reply, /ACP/);
    assert.match(reply, /dsh web/);
    assert.equal(r.attached, false);
  }
});

test('回合进行中：本地命令走 sys 条，不结束这一轮', async () => {
  const { events, reply } = await run('/help', { busy: true });
  assert.equal(events.find(e => e.t === 'sys')?.text, reply);
  assert.ok(!reply.includes('`'));
  assert.ok(!events.some(e => e.t === 'turn.done'));
});

test('/stop 没有在跑的回合时只回一句', async () => {
  const { reply, events } = await run('/stop');
  assert.match(reply, /没有在跑/);
  assert.equal(events.at(-1).t, 'turn.done');
});
