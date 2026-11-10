import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-data-'));   // mini.mjs 引入 auth.mjs 前先指到临时目录
const { pickRoute, statsLine, baseOf } = await import('../mini.mjs');
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mini-agent.mjs');

const P = (id, url, models = ['m1']) => ({ id, name: id, endpoints: { openai: url }, key: 'k', models: models.map(x => ({ id: x })) });
const store = { providers: [P('deepseek', 'https://api.deepseek.com'), P('ollama', 'http://127.0.0.1:11434/v1', ['q1', 'q2']), P('anthropic-only', 'x')] };
store.providers[2].endpoints = { anthropic: 'https://a.example' };
const lib = pr => pr.providers.flatMap(p => p.endpoints.openai ? p.models.map(m => ({ p, m, value: 'lib:' + p.id + '/' + m.id, fmt: 'openai' })) : []);

test('Mini 走哪家：记过的优先；没记过本机地址排最前；记的那家没了换回默认', () => {
  assert.equal(pickRoute({}, store, lib(store)).p.id, 'ollama');
  assert.equal(pickRoute({ provider: 'deepseek' }, store, lib(store)).p.id, 'deepseek');
  assert.equal(pickRoute({ provider: 'gone' }, store, lib(store)).p.id, 'ollama');   // 记的那家没了
  assert.equal(pickRoute({}, { providers: [store.providers[0]] }, lib({ providers: [store.providers[0]] })).p.id, 'deepseek');
  assert.equal(pickRoute({}, { providers: [] }, []), null);
});

// 假的 OpenAI 兼容服务：按脚本一条条回；记下每次收到的请求
function fakeModel(replies) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      reqs.push(JSON.parse(b));
      const text = replies[Math.min(reqs.length - 1, replies.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const ch of text.match(/[\s\S]{1,4}/g)) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: ch } }] }) + '\n\n');
      res.write('data: ' + JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: 'http://127.0.0.1:' + srv.address().port + '/v1' })));
}

// 不收 temperature 的接口（像 OpenAI 官方的推理模型）：带了就回 400
function strictModel() {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const j = JSON.parse(b); reqs.push(j);
      if ('temperature' in j) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: "Unsupported parameter: 'temperature'" } })); }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '好的' } }] }) + '\n\ndata: [DONE]\n\n');
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: 'http://127.0.0.1:' + srv.address().port + '/v1' })));
}

// answer(params) → 选哪个 optionId（默认「允许」）
function startAgent(env, answer = () => 'allow') {
  const p = spawn(process.execPath, [AGENT], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'inherit'] });
  const updates = [], pend = new Map(), asks = [];
  let buf = '', id = 0;
  p.stdout.on('data', d => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (m.method === 'session/update') updates.push(m.params.update);
      else if (m.method === 'session/request_permission') { asks.push(m.params); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { outcome: { outcome: 'selected', optionId: answer(m.params) } } }) + '\n'); }
      else if (pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  const rpc = (method, params) => new Promise(r => { const i = ++id; pend.set(i, r); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: i, method, params }) + '\n'); });
  return { p, rpc, updates, asks, stop: () => { p.stdin.end(); p.kill(); } };
}
const say = (a, sid, text) => a.rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] });
const textOf = ups => ups.filter(u => u.sessionUpdate === 'agent_message_chunk').map(u => u.content.text).join('');

