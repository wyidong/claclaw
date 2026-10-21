// 过程播报：把 public/index.html 里的 narration 模块原样抽出来，用桩事件验证分类/文案。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const start = html.indexOf('var narration=(function(){');
const end = html.indexOf('// 试听：', start);
assert.ok(start >= 0 && end > start, '找不到 narration 模块');
const source = html.slice(start, end);

function harness() {
  const spoken = [], timers = [];
  const ctx = {
    tts: { on: true, mode: 'steps' },
    ttsModeAllows: () => true,
    ttsSay: text => spoken.push(text),
    ttsSpeaking: () => false,
    ttsInterrupt: text => spoken.push(text),
    narrBeep: () => {},
    document: { hidden: false },
    setTimeout: (fn, ms) => { const id = timers.length + 1; timers.push({ id, fn, ms }); return id; },
    clearTimeout: id => { const i = timers.findIndex(x => x.id === id); if (i >= 0) timers.splice(i, 1); },
  };
  vm.createContext(ctx);
  vm.runInContext(source + '\nthis.__narration = narration;', ctx);
  return {
    narration: ctx.__narration,
    spoken,
    // 只跑指定延迟的定时器，避免把 pump 的 400ms 递归也跑掉
    run(ms) { for (const t of timers.filter(x => x.ms === ms).slice()) { const i = timers.indexOf(t); if (i >= 0) timers.splice(i, 1); t.fn(); } },
  };
}

test('DeepSeek 传整条命令时只念“需要你确认”', () => {
  const h = harness();
  h.narration.onEvent({ t: 'perm.request', requestId: 'r1', name: "cat > /tmp/clawlogo/bbox.py <<'EOF' write png", target: "bbox.py <<'EOF' import zlib,struct,sys" });
  assert.deepEqual(h.spoken, ['需要你确认']);

  h.narration.onEvent({ t: 'perm.request', requestId: 'r2', name: 'Edit', target: "bbox.py <<'EOF' import zlib" });
  assert.deepEqual(h.spoken, ['需要你确认', '需要你确认：改文件']);

  h.narration.onEvent({ t: 'tool.start', id: 't1', name: "cat > /tmp/clawlogo/bbox.py <<'EOF' write png", target: 'bbox.py <<EOF' });
  h.run(3000);
  assert.deepEqual(h.spoken, ['需要你确认', '需要你确认：改文件']);
});

test('TodoWrite / TaskCreate 不会当成改文件或派子任务', () => {
  const h = harness();
  h.narration.onEvent({ t: 'tool.start', id: 't1', name: 'TodoWrite', target: 'todo' });
  h.run(3000);
  h.narration.onEvent({ t: 'tool.start', id: 't2', name: 'TaskCreate', target: 'task' });
  h.run(3000);
  assert.deepEqual(h.spoken, []);
});

test('Edit 只念 basename；Task 仍算子任务', () => {
  const h = harness();
  h.narration.onEvent({ t: 'tool.start', id: 't1', name: 'Edit', target: '/Users/mac/demo/server.mjs' });
  h.run(3000);
  assert.deepEqual(h.spoken, ['改了 server.mjs']);

  const h2 = harness();
  h2.narration.onEvent({ t: 'tool.start', id: 't2', name: 'Task', target: 'sub' });
  h2.run(3000);
  assert.deepEqual(h2.spoken, ['派了个子任务']);
});
