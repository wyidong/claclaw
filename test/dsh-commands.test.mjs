// DeepSeek 命令菜单：本地命令真的能返回内容，不把不支持的 dsh 原生命令当成提示词发出去
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-cmd-'));
process.env.DSH_HOME = DSH;
const { DsRunner, COMMANDS } = await import('../dsh.mjs');

function runner() {
  const r = new DsRunner('ds:11111111-2222-4333-8444-555555555555', { log: () => {} });
  const events = [];
  r.subscribe({ readyState: 1, send: s => events.push(JSON.parse(s)) });
  return { r, events };
}

test('命令列表包含本地可执行命令', () => {
  const names = COMMANDS.map(c => c.name);
  for (const n of ['model', 'effort', 'cost', 'status', 'stop', 'help']) assert.ok(names.includes(n), n);
});

test('/help 返回命令说明，包含 dsh 原生命令的限制', () => {
  const { r, events } = runner();
  assert.equal(r.send('/help'), true);
  const text = events.find(e => e.t === 'ai.full')?.text || '';
  assert.match(text, /\/cost/);
  assert.match(text, /\/compact/);
  assert.match(text, /ACP/);
});

test('/cost 和 /status 不会走 ACP，直接返回本地结果', () => {
  const { r, events } = runner();
  assert.equal(r.send('/cost'), true);
  assert.match(events.find(e => e.t === 'ai.full')?.text || '', /usage|估算/);
  const { r: r2, events: e2 } = runner();
  assert.equal(r2.send('/status'), true);
  assert.match(e2.find(e => e.t === 'ai.full')?.text || '', /模型/);
});

test('/compact 不发给模型，直接说明 ACP 接不到', () => {
  const { r, events } = runner();
  assert.equal(r.send('/compact'), true);
  const text = events.find(e => e.t === 'ai.full')?.text || '';
  assert.match(text, /ACP/);
  assert.match(text, /dsh web/);
});