test('Mini agent：纯问答——不带工具、提示词很短；模型写了标签也只当文字；会话落盘、重放历史；每轮带速度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-cwd-'));
  const m = await fakeModel(['你可以运行 <run>ls</run> 看看。', '第二个回答']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir, MINI_MODELS: 'q1,q2', MINI_MODEL: 'q1' });
  try {
    const init = await a.rpc('initialize', {});
    assert.equal(init.result.agentCapabilities.loadSession, true);
    const n = (await a.rpc('session/new', { cwd })).result;
    assert.deepEqual(n.configOptions.map(o => o.id), ['model', 'effort']);   // 没有权限模式
    assert.equal(n.configOptions.find(o => o.id === 'effort').currentValue, 'off');

    const r = await say(a, n.sessionId, '怎么看目录里有什么');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(textOf(a.updates), '你可以运行 <run>ls</run> 看看。');   // 原样当文字
    assert.equal(a.asks.length, 0);
    assert.ok(!a.updates.some(u => /^tool_call/.test(u.sessionUpdate)));
    const q = m.reqs[0];
    assert.equal(q.reasoning_effort, 'none'); assert.equal(q.max_tokens, 4096);
    assert.ok(!('tools' in q) && !('stop' in q));
    assert.equal(q.messages.length, 2);
    assert.ok(q.messages[0].content.length < 200, '系统提示要短');
    assert.match(q.messages[0].content, /你现在用的模型是 q1。/);
    assert.doesNotMatch(q.messages[0].content, /<run>|工作目录|标签/);
    const u = a.updates.find(x => x.sessionUpdate === 'usage_update');
    assert.equal(u.used, 110); assert.equal(u._meta.mini.model, 'q1'); assert.equal(u._meta.mini.outTokens, 10);
    assert.ok(u._meta.mini.ttft >= 0 && u._meta.mini.total >= u._meta.mini.ttft);

    await say(a, n.sessionId, '再问一个');
    assert.equal(m.reqs[1].messages.length, 4);
    assert.equal(m.reqs[1].messages[0].content, q.messages[0].content);   // 前缀不变
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'));
    assert.equal(saved.title, '怎么看目录里有什么'); assert.equal(saved.messages.length, 4);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, n.sessionId + '.json')).mode & 0o777, 0o600);   // Windows 没有这套权限位

    // 另一个进程里接上：历史重放成 用户 / 回复
    a.stop();
    const b = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir });
    try {
      await b.rpc('initialize', {});
      await b.rpc('session/load', { sessionId: n.sessionId, cwd });
      assert.deepEqual(b.updates.map(u => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk', 'user_message_chunk', 'agent_message_chunk']);
      assert.equal((await b.rpc('session/load', { sessionId: 'nope-nope' })).error.message, '找不到这个会话');
      assert.match((await b.rpc('session/set_config_option', { sessionId: n.sessionId, configId: 'mode', value: 'yolo' })).error.message, /没有这一项/);
    } finally { b.stop(); }
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：思考开关；旧版本存的工具记录重放时不显示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const old = { sessionId: 'old-sess', cwd: os.tmpdir(), model: 'q1', title: '旧', mode: 'yolo', messages: [
    { role: 'user', content: '看看文件' }, { role: 'assistant', content: '<run>ls</run>' }, { role: 'user', tool: true, content: '<result>\na.txt\n</result>' }, { role: 'assistant', content: '有 a.txt' }] };
  fs.writeFileSync(path.join(dir, 'old-sess.json'), JSON.stringify(old));
  const m = await fakeModel(['好']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const l = await a.rpc('session/load', { sessionId: 'old-sess' });
    assert.deepEqual(l.result.configOptions.map(o => o.id), ['model', 'effort']);
    assert.deepEqual(a.updates.map(u => u.sessionUpdate + ':' + u.content.text), ['user_message_chunk:看看文件', 'agent_message_chunk:<run>ls</run>', 'agent_message_chunk:有 a.txt']);
    await a.rpc('session/set_config_option', { sessionId: 'old-sess', configId: 'effort', value: 'on' });
    await say(a, 'old-sess', '想一想');
    assert.equal('reasoning_effort' in m.reqs.at(-1), false);   // 开思考：不发 reasoning_effort
    assert.equal('mode' in JSON.parse(fs.readFileSync(path.join(dir, 'old-sess.json'), 'utf8')), false);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：模型服务连不上 / 报错时给人看得懂的错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const a = startAgent({ MINI_BASE_URL: 'http://127.0.0.1:1/v1', MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, 'hi');
    assert.match(r.error.message, /连不上模型服务/);
  } finally { a.stop(); }
});

test('Mini agent：超出预算时一次性丢最早的几轮，最后一轮保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await fakeModel(['ok']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir, MINI_BUDGET: '2000' });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const long = '字'.repeat(500);
    for (let i = 0; i < 6; i++) await say(a, n.sessionId, long + i);
    const last = m.reqs.at(-1).messages;
    assert.ok(last.length < 13, '旧的几轮已经丢掉');
    assert.equal(last.at(-1).content, long + '5');
    assert.equal(last[1].role, 'user');   // 从用户消息处断开
    const kept = m.reqs.map(r => r.messages.length);
    assert.ok(kept.some((x, i) => i && x < kept[i - 1]), '有一次整体收缩，而不是每轮都变');
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：关不掉思考的模型（思考混在正文里，只有 </think>）：只留回答，之后不再发 reasoning_effort=none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await fakeModel(['我想一想，用户要什么……</think>\n\n答案是 42', '第二次：对']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, '问题一');
    assert.equal(m.reqs[0].reasoning_effort, 'none');
    assert.ok(textOf(a.updates).endsWith('答案是 42'));
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'));
    assert.equal(saved.messages.at(-1).content, '答案是 42');   // 存下来的也不带思考
    assert.equal(saved.messages.at(-2).run.calls[0].text, '我想一想，用户要什么……</think>\n\n答案是 42');   // 解剖用的原样输出带着标签
    assert.equal(saved.noOff, true);
    await say(a, n.sessionId, '问题二');
    assert.equal('reasoning_effort' in m.reqs[1], false);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini 速度那一行：模型 · 首字 · 速度 · 输出 · 共计；没有输出 / 没有 usage 时少几项', () => {
  assert.equal(statsLine({ model: 'qwen3:30b', ttft: 0.4234, tps: 47.26, outTokens: 312, total: 7.04 }), 'qwen3:30b · 首字 0.42 秒 · 47 tok/s · 输出 312 tok · 共 7.0 秒');
  assert.equal(statsLine({ model: 'q', ttft: 12.3, tps: 3.14, outTokens: null, total: 20 }), 'q · 首字 12.3 秒 · 3.1 tok/s · 共 20.0 秒');
  assert.equal(statsLine({ model: 'q', ttft: null, tps: null, outTokens: null, total: 1 }), 'q · 没有输出 · 共 1.0 秒');
});

