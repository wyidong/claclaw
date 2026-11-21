import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-data-'));   // kuai.mjs 引入 auth.mjs 前先指到临时目录
const { pickRoute, statsLine, baseOf, sessionPid, kuNewSession, kuRunners, kuShutdown, KuRunner } = await import('../src/claws/kuai.mjs');
const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'claws', 'kuai-agent.mjs');

const P = (id, url, models = ['m1']) => ({ id, name: id, endpoints: { openai: url }, key: 'k', models: models.map(x => ({ id: x })) });
const store = { providers: [P('deepseek', 'https://api.deepseek.com'), P('ollama', 'http://127.0.0.1:11434/v1', ['q1', 'q2']), P('anthropic-only', 'x')] };
store.providers[2].endpoints = { anthropic: 'https://a.example' };
const lib = pr => pr.providers.flatMap(p => p.endpoints.openai ? p.models.map(m => ({ p, m, value: 'lib:' + p.id + '/' + m.id, fmt: 'openai' })) : []);

test('kuAi 走哪家：记过的优先；没记过本机地址排最前；记的那家没了换回默认', () => {
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
  const p = spawn(process.execPath, [AGENT], { env: { ...process.env, KUAI_SKILLS_DIR: '/nonexistent', KUAI_CMDS: '0', ...env }, stdio: ['pipe', 'pipe', 'inherit'] });   // 默认不给技能、不跑命令（测的自己打开）
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

test('kuAi agent：纯问答——不带工具、提示词很短；模型写了标签也只当文字；会话落盘、重放历史；每轮带速度', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-cwd-'));
  const m = await fakeModel(['你可以运行 <run>ls</run> 看看。', '第二个回答']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'q1,q2', KUAI_MODEL: 'q1' });
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
    assert.ok(q.messages[0].content.length < 360, '系统提示要短');
    assert.match(q.messages[0].content, /你现在用的模型是 q1。/);
    assert.doesNotMatch(q.messages[0].content, /<run>|工作目录|标签/);
    const u = a.updates.find(x => x.sessionUpdate === 'usage_update');
    assert.equal(u.used, 110); assert.equal(u._meta.kuai.model, 'q1'); assert.equal(u._meta.kuai.outTokens, 10);
    assert.ok(u._meta.kuai.ttft >= 0 && u._meta.kuai.total >= u._meta.kuai.ttft);

    await say(a, n.sessionId, '再问一个');
    assert.equal(m.reqs[1].messages.length, 4);
    assert.equal(m.reqs[1].messages[0].content, q.messages[0].content);   // 前缀不变
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'));
    assert.equal(saved.title, '怎么看目录里有什么'); assert.equal(saved.messages.length, 4);
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, n.sessionId + '.json')).mode & 0o777, 0o600);   // Windows 没有这套权限位

    // 另一个进程里接上：历史重放成 用户 / 回复
    a.stop();
    const b = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir });
    try {
      await b.rpc('initialize', {});
      await b.rpc('session/load', { sessionId: n.sessionId, cwd });
      assert.deepEqual(b.updates.map(u => u.sessionUpdate), ['user_message_chunk', 'agent_message_chunk', 'user_message_chunk', 'agent_message_chunk']);
      assert.equal((await b.rpc('session/load', { sessionId: 'nope-nope' })).error.message, '找不到这个会话');
      assert.match((await b.rpc('session/set_config_option', { sessionId: n.sessionId, configId: 'mode', value: 'yolo' })).error.message, /没有这一项/);
    } finally { b.stop(); }
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi agent：思考开关；旧版本存的工具记录重放时不显示', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const old = { sessionId: 'old-sess', cwd: os.tmpdir(), model: 'q1', title: '旧', mode: 'yolo', messages: [
    { role: 'user', content: '看看文件' }, { role: 'assistant', content: '<run>ls</run>' }, { role: 'user', tool: true, content: '<result>\na.txt\n</result>' }, { role: 'assistant', content: '有 a.txt' }] };
  fs.writeFileSync(path.join(dir, 'old-sess.json'), JSON.stringify(old));
  const m = await fakeModel(['好']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir });
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

test('kuAi agent：模型服务连不上 / 报错时给人看得懂的错误', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const a = startAgent({ KUAI_BASE_URL: 'http://127.0.0.1:1/v1', KUAI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, 'hi');
    assert.match(r.error.message, /连不上模型服务/);
  } finally { a.stop(); }
});

test('kuAi agent：超出预算时一次性丢最早的几轮，最后一轮保留', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['ok']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_BUDGET: '2000' });
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

test('kuAi agent：关不掉思考的模型（思考混在正文里，只有 </think>）：只留回答，之后不再发 reasoning_effort=none', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['我想一想，用户要什么……</think>\n\n答案是 42', '第二次：对']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir });
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

