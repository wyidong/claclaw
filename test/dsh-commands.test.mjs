// DeepSeek 命令菜单：本地命令真的能返回内容；/compact 走 dsh host，不把命令当提示词发出去
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-cmd-'));
process.env.DSH_HOME = DSH;
const { DsRunner, COMMANDS, parseDshWebUrl } = await import('../dsh.mjs');

const tick = () => new Promise(r => setImmediate(r));
function runner(opts = {}) {
  const r = new DsRunner('ds:11111111-2222-4333-8444-555555555555', { log: () => {}, ...opts });
  const events = [];
  r.subscribe({ readyState: 1, send: s => events.push(JSON.parse(s)) });
  return { r, events };
}
// 本地命令的答复是异步的；先把 server 的 user 回显记下，验证顺序
async function run(text, { busy = false, compact } = {}) {
  const { r, events } = runner(compact ? { compact } : {});
  r.busy = busy;
  assert.equal(r.send(text), true);
  r.emit({ t: 'user', text });   // server 在 send() 返回后推回显
  if (busy) await new Promise(res => setTimeout(res, 20));
  else {
    const until = Date.now() + 500;
    while (!events.some(e => e.t === 'turn.done') && Date.now() < until) await tick();
  }
  const reply = [...events].reverse().find(e => e.t === 'ai.full' || e.t === 'sys')?.text || '';
  return { r, events, reply };
}

test('命令列表包含本地可执行命令，不含 ACP 接不到的原生命令', () => {
  const names = COMMANDS.map(c => c.name);
  for (const n of ['model', 'effort', 'compact', 'cost', 'status', 'stop', 'help']) assert.ok(names.includes(n), n);
  for (const n of ['goal', 'feedback']) assert.ok(!names.includes(n), n);
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
  assert.match(reply, /\/goal/);
  assert.match(reply, /ACP/);
});

test('/cost 和 /status 不会走 ACP，直接返回本地结果', async () => {
  assert.match((await run('/cost')).reply, /usage|估算/);
  assert.match((await run('/status')).reply, /模型/);
});

test('/compact 调 dsh host，并报出压缩结果', async () => {
  const calls = [];
  const { r, reply } = await run('/compact', {
    compact: async (sid) => { calls.push(sid); return { ok: true, text: 'Compacted 3 history items (~10 tokens).' }; },
  });
  assert.deepEqual(calls, [r.sid]);
  assert.match(reply, /压缩完成/);
  assert.match(reply, /Compacted 3 history items/);
  assert.equal(r.attached, false);
  assert.equal(r.compacting, false);
});

test('/compact 带参数时不执行，只提示用法', async () => {
  const { reply } = await run('/compact now', {
    compact: async () => { throw new Error('should not run'); },
  });
  assert.match(reply, /用法/);
});

test('/compact 失败时显示原因，不会假装成功', async () => {
  const { reply, events } = await run('/compact', {
    compact: async () => ({ ok: false, text: 'Compaction could not produce a useful summary.' }),
  });
  assert.match(reply, /压缩失败/);
  assert.match(reply, /could not produce/);
  assert.equal(events.at(-1).t, 'turn.done');
  assert.equal(events.at(-1).subtype, 'error');
});

test('/feedback 和多行 /feedback 仍说明 ACP 接不到', async () => {
  for (const t of ['/feedback 第一行\n第二行']) {
    const { r, reply } = await run(t);
    assert.match(reply, /ACP/);
    assert.match(reply, /dsh web/);
    assert.equal(r.attached, false);
  }
});

test('回合进行中：本地命令走 sys 条，不结束这一轮；/compact 也要等', async () => {
  const { events, reply } = await run('/help', { busy: true });
  assert.equal(events.find(e => e.t === 'sys')?.text, reply);
  assert.ok(!reply.includes('`'));
  assert.ok(!events.some(e => e.t === 'turn.done'));

  const c = await run('/compact', { busy: true });
  assert.match(c.reply, /等这一轮结束/);
  assert.ok(!c.events.some(e => e.t === 'turn.done'));
});

test('/stop 没有在跑的回合时只回一句', async () => {
  const { reply, events } = await run('/stop');
  assert.match(reply, /没有在跑/);
  assert.equal(events.at(-1).t, 'turn.done');
});

test('从 dsh web 启动输出里取带 token 的地址', () => {
  const url = 'http://127.0.0.1:43210/?token=abc_DEF-123';
  assert.equal(parseDshWebUrl('dsh: ALL_PROXY ...\ndsh web: ' + url + '\ndsh web: opening'), url);
  assert.equal(parseDshWebUrl('dsh web: http://127.0.0.1:1/'), '');
});

test('压缩前先关 ACP 会话，压缩后再 resume；顺序不能反', async () => {
  const calls = [];
  const { r, events } = runner({
    compact: async (sid) => { calls.push('compact:' + sid); return { ok: true, text: 'Compacted 2 history items (~5 tokens).' }; },
  });
  r.attached = true;
  r.detach = async () => { calls.push('detach'); r.attached = false; };
  r.attach = async () => { calls.push('attach'); r.attached = true; };
  await r.compact();
  assert.deepEqual(calls, ['detach', 'compact:' + r.sid, 'attach']);
  assert.equal(r.attached, true);
  assert.ok(events.some(e => e.t === 'ai.full' && /压缩完成/.test(e.text)));
  assert.equal(events.at(-1).t, 'turn.done');
});

test('没人看着的会话压缩后不急着 resume，等下次打开再接', async () => {
  let attached = false;
  const r = new DsRunner('ds:11111111-2222-4333-8444-555555555555', {
    log: () => {},
    compact: async () => ({ ok: true, text: 'Compacted 1 history items (~1 tokens).' }),
  });
  r.attached = true;
  r.detach = async () => { attached = true; r.attached = false; };
  r.attach = async () => { attached = true; r.attached = true; };
  await r.compact();
  assert.equal(attached, true);   // detach 过，但没有 attach
  assert.equal(r.attached, false);
  assert.equal(r.busy, false);
});