test('Mini agent：中途换模型——提示词写明当前模型，回答记下是哪个模型答的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await fakeModel(['我是 q1', '我是 q2']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir, MINI_MODELS: 'q1,q2', MINI_MODEL: 'q1' });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, '你是谁');
    await a.rpc('session/set_config_option', { sessionId: n.sessionId, configId: 'model', value: 'q2' });
    await say(a, n.sessionId, '你是谁');
    assert.equal(m.reqs[1].model, 'q2');
    assert.match(m.reqs[1].messages[0].content, /你现在用的模型是 q2。.*以这一句为准/s);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'));
    assert.deepEqual(saved.messages.filter(x => x.role === 'assistant').map(x => x.model), ['q1', 'q2']);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：旧会话里的工具标签 / 工具结果 / 空回复不发给模型，相邻同角色并成一条', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  fs.writeFileSync(path.join(dir, 'legacy-1.json'), JSON.stringify({ sessionId: 'legacy-1', model: 'q1', messages: [
    { role: 'assistant', content: '开头多出来的' },
    { role: 'user', content: '西游记原文' }, { role: 'assistant', content: '<read>https://x.com/a</read>' }, { role: 'user', tool: true, content: '<result>\n失败\n</result>' },
    { role: 'user', content: 'hi' }, { role: 'assistant', content: '你好' }, { role: 'user', content: 'ls' }, { role: 'assistant', content: '' }] }));
  const m = await fakeModel(['好']);
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    await a.rpc('session/load', { sessionId: 'legacy-1' });
    await say(a, 'legacy-1', '再来');
    assert.deepEqual(m.reqs[0].messages.slice(1).map(x => x.role + ':' + x.content), ['user:西游记原文\n\nhi', 'assistant:你好', 'user:ls\n\n再来']);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：接口不收 temperature / reasoning_effort（回 400）时去掉重试一次，记下来以后不发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await strictModel();
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, 'hi');
    assert.equal(r.result.stopReason, 'end_turn'); assert.equal(textOf(a.updates), '好的');
    assert.equal(m.reqs.length, 2); assert.ok(!('reasoning_effort' in m.reqs[1]));
    await say(a, n.sessionId, '再问');
    assert.equal(m.reqs.length, 3); assert.ok(!('temperature' in m.reqs[2]));   // 记住了，不再先撞一次 400
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).plain, true);
    // 换了模型要重新试：又先带上 temperature
    await a.rpc('session/set_config_option', { sessionId: n.sessionId, configId: 'model', value: 'other' });
    await say(a, n.sessionId, '换了模型');
    assert.equal(m.reqs[3].model, 'other'); assert.ok('temperature' in m.reqs[3]); assert.equal(m.reqs.length, 5);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini 走哪家：模型库里只有 Anthropic / Gemini 接口的也能选；地址按格式补齐', () => {
  const g = { id: 'google', name: 'Google', endpoints: { gemini: 'https://generativelanguage.googleapis.com/v1beta' }, key: 'k', models: [{ id: 'gemini-2.5-flash' }] };
  const hit = pickRoute({ provider: 'google' }, { providers: [store.providers[0], g] });
  assert.equal(hit.p.id, 'google'); assert.equal(hit.fmt, 'gemini');
  assert.equal(pickRoute({ provider: 'anthropic-only' }, store).fmt, 'anthropic');
  assert.equal(pickRoute({}, store).p.id, 'ollama');   // 本机的还是排最前
  assert.equal(baseOf('openai', 'https://api.deepseek.com'), 'https://api.deepseek.com/v1');
  assert.equal(baseOf('openai', 'http://127.0.0.1:11434/v1/'), 'http://127.0.0.1:11434/v1');
  assert.equal(baseOf('anthropic', 'https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic');
  assert.equal(baseOf('anthropic', 'https://api.anthropic.com/v1'), 'https://api.anthropic.com');
  assert.equal(baseOf('gemini', 'https://generativelanguage.googleapis.com'), 'https://generativelanguage.googleapis.com/v1beta');
  assert.equal(baseOf('gemini', 'https://generativelanguage.googleapis.com/v1beta/'), 'https://generativelanguage.googleapis.com/v1beta');
});