test('kuAi 速度那一行：模型 · 首字 · 速度 · 输出 · 共计；没有输出 / 没有 usage 时少几项', () => {
  assert.equal(statsLine({ model: 'qwen3:30b', ttft: 0.4234, tps: 47.26, outTokens: 312, total: 7.04 }), 'qwen3:30b · 首字 0.42 秒 · 47 tok/s · 输出 312 tok · 共 7.0 秒');
  assert.equal(statsLine({ model: 'q', ttft: 12.3, tps: 3.14, outTokens: null, total: 20 }), 'q · 首字 12.3 秒 · 3.1 tok/s · 共 20.0 秒');
  assert.equal(statsLine({ model: 'q', ttft: null, tps: null, outTokens: null, total: 1 }), 'q · 没有输出 · 共 1.0 秒');
});

test('kuAi agent：中途换模型——提示词写明当前模型，回答记下是哪个模型答的', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['我是 q1', '我是 q2']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'q1,q2', KUAI_MODEL: 'q1' });
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

test('kuAi agent：旧会话里的工具标签 / 工具结果 / 空回复不发给模型，相邻同角色并成一条', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  fs.writeFileSync(path.join(dir, 'legacy-1.json'), JSON.stringify({ sessionId: 'legacy-1', model: 'q1', messages: [
    { role: 'assistant', content: '开头多出来的' },
    { role: 'user', content: '西游记原文' }, { role: 'assistant', content: '<read>https://x.com/a</read>' }, { role: 'user', tool: true, content: '<result>\n失败\n</result>' },
    { role: 'user', content: 'hi' }, { role: 'assistant', content: '你好' }, { role: 'user', content: 'ls' }, { role: 'assistant', content: '' }] }));
  const m = await fakeModel(['好']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    await a.rpc('session/load', { sessionId: 'legacy-1' });
    await say(a, 'legacy-1', '再来');
    assert.deepEqual(m.reqs[0].messages.slice(1).map(x => x.role + ':' + x.content), ['user:西游记原文\n\nhi', 'assistant:你好', 'user:ls\n\n再来']);
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi agent：接口不收 temperature / reasoning_effort（回 400）时去掉重试一次，记下来以后不发', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await strictModel();
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir });
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