// 假的 Anthropic / Gemini 服务：记下路径、请求头、请求体，按各自的流格式回「你好世界」
function fakeNative(kind) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      reqs.push({ url: req.url, headers: req.headers, body: JSON.parse(b) });
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = o => res.write((kind === 'anthropic' ? 'event: ' + o.type + '\n' : '') + 'data: ' + JSON.stringify(o) + '\r\n\r\n');
      if (kind === 'anthropic') {
        ev({ type: 'message_start', message: { usage: { input_tokens: 50, cache_read_input_tokens: 10 } } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '想想' } });
        for (const s of ['你好', '世界']) ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: s } });
        ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 12 } });
        ev({ type: 'message_stop' });
      } else {
        ev({ candidates: [{ content: { role: 'model', parts: [{ text: '想想', thought: true }] } }] });
        for (const s of ['你好', '世界']) ev({ candidates: [{ content: { role: 'model', parts: [{ text: s }] } }] });
        ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 60, candidatesTokenCount: 9, thoughtsTokenCount: 3 } });
      }
      res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: 'http://127.0.0.1:' + srv.address().port })));
}

for (const kind of ['anthropic', 'gemini']) test('Mini agent：' + kind + ' 接口——路径、key 的请求头、请求体、流式回复、用量都对', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await fakeNative(kind);
  const base = kind === 'gemini' ? m.url + '/v1beta' : m.url;
  const a = startAgent({ MINI_FORMAT: kind, MINI_BASE_URL: base, MINI_API_KEY: 'sk-test', MINI_MODELS: 'mx', MINI_MODEL: kind === 'gemini' ? 'models/mx' : 'mx', MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, '第一问');
    const r = await say(a, n.sessionId, '第二问');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(textOf(a.updates), '你好世界你好世界');
    assert.ok(a.updates.some(u => u.sessionUpdate === 'agent_thought_chunk'));
    const q = m.reqs[1], use = a.updates.filter(u => u.sessionUpdate === 'usage_update').at(-1);
    if (kind === 'anthropic') {
      assert.equal(q.url, '/v1/messages'); assert.equal(q.headers['x-api-key'], 'sk-test'); assert.ok(q.headers['anthropic-version']);
      assert.match(q.body.system, /你现在用的模型是 mx/);
      assert.deepEqual(q.body.messages.map(x => x.role + ':' + x.content), ['user:第一问', 'assistant:你好世界', 'user:第二问']);
      assert.ok(!('thinking' in q.body)); assert.equal(q.body.temperature, 0.3);
      assert.equal(use.used, 60 + 12); assert.equal(use._meta.mini.outTokens, 12);
    } else {
      assert.equal(q.url, '/v1beta/models/mx:streamGenerateContent?alt=sse'); assert.equal(q.headers['x-goog-api-key'], 'sk-test');
      assert.match(q.body.systemInstruction.parts[0].text, /你现在用的模型是 models\/mx/);
      assert.deepEqual(q.body.contents.map(x => x.role + ':' + x.parts[0].text), ['user:第一问', 'model:你好世界', 'user:第二问']);
      assert.deepEqual(q.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
      assert.equal(use.used, 60 + 12); assert.equal(use._meta.mini.outTokens, 12);
    }
    // 打开思考：anthropic 带 thinking、不带 temperature；gemini 要思考摘要
    await a.rpc('session/set_config_option', { sessionId: n.sessionId, configId: 'effort', value: 'on' });
    await say(a, n.sessionId, '第三问');
    const q3 = m.reqs[2].body;
    if (kind === 'anthropic') { assert.equal(q3.thinking.type, 'enabled'); assert.ok(!('temperature' in q3)); assert.ok(q3.max_tokens > q3.thinking.budget_tokens); }
    else assert.deepEqual(q3.generationConfig.thinkingConfig, { includeThoughts: true });
  } finally { a.stop(); m.srv.close(); }
});