test('kuAi 走哪家：模型库里只有 Anthropic / Gemini 接口的也能选；地址按格式补齐', () => {
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

for (const kind of ['anthropic', 'gemini']) test('kuAi agent：' + kind + ' 接口——路径、key 的请求头、请求体、流式回复、用量都对', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeNative(kind);
  const base = kind === 'gemini' ? m.url + '/v1beta' : m.url;
  const a = startAgent({ KUAI_FORMAT: kind, KUAI_BASE_URL: base, KUAI_API_KEY: 'sk-test', KUAI_MODELS: 'mx', KUAI_MODEL: kind === 'gemini' ? 'models/mx' : 'mx', KUAI_DIR: dir });
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
      assert.equal(use.used, 60 + 12); assert.equal(use._meta.kuai.outTokens, 12);
    } else {
      assert.equal(q.url, '/v1beta/models/mx:streamGenerateContent?alt=sse'); assert.equal(q.headers['x-goog-api-key'], 'sk-test');
      assert.match(q.body.systemInstruction.parts[0].text, /你现在用的模型是 models\/mx/);
      assert.deepEqual(q.body.contents.map(x => x.role + ':' + x.parts[0].text), ['user:第一问', 'model:你好世界', 'user:第二问']);
      assert.deepEqual(q.body.generationConfig.thinkingConfig, { thinkingBudget: 0 });
      assert.equal(use.used, 60 + 12); assert.equal(use._meta.kuai.outTokens, 12);
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
const kuaiStats = ups => ups.filter(u => u.sessionUpdate === 'usage_update').at(-1)?._meta?.kuai;

for (const [kind, LEN, OK] of [['openai', 'length', 'stop'], ['anthropic', 'max_tokens', 'end_turn'], ['gemini', 'MAX_TOKENS', 'STOP']]) test('kuAi agent：' + kind + ' 回复到了输出上限就自动接着写，拼成同一条回复', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await scripted(kind, [{ text: '第一段，', stop: LEN }, { text: '第二段，', stop: LEN }, { text: '写完了。', stop: OK }]);
  const a = startAgent({ KUAI_FORMAT: kind, KUAI_BASE_URL: m.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
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
    const st = kuaiStats(a.updates);
    assert.equal(st.parts, 3); assert.equal(st.outTokens, 60); assert.ok(!st.note);
    assert.match(statsLine(st), /分 3 段/);
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).messages;
    assert.deepEqual(saved.map(x => x.role + ':' + x.content), ['user:讲长一点', 'assistant:第一段，第二段，写完了。']);
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi agent：一直写不完最多接 4 段，提示发「继续」；被 Gemini 防复述拦下不重试，写明原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m1 = await scripted('openai', [{ text: '又一段', stop: 'length' }]);
  const a1 = startAgent({ KUAI_BASE_URL: m1.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
  const m2 = await scripted('gemini', [{ text: '昔在黄帝，生而神灵，', stop: 'RECITATION' }]);
  const a2 = startAgent({ KUAI_FORMAT: 'gemini', KUAI_BASE_URL: m2.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    await a1.rpc('initialize', {});
    const n1 = (await a1.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a1, n1.sessionId, '写很长');
    assert.equal(m1.reqs.length, 4); assert.match(kuaiStats(a1.updates).note, /继续/);
    await a2.rpc('initialize', {});
    const n2 = (await a2.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a2, n2.sessionId, '素问第一篇原文');
    assert.equal(m2.reqs.length, 1); assert.equal(textOf(a2.updates), '昔在黄帝，生而神灵，');
    assert.match(kuaiStats(a2.updates).note, /照搬已有的原文/);
  } finally { a1.stop(); a2.stop(); m1.srv.close(); m2.srv.close(); }
});

test('kuAi agent：接口报错只取说明；429 写明多久恢复（Gemini 的每分钟 / 每天额度、retry-after 头）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
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
  const a = startAgent({ KUAI_FORMAT: 'gemini', KUAI_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1beta', KUAI_MODEL: 'mx', KUAI_DIR: dir });
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

test('kuAi agent：每轮在用户那条消息上记 run（模型、接口、发了几条、系统提示、每次请求的明细），回复带时间', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await strictModel();
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, 'hi');
    const msgs = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).messages;
    const u = msgs[0], r = u.run;
    assert.ok(u.at > 0 && msgs[1].at >= u.at);
    assert.equal(r.model, 'mx'); assert.equal(r.api, 'openai'); assert.match(r.host, /^127\.0\.0\.1:\d+$/); assert.equal(r.sent, 1); assert.equal(r.dropped, 0);
    assert.match(r.sys, /你是 kuAi，claclaw 自带的答疑助手/); assert.equal(r.parts, 1); assert.equal(r.stop, null); assert.ok(r.endAt >= u.at);
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

// 一张 1×1 的 PNG
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const sayImg = (a, sid, text, n = 1) => a.rpc('session/prompt', { sessionId: sid, prompt: [...(text ? [{ type: 'text', text }] : []), ...Array.from({ length: n }, () => ({ type: 'image', mimeType: 'image/png', data: PNG }))] });

test('kuAi agent：收图——声明能收图；OpenAI 格式发 image_url（data URL）；图存在会话旁边、会话文件里只记文件名；下一轮历史里照样带；只有图没有字也能发；重放带图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['看到了']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    const init = await a.rpc('initialize', {});
    assert.equal(init.result.agentCapabilities.promptCapabilities.image, true);
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await sayImg(a, n.sessionId, '这是什么');
    const u = m.reqs[0].messages[1];
    assert.equal(u.role, 'user');
    assert.deepEqual(u.content, [{ type: 'text', text: '这是什么' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }]);
    const raw = fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'), saved = JSON.parse(raw);
    assert.equal(raw.includes(PNG), false, '会话文件里不放图的数据');
    const im = saved.messages[0].images;
    assert.equal(im.length, 1); assert.equal(im[0].mime, 'image/png'); assert.match(im[0].file, /^[0-9a-f]{16}\.png$/);
    assert.equal(fs.readFileSync(path.join(dir, n.sessionId + '.files', im[0].file)).toString('base64'), PNG);
    assert.deepEqual(saved.messages[0].run.calls[0].req.msgs.at(-1), ['user', 4, 1]); assert.equal(saved.messages[0].run.calls[0].req.imgs, 1);
    assert.equal(JSON.stringify(saved.messages[0].run).includes(PNG), false, '请求记录里不放图的数据');
    await say(a, n.sessionId, '再说说');
    assert.equal(m.reqs[1].messages[1].content[1].type, 'image_url', '下一轮历史里还带着图');
    assert.equal(m.reqs[1].messages[3].content, '再说说');
    const r = await sayImg(a, n.sessionId, '');
    assert.equal(r.result.stopReason, 'end_turn'); assert.deepEqual(m.reqs[2].messages.at(-1).content, [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + PNG } }]);
  } finally { a.stop(); }
  const b = startAgent({ KUAI_BASE_URL: m.url, KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    await b.rpc('initialize', {});
    const sid = fs.readdirSync(dir).find(f => f.endsWith('.json')).replace(/\.json$/, '');
    await b.rpc('session/load', { sessionId: sid, cwd: os.tmpdir() });
    const ups = b.updates.filter(x => x.sessionUpdate === 'user_message_chunk');
    assert.deepEqual(ups.map(x => x.content.type), ['text', 'image', 'text', 'image']);
    assert.equal(ups[1].content.data, PNG); assert.equal(ups[1].content.mimeType, 'image/png');
  } finally { b.stop(); m.srv.close(); }
});

test('kuAi agent：历史里最多带最近 6 张图，更早的换成一句话', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['嗯']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_MODEL: 'mx', KUAI_DIR: dir, KUAI_BUDGET: '100000' });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await sayImg(a, n.sessionId, '一', 3); await sayImg(a, n.sessionId, '二', 3); await sayImg(a, n.sessionId, '三', 2);
    const ms = m.reqs[2].messages, imgs = x => Array.isArray(x.content) ? x.content.filter(p => p.type === 'image_url').length : 0;
    assert.deepEqual(ms.filter(x => x.role === 'user').map(imgs), [1, 3, 2]);
    assert.match(ms[1].content.find(p => p.type === 'text').text, /^\[这里原来有 2 张图，这次没再发给你\]\n一$/);
  } finally { a.stop(); m.srv.close(); }
});

for (const kind of ['anthropic', 'gemini']) test('kuAi agent：' + kind + ' 接口发图的写法', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeNative(kind);
  const a = startAgent({ KUAI_FORMAT: kind, KUAI_BASE_URL: kind === 'gemini' ? m.url + '/v1beta' : m.url, KUAI_API_KEY: 'sk-test', KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await sayImg(a, n.sessionId, '看图');
    await sayImg(a, n.sessionId, '');
    const b0 = m.reqs[0].body, b1 = m.reqs[1].body;
    if (kind === 'anthropic') {
      assert.deepEqual(b0.messages[0].content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, { type: 'text', text: '看图' }]);
      assert.deepEqual(b1.messages.at(-1).content, [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }]);   // 只有图：不带空的文字块
      assert.equal(b1.messages[1].role, 'assistant'); assert.equal(typeof b1.messages[1].content, 'string');
    } else {
      assert.deepEqual(b0.contents[0].parts, [{ inline_data: { mime_type: 'image/png', data: PNG } }, { text: '看图' }]);
      assert.deepEqual(b1.contents.at(-1).parts, [{ inline_data: { mime_type: 'image/png', data: PNG } }]);
    }
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi agent：带图被服务拒了（400）——报错里说明可能是模型不收图', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'unknown variant `image_url`, expected `text`' } })); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const a = startAgent({ KUAI_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', KUAI_MODEL: 'mx', KUAI_DIR: dir });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await sayImg(a, n.sessionId, '看图');
    assert.match(r.error.message, /unknown variant `image_url`.*这次带了图：这个模型可能不收图片/);
  } finally { a.stop(); srv.close(); }
});

test('kuAi agent：命令放进标明语言的代码块；按网页带来的设备给命令（电脑按系统给、手机和不知道的先问电脑系统）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['一', '二', '三', '四']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'q1', KUAI_MODEL: 'q1' });
  const ask = (sid, text, device) => a.rpc('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }], ...(device ? { _meta: { device } } : {}) });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await ask(n.sessionId, '怎么看 IP', 'windows');
    await ask(n.sessionId, '怎么看 IP', 'iphone');
    await ask(n.sessionId, '怎么看 IP');
    await ask(n.sessionId, '怎么看 IP', 'nokia');
    const sys = m.reqs.map(q => q.messages[0].content);
    assert.match(sys[0], /标明语言的代码块.*一行一条/);
    assert.match(sys[0], /Windows 电脑.*PowerShell/);
    assert.match(sys[1], /iPhone.*才先问一句/);
    assert.doesNotMatch(sys[2], /设备|先问/);          // 不知道设备：不写
    assert.doesNotMatch(sys[3], /nokia|设备/);         // 认不得的设备名不写进提示词
    assert.ok(sys.every(x => x.length < 360));
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi 会话走哪家：记过的优先；没记过按会话的模型在模型库里找（默认那家有就用默认那家）；都对不上走默认那家', () => {
  const l = lib(store);
  assert.equal(sessionPid({ provider: 'deepseek', sessions: { a: 'ollama' } }, store, 'a', 'm1', l), 'ollama');
  assert.equal(sessionPid({ provider: 'deepseek', sessions: { a: 'gone' } }, store, 'a', 'q2', l), 'ollama');   // 记的那家没了：按模型认
  assert.equal(sessionPid({ provider: 'deepseek' }, store, 'b', 'm1', l), 'deepseek');
  assert.equal(sessionPid({ provider: 'deepseek' }, store, 'b', 'xx', l), 'deepseek');
  assert.equal(sessionPid({}, store, 'b', '', l), 'ollama');                                                    // 没记过默认：本机的排前
});