// 按脚本回：每次 { text, stop }，stop 按格式写进结束原因字段
function scripted(kind, script) {
  const reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const body = JSON.parse(b); reqs.push(body);
      const { text, stop } = script[Math.min(reqs.length - 1, script.length - 1)];
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (kind === 'openai') {
        for (const ch of text.match(/[\s\S]{1,3}/g)) ev({ choices: [{ delta: { content: ch } }] });
        ev({ choices: [{ delta: {}, finish_reason: stop }] }); ev({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 20 } });
        res.write('data: [DONE]\n\n');
      } else if (kind === 'anthropic') {
        ev({ type: 'message_start', message: { usage: { input_tokens: 100 } } });
        ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } });
        ev({ type: 'message_delta', delta: { stop_reason: stop }, usage: { output_tokens: 20 } });
      } else {
        ev({ candidates: [{ content: { parts: [{ text }] } }] });
        ev({ candidates: [{ content: { parts: [{ text: '' }] }, finishReason: stop }], usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20 } });
      }
      res.end();
    });
  });
  return new Promise(r => srv.listen(0, '127.0.0.1', () => r({ srv, reqs, url: 'http://127.0.0.1:' + srv.address().port + (kind === 'openai' ? '/v1' : kind === 'gemini' ? '/v1beta' : '') })));
}
const miniStats = ups => ups.filter(u => u.sessionUpdate === 'usage_update').at(-1)?._meta?.mini;

for (const [kind, LEN, OK] of [['openai', 'length', 'stop'], ['anthropic', 'max_tokens', 'end_turn'], ['gemini', 'MAX_TOKENS', 'STOP']]) test('Mini agent：' + kind + ' 回复到了输出上限就自动接着写，拼成同一条回复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await scripted(kind, [{ text: '第一段，', stop: LEN }, { text: '第二段，', stop: LEN }, { text: '写完了。', stop: OK }]);
  const a = startAgent({ MINI_FORMAT: kind, MINI_BASE_URL: m.url, MINI_MODEL: 'mx', MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, '讲长一点');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(m.reqs.length, 3);
    assert.equal(textOf(a.updates), '第一段，第二段，写完了。');
    // 续写的请求：带上已经写的和「接着写」
    const last = kind === 'gemini' ? m.reqs[2].contents.map(x => x.role + ':' + x.parts[0].text) : m.reqs[2].messages.filter(x => x.role !== 'system').map(x => x.role + ':' + x.content);
    assert.equal(last.length, 3); assert.match(last[1], /:第一段，第二段，$/); assert.match(last[2], /^user:.*接着写/);
    const st = miniStats(a.updates);
    assert.equal(st.parts, 3); assert.equal(st.outTokens, 60); assert.ok(!st.note);
    assert.match(statsLine(st), /分 3 段/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).messages;
    assert.deepEqual(saved.map(x => x.role + ':' + x.content), ['user:讲长一点', 'assistant:第一段，第二段，写完了。']);
  } finally { a.stop(); m.srv.close(); }
});

test('Mini agent：一直写不完最多接 4 段，提示发「继续」；被 Gemini 防复述拦下不重试，写明原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m1 = await scripted('openai', [{ text: '又一段', stop: 'length' }]);
  const a1 = startAgent({ MINI_BASE_URL: m1.url, MINI_MODEL: 'mx', MINI_DIR: dir });
  const m2 = await scripted('gemini', [{ text: '昔在黄帝，生而神灵，', stop: 'RECITATION' }]);
  const a2 = startAgent({ MINI_FORMAT: 'gemini', MINI_BASE_URL: m2.url, MINI_MODEL: 'mx', MINI_DIR: dir });
  try {
    await a1.rpc('initialize', {});
    const n1 = (await a1.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a1, n1.sessionId, '写很长');
    assert.equal(m1.reqs.length, 4); assert.match(miniStats(a1.updates).note, /继续/);
    await a2.rpc('initialize', {});
    const n2 = (await a2.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a2, n2.sessionId, '素问第一篇原文');
    assert.equal(m2.reqs.length, 1); assert.equal(textOf(a2.updates), '昔在黄帝，生而神灵，');
    assert.match(miniStats(a2.updates).note, /照搬已有的原文/);
  } finally { a1.stop(); a2.stop(); m1.srv.close(); m2.srv.close(); }
});