test('kuAi：不同会话同时用不同家的模型——每家一个进程，换供应商只换这一个会话，别的会话照常', { timeout: 30000 }, async () => {
  const D = process.env.CLACLAW_DATA, A = await fakeModel(['A 家回答']), B = await fakeModel(['B 家回答']);
  fs.writeFileSync(path.join(D, 'models.json'), JSON.stringify({ providers: [P('pa', A.url, ['a1', 'a2']), P('pb', B.url, ['b1'])].map((p, i) => ({ ...p, id: ['pa', 'pb'][i] })) }));
  const ev = [], ws = { readyState: 1, send: x => ev.push(JSON.parse(x)) };
  const done = id => ev.filter(e => e.t === 'turn.done' && e.sessionId === id).length;
  const until = async f => { for (let i = 0; i < 500 && !f(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(f(), '等不到：' + f); };
  try {
    const r1 = await kuNewSession(os.tmpdir(), {}), r2 = await kuNewSession(os.tmpdir(), {});
    r1.subscribe(ws); r2.subscribe(ws);
    assert.equal(r1.pid, 'pa'); assert.equal(r2.pid, 'pa');
    await r2.pickModel('lib:pb/b1');                                   // r2 换到 B 家
    assert.equal(r2.pid, 'pb'); assert.notEqual(r1.agent, r2.agent);
    assert.equal(r1.attached, true, 'r1 不受影响');
    await r1.pickModel('lib:pa/a2');
    r1.send('问 1'); r2.send('问 2');                                    // 同时问
    await until(() => done(r1.id) && done(r2.id));
    assert.deepEqual(A.reqs.map(q => q.model), ['a2']); assert.deepEqual(B.reqs.map(q => q.model), ['b1']);
    const route = JSON.parse(fs.readFileSync(path.join(D, 'kuai-route.json'), 'utf8'));
    assert.equal(route.sessions[r2.sid], 'pb'); assert.equal(route.sessions[r1.sid], 'pa'); assert.equal(route.provider, 'pa');   // 最近选的那家是新会话默认的
    // 关掉重开：按记下的那家接上，历史还在
    const sid2 = r2.sid; r2.unsubscribe(ws); r1.unsubscribe(ws);
    await new Promise(r => setTimeout(r, 200));
    const again = new KuRunner('ku:' + sid2, { info: { cwd: os.tmpdir() } });
    kuRunners.set(again.id, again); again.subscribe(ws);
    assert.equal(again.pid, 'pb');
    await again.attach();
    assert.deepEqual(again.items.map(x => x.kind === 'user' ? x.text : null).filter(Boolean), ['问 2']);
    again.unsubscribe(ws);
  } finally { await kuShutdown(); A.srv.close(); B.srv.close(); }
});

// 假技能目录：claw-echo 把参数原样输出成一个 tv 代码块；claw-file 在清单里但 kuAi 不给；claw-nojs 没有命令脚本
function fakeSkills() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-skills-'));
  fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify([{ name: 'claw-echo' }, { name: 'claw-file' }, { name: 'claw-nojs' }]));
  for (const n of ['echo', 'file', 'nojs']) {
    fs.mkdirSync(path.join(d, 'claw-' + n));
    fs.writeFileSync(path.join(d, 'claw-' + n, 'SKILL.md'), `---\nname: claw-${n}\ndescription: ${n} 技能：用户说「回声」时使用。\n---\n\n# ${n}\n\n用法：~/.claclaw/bin/claw-${n} "词"，输出原样贴。\n`);
    if (n !== 'nojs') fs.writeFileSync(path.join(d, 'claw-' + n, n + '.mjs'), 'const a = process.argv.slice(2); if (a[0] === "fail") { console.error("坏了"); process.exit(2); } console.log("```tv\\n" + JSON.stringify(a) + "\\n```");');
  }
  return d;
}
const toolsOf = ups => ups.filter(u => /^tool_call/.test(u.sessionUpdate));

test('kuAi 技能：能力够的模型拿到技能清单；写 claw 代码块 → 先读说明、再跑命令，结果交回模型接着答；代码块不显示，网页上是工具卡片', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), sk = fakeSkills();
  const m = await fakeModel(['我查一下。\n```claw\nread claw-echo\n```', '```claw\n~/.claclaw/bin/claw-echo "四川 卫视" x\n```\n', '四川卫视：\n```tv\n["四川 卫视","x"]\n```']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'gemma-4-31b-it', KUAI_MODEL: 'gemma-4-31b-it', KUAI_SKILLS_DIR: sk });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, '看四川卫视');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(m.reqs.length, 3);
    const sys = m.reqs[0].messages[0].content;
    assert.match(sys, /- claw-echo：echo 技能：用户说「回声」时使用。/);
    assert.doesNotMatch(sys, /claw-file|claw-nojs/);                         // 发文件不给、没脚本的不给
    assert.match(sys, /不能操作用户的电脑（下面的技能除外）/);
    const r2 = m.reqs[1].messages, r3 = m.reqs[2].messages;
    assert.equal(r2.at(-2).role, 'assistant'); assert.match(r2.at(-2).content, /```claw\nread claw-echo/);
    assert.match(r2.at(-1).content, /^\[技能结果\]\n\$ read claw-echo\n# echo\n\n用法：claw-echo "词"/);   // 说明里的 ~/.claclaw/bin/ 去掉
    assert.match(r3.at(-1).content, /\$ ~\/\.claclaw\/bin\/claw-echo "四川 卫视" x\n```tv\n\["四川 卫视","x"\]\n```/);   // 参数按引号拆、不经 shell
    const shown = textOf(a.updates);
    assert.equal(shown, '我查一下。\n\n四川卫视：\n```tv\n["四川 卫视","x"]\n```');
    const tc = toolsOf(a.updates);
    assert.deepEqual(tc.map(u => [u.sessionUpdate, u.kind || '', u.status]), [['tool_call', 'read', 'in_progress'], ['tool_call_update', '', 'completed'], ['tool_call', 'execute', 'in_progress'], ['tool_call_update', '', 'completed']]);
    assert.equal(tc[2].title, 'claw-echo');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8'));
    assert.equal(saved.messages.at(-1).content, shown);                    // 存下的是用户看到的（下一轮模型看得到贴出来的结果）
    assert.equal(saved.messages.at(-2).run.steps, 2);
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi 技能：本机小模型（不到 7B）不给技能，claw 代码块照普通文字显示；没有的技能、命令失败都告诉模型', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), sk = fakeSkills();
  const m = await fakeModel(['```claw\nclaw-nope x\nclaw-echo fail\n```', '没找到。']);
  const small = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'qwen3:1.7b', KUAI_MODEL: 'qwen3:1.7b', KUAI_SKILLS_DIR: sk });
  try {
    await small.rpc('initialize', {});
    const n = (await small.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(small, n.sessionId, '回声');
    assert.doesNotMatch(m.reqs[0].messages[0].content, /claw-echo|技能/);
    assert.equal(m.reqs.length, 1);
    assert.match(textOf(small.updates), /```claw\nclaw-nope x/);
    assert.equal(toolsOf(small.updates).length, 0);
  } finally { small.stop(); }
  const big = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'deepseek-v4-pro', KUAI_MODEL: 'deepseek-v4-pro', KUAI_SKILLS_DIR: sk });
  try {
    await big.rpc('initialize', {});
    const n = (await big.rpc('session/new', { cwd: os.tmpdir() })).result;
    m.reqs.length = 0;
    await say(big, n.sessionId, '回声');
    assert.equal(m.reqs.length, 2);
    const res = m.reqs[1].messages.at(-1).content;
    assert.match(res, /\$ claw-nope x\n没有这个技能：claw-nope。能用的：claw-echo/);
    assert.match(res, /\$ claw-echo fail\n（没有输出）|\$ claw-echo fail\n\n（退出码 2：坏了）/);
    assert.match(res, /\[claw-echo 的说明（你没读过，照里面的「怎么回复」回复）\]\n# echo/);   // 没读就跑：附上说明
    assert.deepEqual(toolsOf(big.updates).filter(u => u.sessionUpdate === 'tool_call_update').map(u => u.status), ['failed', 'failed']);
    assert.equal(textOf(big.updates), '没找到。');
  } finally { big.stop(); m.srv.close(); }
});

test('kuAi：设备只在知道时写一句，而且写明要给命令时才用', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['好']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'q1', KUAI_MODEL: 'q1' });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await a.rpc('session/prompt', { sessionId: n.sessionId, prompt: [{ type: 'text', text: '测试' }] });
    await a.rpc('session/prompt', { sessionId: n.sessionId, prompt: [{ type: 'text', text: '测试' }], _meta: { device: 'iphone' } });
    assert.doesNotMatch(m.reqs[0].messages[0].content, /设备|先问/);
    assert.match(m.reqs[1].messages[0].content, /iPhone.*只有要给电脑命令、又不知道电脑是什么系统时，才先问一句/);
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi 技能：OpenAI 格式用原生工具调用（声明 claw 工具，tool_calls 拼参数），结果按 tool_call_id 发回；接口不收工具就退回 claw 代码块', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), sk = fakeSkills(), reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      const j = JSON.parse(b); reqs.push(j);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const w = o => res.write('data: ' + JSON.stringify(o) + '\n\n');
      if (reqs.length === 1) {
        w({ choices: [{ delta: { content: '稍等。' } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'claw', arguments: '' } }] } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"commands":["claw-ec' } }] } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ho \\"a b\\""]}' } }] }, finish_reason: 'tool_calls' }] });
      } else w({ choices: [{ delta: { content: '好了' }, finish_reason: 'stop' }] });
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const a = startAgent({ KUAI_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', KUAI_DIR: dir, KUAI_MODELS: 'deepseek-flash', KUAI_MODEL: 'deepseek-flash', KUAI_SKILLS_DIR: sk });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await say(a, n.sessionId, '回声 a b');
    assert.equal(reqs.length, 2);
    assert.equal(reqs[0].tools[0].function.name, 'claw');
    assert.match(reqs[0].messages[0].content, /要用技能时调用 claw 工具/);
    const [as, tool] = reqs[1].messages.slice(-2);
    assert.deepEqual(as.tool_calls, [{ id: 'call_1', type: 'function', function: { name: 'claw', arguments: JSON.stringify({ commands: ['claw-echo "a b"'] }) } }]);
    assert.equal(as.content, '稍等。');
    assert.equal(tool.role, 'tool'); assert.equal(tool.tool_call_id, 'call_1');
    assert.match(tool.content, /\$ claw-echo "a b"\n```tv\n\["a b"\]\n```/);
    assert.equal(textOf(a.updates), '稍等。\n\n好了');
  } finally { a.stop(); srv.close(); }
});