test('Mini agent：接口报错只取说明；429 写明多久恢复（Gemini 的每分钟 / 每天额度、retry-after 头）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const quota = (id, delay) => JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota.\n* Quota exceeded for metric: free_tier_requests, limit: 10\nPlease retry in 37.2s.', status: 'RESOURCE_EXHAUSTED',
    details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: id, quotaValue: '10' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }] } }]);
  const replies = [
    [{}, quota('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', '37s')],
    [{}, quota('GenerateRequestsPerDayPerProjectPerModel-FreeTier', '20s')],
    [{ 'retry-after': '125' }, JSON.stringify({ error: { message: 'Rate limit reached' } })],
    [{}, JSON.stringify({ error: { message: 'slow down, retry after 900ms' } })],
    [{}, JSON.stringify({ error: { message: 'too many' } })],
  ];
  let k = 0;
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { const [h, b] = replies[k++]; res.writeHead(429, { 'content-type': 'application/json', ...h }); res.end(b); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const a = startAgent({ MINI_FORMAT: 'gemini', MINI_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1beta', MINI_MODEL: 'mx', MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const err = async () => (await say(a, n.sessionId, 'hi')).error.message;
    assert.match(await err(), /^模型服务说额度或频率超限（429）：每分钟的次数（上限 10 次）用完了，约 37 秒后恢复。原话：You exceeded your current quota\. \* Quota/);
    assert.match(await err(), /今天的额度（上限 10 次）用完了，(今天|明天) \d\d:\d\d（太平洋时间 0 点）恢复/);
    assert.match(await err(), /：约 3 分钟后恢复。原话：Rate limit reached$/);
    assert.match(await err(), /：约 1 秒后恢复。/);
    assert.match(await err(), /：等一会儿再试，或者换个模型。原话：too many$/);
  } finally { a.stop(); srv.close(); }
});

test('Mini agent：每轮在用户那条消息上记 run（模型、接口、发了几条、系统提示、每次请求的明细），回复带时间', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mini-sess-'));
  const m = await strictModel();
  const a = startAgent({ MINI_BASE_URL: m.url, MINI_MODEL: 'mx', MINI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, 'hi');
    const msgs = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).messages;
    const u = msgs[0], r = u.run;
    assert.ok(u.at > 0 && msgs[1].at >= u.at);
    assert.equal(r.model, 'mx'); assert.equal(r.api, 'openai'); assert.match(r.host, /^127\.0\.0\.1:\d+$/); assert.equal(r.sent, 1); assert.equal(r.dropped, 0);
    assert.match(r.sys, /你是答疑助手/); assert.equal(r.parts, 1); assert.equal(r.stop, null); assert.ok(r.endAt >= u.at);
    assert.equal(r.calls.length, 2);
    assert.equal(r.calls[0].status, 400); assert.match(r.calls[0].err, /temperature/);
    assert.equal(r.calls[1].status, 200); assert.ok(r.calls[1].retry && r.calls[1].plain); assert.equal(r.calls[1].chars, 2); assert.ok(r.calls[1].ttftMs >= 0);
    // 实际发了什么：第一次带 temperature，去掉调参重试的那次不带；对话的形状（系统提示 + 用户 2 字）；400 时服务返回的原文；不记 key
    assert.equal(r.calls[0].req.path, '/v1/chat/completions'); assert.equal(r.calls[0].req.params.temperature, 0.3); assert.equal(r.calls[0].req.params.model, 'mx');
    assert.equal('temperature' in r.calls[1].req.params, false);
    assert.deepEqual(r.calls[1].req.msgs.map(x => x[0]), ['system', 'user']); assert.equal(r.calls[1].req.msgs[1][1], 2);
    assert.match(r.calls[0].body, /temperature/); assert.equal(typeof r.calls[1].text, 'string');
    assert.equal(JSON.stringify(r).includes('Bearer'), false);
  } finally { a.stop(); m.srv.close(); }
});