test('kuAi：去掉调参重试时撞上 503（服务忙）：报这次的原话，调参不收照样记下', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), reqs = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', d => b += d); req.on('end', () => {
      reqs.push(JSON.parse(b));
      if (reqs.length === 1) { res.writeHead(400, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: { message: 'Thinking budget is not supported for this model.' } })); }
      res.writeHead(503, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const a = startAgent({ KUAI_BASE_URL: 'http://127.0.0.1:' + srv.address().port + '/v1', KUAI_DIR: dir, KUAI_MODELS: 'q1', KUAI_MODEL: 'q1' });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    const r = await say(a, n.sessionId, '你好');
    assert.match(r.error.message, /503：This model is currently experiencing high demand/);
    assert.ok('temperature' in reqs[0] && !('temperature' in reqs[1]));
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, n.sessionId + '.json'), 'utf8')).plain, true);
  } finally { a.stop(); srv.close(); }
});

// 假的主目录：普通文件、隐藏目录、Library；PATH 前面放一个假的 date（打印环境变量，看 API Key 带没带过去）
function fakeHome() {
  const h = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-home-')));
  fs.mkdirSync(path.join(h, 'Desktop')); fs.mkdirSync(path.join(h, '.hidden')); fs.mkdirSync(path.join(h, 'Library')); fs.mkdirSync(path.join(h, 'bin'));
  for (const f of ['Desktop/a.png', 'Desktop/b.png', 'Desktop/.c.png', '.hidden/k', 'Library/x', 'notes.txt']) fs.writeFileSync(path.join(h, f), f === 'notes.txt' ? '记一笔\n' : 'x');
  fs.symlinkSync(path.join(h, '.hidden'), path.join(h, 'link'));
  fs.writeFileSync(path.join(h, 'bin', 'date'), '#!/bin/sh\nenv\n', { mode: 0o755 });
  return h;
}

test('kuAi 简单命令：清单里只读的直接跑（不经 shell，~ 和通配符这边展开，不带隐藏文件）；隐藏 / Library / 链接到隐藏的不碰；管道、清单外、grep -r 不跑；有动静的要确认；不带 API Key', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), h = fakeHome();
  const m = await fakeModel([
    '我看看。\n```claw\nls ~/Desktop/*.png\ncat ~/.hidden/k\nls | wc -l\n```',
    '```claw\nrm -rf ~/Desktop\ngrep -rn x ~\ncat link/k\n```',
    '```claw\nmkdir ~/newdir\ntouch ~/t.txt\n$ cat notes.txt\n```',
    '```claw\ndate\ncat ~/Library/x\n```',
    '看完了。']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'gemma-4-31b-it', KUAI_MODEL: 'gemma-4-31b-it', KUAI_CMDS: '1', HOME: h, KUAI_API_KEY: 'sk-test-secret', PATH: path.join(h, 'bin') + ':' + process.env.PATH },
    p => /^mkdir/.test(p.toolCall.rawInput.command) ? 'allow' : 'reject');
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: h })).result;
    const r = await say(a, n.sessionId, '看看桌面');
    assert.equal(r.result.stopReason, 'end_turn');
    assert.equal(m.reqs.length, 5);
    const sys = m.reqs[0].messages[0].content;
    assert.match(sys, /不能操作用户的电脑（下面的简单命令除外）/);
    assert.match(sys, /简单命令：date cal .* 直接跑；open mkdir touch cp mv say 要用户在网页上点确认/);
    assert.match(sys, /不经 shell：不能用管道、重定向、cd（~ 和通配符可以用）。命令在主目录 ~ 里跑，相对路径从这里算；隐藏文件、~\/Library 不能碰。/);
    const res = i => m.reqs[i].messages.at(-1).content;
    assert.equal(res(1).split('\n\n')[0], '[命令结果]\n$ ls ~/Desktop/*.png\n' + h + '/Desktop/a.png\n' + h + '/Desktop/b.png');   // 展开不带 .c.png
    assert.match(res(1), /\$ cat ~\/\.hidden\/k\n没跑：~\/\.hidden\/k 是隐藏的目录 \/ 文件，不能碰。/);
    assert.match(res(1), /\$ ls \| wc -l\n没跑：不经 shell/);
    assert.match(res(1), /接着回答用户；还要跑命令就再调用 claw 工具。$/);
    assert.match(res(2), /\$ rm -rf ~\/Desktop\n这条命令跑不了：rm 不在简单命令清单里/);
    assert.match(res(2), /\$ grep -rn x ~\n没跑：grep 不能搜整个目录/);
    assert.match(res(2), /\$ cat link\/k\n没跑：link\/k 是隐藏的目录 \/ 文件，不能碰。/);   // 链接按真实位置算
    assert.match(res(4), /\$ cat ~\/Library\/x\n没跑：~\/Library\/x 所在的目录不能碰/);
    assert.ok(fs.existsSync(path.join(h, 'Desktop')));
    assert.deepEqual(a.asks.map(x => [x.toolCall.title, x.toolCall.kind, x.toolCall.rawInput.command]), [['Bash', 'execute', 'mkdir ~/newdir'], ['Bash', 'execute', 'touch ~/t.txt']]);
    assert.ok(fs.statSync(path.join(h, 'newdir')).isDirectory());
    assert.ok(!fs.existsSync(path.join(h, 't.txt')));
    assert.match(res(3), /\$ touch ~\/t\.txt\n用户没有允许跑这条命令。/);
    assert.match(res(3), /\$ cat notes\.txt\n记一笔/);
    assert.match(res(4), new RegExp('HOME=' + h));
    assert.doesNotMatch(res(4), /sk-test-secret|KUAI_/);
    assert.equal(textOf(a.updates), '我看看。\n\n看完了。');
    const tc = toolsOf(a.updates).filter(u => u.sessionUpdate === 'tool_call');
    assert.equal(tc.length, 11);
    assert.ok(tc.every(u => u.title === 'Bash' && u.kind === 'execute'));
  } finally { a.stop(); m.srv.close(); }
});

test('kuAi 简单命令：协同 / 群里别人转来的那一轮（_meta.peer）每条都要确认；小模型不给命令；关掉（KUAI_CMDS=0）就不提', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-'));
  const m = await fakeModel(['```claw\necho 你好\n```', '好。', '```claw\necho 你好\n```', '好。']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'deepseek-flash', KUAI_MODEL: 'deepseek-flash', KUAI_CMDS: '1' }, () => 'reject');
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: os.tmpdir() })).result;
    await a.rpc('session/prompt', { sessionId: n.sessionId, prompt: [{ type: 'text', text: '打个招呼' }], _meta: { peer: true } });
    assert.equal(a.asks.length, 1);
    assert.match(m.reqs[1].messages.at(-1).content, /\$ echo 你好\n用户没有允许/);
    assert.match(m.reqs[0].messages[0].content, /要用简单命令时调用 claw 工具。命令照常写/);
    assert.equal(m.reqs[0].tools[0].function.name, 'claw');
    await say(a, n.sessionId, '再打个招呼');                         // 用户自己发的：只读的直接跑
    assert.equal(a.asks.length, 1);
    assert.match(m.reqs[3].messages.at(-1).content, /\$ echo 你好\n你好\n/);
  } finally { a.stop(); m.srv.close(); }
  const m2 = await fakeModel(['好。']);
  const small = startAgent({ KUAI_BASE_URL: m2.url, KUAI_DIR: dir, KUAI_MODELS: 'qwen3:4b', KUAI_MODEL: 'qwen3:4b', KUAI_CMDS: '1' });
  const off = startAgent({ KUAI_BASE_URL: m2.url, KUAI_DIR: dir, KUAI_MODELS: 'deepseek-flash', KUAI_MODEL: 'deepseek-flash' });
  try {
    for (const x of [small, off]) {
      await x.rpc('initialize', {});
      await say(x, (await x.rpc('session/new', { cwd: os.tmpdir() })).result.sessionId, '你好');
    }
    assert.ok(m2.reqs.every(q => !/简单命令/.test(q.messages[0].content) && !q.tools));
  } finally { small.stop(); off.stop(); m2.srv.close(); }
});

test('kuAi 简单命令：会话开在小目录里——命令在那个目录里跑、相对路径和通配符从那里算；主目录下目录以外的不碰，系统目录照常；目录里的隐藏文件不碰', { timeout: 20000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sess-')), h = fakeHome(), proj = path.join(h, 'www', 'proj');
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  for (const f of ['README.md', 'NOTES.md', 'src/a.js', '.env']) fs.writeFileSync(path.join(proj, f), f);
  const m = await fakeModel(['```claw\nls\nls *.md\ncat src/a.js\n```', '```claw\ncat ../../notes.txt\ncat ~/Desktop/a.png\ncat .env\n```', '```claw\nls /\n```', '好。']);
  const a = startAgent({ KUAI_BASE_URL: m.url, KUAI_DIR: dir, KUAI_MODELS: 'gemma-4-31b-it', KUAI_MODEL: 'gemma-4-31b-it', KUAI_CMDS: '1', HOME: h });
  try {
    await a.rpc('initialize', {});
    const n = (await a.rpc('session/new', { cwd: proj })).result;
    await say(a, n.sessionId, '看看这个项目');
    assert.match(m.reqs[0].messages[0].content, /命令在会话目录 ~\/www\/proj 里跑，相对路径从这里算；主目录下这个目录以外的文件、隐藏文件不能碰。/);
    const res = i => m.reqs[i].messages.at(-1).content;
    assert.match(res(1), /\$ ls\nNOTES\.md\nREADME\.md\nsrc\n/);
    assert.match(res(1), /\$ ls \*\.md\nNOTES\.md\nREADME\.md\n/);
    assert.match(res(1), /\$ cat src\/a\.js\nsrc\/a\.js/);
    assert.match(res(2), /\$ cat \.\.\/\.\.\/notes\.txt\n没跑：\.\.\/\.\.\/notes\.txt 在会话目录（~\/www\/proj）外面，不能碰。/);
    assert.match(res(2), /\$ cat ~\/Desktop\/a\.png\n没跑：~\/Desktop\/a\.png 在会话目录（~\/www\/proj）外面/);
    assert.match(res(2), /\$ cat \.env\n没跑：\.env 是隐藏的目录/);
    assert.doesNotMatch(res(3), /没跑/);                                   // 系统目录照常
  } finally { a.stop(); m.srv.close(); }
});
