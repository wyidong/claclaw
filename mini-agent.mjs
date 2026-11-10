#!/usr/bin/env node
// 极简对话 agent（ACP，stdin/stdout 一行一条 JSON-RPC）：只问答，不调工具、不碰这台电脑上的文件和命令。
// 用途：拿模型库里的模型（尤其本地 Ollama）直接答疑，顺便看模型快不快、好不好用。
// - 每轮请求只有一段很短的系统提示 + 对话本身，不带工具定义，首字最快
// - 默认关思考（reasoning_effort=none）；会话设置里可以打开
// - 请求前缀保持不变（Ollama 能复用已处理的部分）；超出预算才一次性丢掉最早的几轮，不做「压缩」那种额外请求
// - 每轮结束在 usage_update 的 _meta.mini 里带上首字耗时、生成速度，claclaw 显示成一行小字
// 环境变量：MINI_FORMAT（接口格式 openai | anthropic | gemini，默认 openai）、MINI_BASE_URL（openai 写到 /v1；anthropic 写到 /v1 之前；gemini 写到 /v1beta）、MINI_API_KEY、MINI_MODELS（逗号分隔）、MINI_MODEL、MINI_DIR（会话目录）、MINI_BUDGET（上下文预算 token）、MINI_MAX_OUT
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const BASE = (process.env.MINI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const KEY = process.env.MINI_API_KEY || 'none';
const FORMAT = ['anthropic', 'gemini'].includes(process.env.MINI_FORMAT) ? process.env.MINI_FORMAT : 'openai';
const MODELS = (process.env.MINI_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_MODEL = process.env.MINI_MODEL || MODELS[0] || 'qwen3:1.7b';
const DIR = process.env.MINI_DIR || path.join(os.homedir(), '.claclaw-mini', 'sessions');
const BUDGET = Math.max(2000, Number(process.env.MINI_BUDGET) || 6000);
const MAX_OUT = Math.max(256, Number(process.env.MINI_MAX_OUT) || 4096);   // 一次回复的 token 上限：小模型偶尔停不下来

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

// ---------- JSON-RPC ----------
const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

// ---------- 会话 ----------
const sessions = new Map();   // id → { id, cwd, model, think, noOff, plain, title, messages, from, abort }
const file = id => path.join(DIR, id + '.json');
const validId = id => /^[A-Za-z0-9_.-]{4,128}$/.test(id);
function save(s) {
  const o = { sessionId: s.id, cwd: s.cwd, model: s.model, think: s.think, noOff: s.noOff, plain: s.plain, title: s.title, from: s.from, messages: s.messages, updatedAt: new Date().toISOString() };
  const tmp = file(s.id) + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o), { mode: 0o600 });
  fs.renameSync(tmp, file(s.id));
}
function open(id, cwd) {
  if (!validId(id)) throw new Error('会话 id 不对');
  let s = sessions.get(id);
  if (s) return s;
  let o = null;
  try { o = JSON.parse(fs.readFileSync(file(id), 'utf8')); } catch {}
  if (!o) throw new Error('找不到这个会话');
  s = { id, cwd: o.cwd || cwd || os.homedir(), model: o.model || DEFAULT_MODEL, think: !!o.think, noOff: !!o.noOff, plain: !!o.plain, title: o.title || '', messages: Array.isArray(o.messages) ? o.messages : [], from: Number(o.from) || 0, abort: null };
  sessions.set(id, s);
  return s;
}
function create(cwd) {
  const id = crypto.randomUUID();
  const s = { id, cwd: cwd || os.homedir(), model: DEFAULT_MODEL, think: false, noOff: false, plain: false, title: '', messages: [], from: 0, abort: null };
  sessions.set(id, s); save(s);
  return s;
}
const configOf = s => [
  { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: s.model, options: (MODELS.includes(s.model) ? MODELS : [s.model, ...MODELS]).map(m => ({ value: m, name: m })) },
  { id: 'effort', name: '思考', category: 'thought_level', type: 'select', currentValue: s.think ? 'on' : 'off', options: [{ value: 'off', name: '关' }, { value: 'on', name: '开' }] },
];

// ---------- 提示词 ----------
// 日期按天变、模型换了才变：前缀照样能复用。写明当前模型：会话中途换了模型，新模型会跟着历史里旧模型的自我介绍说（「我是通义千问」）
const systemOf = s => `你是答疑助手，简洁回答；用户用什么语言就用什么语言。今天是 ${new Date().toLocaleDateString('sv')}。
你不能上网，也不能操作用户的电脑；需要在电脑上动手的事，给出具体命令或步骤让用户自己做。不知道就说不知道。
你现在用的模型是 ${s.model}。对话里更早的回答可能出自别的模型；被问到你是谁、是什么模型时，以这一句为准。`;
// 发给模型的历史：旧版本（还能调工具时）留下的工具标签和工具结果不发；空回复不发；
// 去掉这些后相邻同角色的并成一条（有的接口不收连续两条 user / assistant），开头不能是 assistant
const LEGACY_TOOL = /^\s*<(run|read|write)[\s>]/;
function history(s) {
  const out = [];
  for (const x of s.messages.slice(s.from)) {
    if (x.tool || !x.content || (x.role === 'assistant' && LEGACY_TOOL.test(x.content))) continue;
    const last = out.at(-1);
    if (last?.role === x.role) last.content += '\n\n' + x.content;
    else if (out.length || x.role === 'user') out.push({ role: x.role, content: x.content });
  }
  return out;
}

// token 估算：中文约 1 字 1 token，英文约 3.5 字符 1 token
const tok = t => { let n = 0; for (const c of String(t)) n += c.charCodeAt(0) > 255 ? 1 : 0.29; return Math.ceil(n); };
// 超出预算时一次性丢掉最早的几轮，降到 60%（前缀不再每轮变，Ollama 才能复用缓存）；从用户消息处断开，保证最后一轮完整
// 旧版本（还能调工具时）存下的工具结果也是 role:user，带 tool:true，不能当断点
function trim(s) {
  const m = s.messages, size = from => m.slice(from).reduce((a, x) => a + tok(x.content) + 4, 0) + tok(systemOf(s));
  if (size(s.from) <= BUDGET) return;
  const starts = m.map((x, i) => x.role === 'user' && !x.tool ? i : -1).filter(i => i >= 0);
  for (const i of starts) {
    if (i <= s.from || i === starts.at(-1)) continue;
    s.from = i;
    if (size(i) <= BUDGET * 0.6) break;
  }
}

// ---------- 调模型 ----------
// 有的模型（如 Ollama 的 qwen3:4b，模板里已经替它写了 <think>）关思考时服务端不再分离思考，输出以「思考…</think>回答」的样子混在正文里：
// 只取 </think> 之后的；没写完的 <think> 后面也先不显示。碰到这种模型记下来（noOff），之后不再发 reasoning_effort=none
const clean = full => { const k = full.lastIndexOf('</think>'); return k >= 0 ? full.slice(k + 8).replace(/^\s+/, '') : full.replace(/<think>[\s\S]*$/, ''); };
// 三种接口格式（模型库里一家有几种时，claclaw 按 openai → anthropic → gemini 挑一种传进来）。
// plain：接口不收调参（temperature、关思考那几项，比如 OpenAI 官方的推理模型）回 400 时，去掉重试一次，成了就记下来以后都不发
function reqOf(s) {
  const system = systemOf(s), msgs = history(s), tune = !s.plain;
  if (FORMAT === 'anthropic') return {
    url: BASE + '/v1/messages', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    // 不带 thinking 就是不思考；开思考时不能再带 temperature，max_tokens 要比思考预算大
    body: { model: s.model, stream: true, max_tokens: MAX_OUT, system, messages: msgs,
      ...(tune ? s.think ? { thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: MAX_OUT + 2048 } : { temperature: 0.3 } : {}) },
  };
  if (FORMAT === 'gemini') return {
    url: BASE + '/models/' + encodeURIComponent(String(s.model).replace(/^models\//, '')) + ':streamGenerateContent?alt=sse', headers: { 'x-goog-api-key': KEY },
    body: { systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [{ text: x.content }] })),
      // thinkingBudget 0 = 关思考（关不掉的模型回 400，走 plain）
      generationConfig: { maxOutputTokens: MAX_OUT, ...(tune ? { temperature: 0.3, thinkingConfig: s.think ? { includeThoughts: true } : { thinkingBudget: 0 } } : {}) } },
  };
  return {
    url: BASE + '/chat/completions', headers: { authorization: 'Bearer ' + KEY },
    body: { model: s.model, stream: true, stream_options: { include_usage: true }, max_tokens: MAX_OUT, messages: [{ role: 'system', content: system }, ...msgs],
      ...(tune ? { temperature: 0.3 } : {}),
      ...(s.think || s.noOff || !tune ? {} : { reasoning_effort: 'none' }) },   // noOff：这个模型关不掉思考（见 clean），不发 none，让服务端自己把思考分出去
  };
}
async function post(s, signal) {
  const q = reqOf(s);
  try {
    return await fetch(q.url, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...q.headers }, body: JSON.stringify(q.body) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('连不上模型服务 ' + BASE + (e.cause?.code ? '（' + e.cause.code + '）' : '：' + e.message));
  }
}
// 流里的一条 → { text, thought, usage: { in, out } }（各格式的字段不一样，统一成这个样子）
function pieceOf(j) {
  if (j.error) throw new Error('模型服务出错：' + String(j.error.message || JSON.stringify(j.error)).slice(0, 300));
  if (FORMAT === 'anthropic') {
    if (j.type === 'content_block_delta') return j.delta?.type === 'thinking_delta' ? { thought: true } : { text: j.delta?.text || '' };
    if (j.type === 'message_start') { const u = j.message?.usage || {}; return { usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) } }; }
    if (j.type === 'message_delta' && j.usage) return { usage: { out: j.usage.output_tokens } };
    return {};
  }
  if (FORMAT === 'gemini') {
    const parts = j.candidates?.[0]?.content?.parts || [], u = j.usageMetadata;
    return { text: parts.filter(x => !x.thought).map(x => x.text || '').join(''), thought: parts.some(x => x.thought),
      usage: u ? { in: u.promptTokenCount, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } : null };
  }
  const dl = j.choices?.[0]?.delta;
  return { text: dl?.content || '', thought: !!(dl?.reasoning || dl?.reasoning_content), usage: j.usage ? { in: j.usage.prompt_tokens, out: j.usage.completion_tokens } : null };
}
async function chat(s, signal, onText, onThought) {
  const t0 = Date.now();
  let r = await post(s, signal);
  if (r.status === 400 && !s.plain) {
    const first = await r.text();
    s.plain = true;
    r = await post(s, signal);
    if (!r.ok) { s.plain = false; throw new Error('模型服务返回 400：' + first.slice(0, 300)); }
  }
  if (!r.ok) throw new Error('模型服务返回 ' + r.status + '：' + (await r.text()).slice(0, 300));
  let text = '', tin = 0, tout = 0, buf = '', first = 0;   // first：第一个字（含思考）到达的时刻
  const dec = new TextDecoder();
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line.startsWith('data:')) continue;
      const d = line.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      let j; try { j = JSON.parse(d); } catch { continue; }
      const x = pieceOf(j);
      if (x.usage?.in) tin = x.usage.in;
      if (x.usage?.out) tout = x.usage.out;
      if ((x.text || x.thought) && !first) first = Date.now();
      if (x.thought) onThought();
      if (x.text) { text += x.text; onText(text); }
    }
  }
  const usage = tin || tout ? { prompt_tokens: tin, completion_tokens: tout } : null;
  const end = Date.now(), out = tout, gen = first ? (end - first) / 1000 : 0;   // 输出太短（< 8 tok）算出的速度没意义，不报
  // 生成速度只算第一个字之后的；没有 usage 的服务不报速度（估出来的不准，调试时会误导）
  const stats = { model: s.model, ttft: first ? (first - t0) / 1000 : null, outTokens: out || null, tps: out >= 8 && gen > 0.05 ? out / gen : null, total: (end - t0) / 1000 };
  return { text: clean(text), usage, leaked: text.includes('</think>'), stats };
}

// ---------- 一轮 ----------
async function prompt(s, text) {
  const ac = new AbortController(); s.abort = ac;
  s.messages.push({ role: 'user', content: text });
  if (!s.title) { s.title = text.replace(/\s+/g, ' ').slice(0, 50); update(s.id, { sessionUpdate: 'session_info_update', title: s.title }); }
  try {
    trim(s);
    let sent = 0, cut = false;
    const { text: out, usage, leaked, stats } = await chat(s, ac.signal, raw => {
      const full = clean(raw);
      if (!cut && raw.includes('</think>')) { cut = true; sent = 0; }   // 刚发现思考混在正文里：已经流出去的没法收回，从回答开头重新算
      if (full.length > sent) { update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: full.slice(sent) } }); sent = full.length; }
    }, () => update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }));
    if (leaked && !s.noOff && !s.think) s.noOff = true;
    if (out.length > sent) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: out.slice(sent) } });
    s.messages.push({ role: 'assistant', content: out, model: s.model });
    save(s);
    update(s.id, { sessionUpdate: 'usage_update', used: usage?.prompt_tokens ? usage.prompt_tokens + (usage.completion_tokens || 0) : 0, size: BUDGET, _meta: { mini: stats } });
    return 'end_turn';
  } catch (e) {
    save(s);
    if (e.name === 'AbortError') return 'cancelled';
    throw e;
  } finally { s.abort = null; }
}

// 历史重放（session/load）：只放用户和回复。旧版本存下的工具结果（tool:true）不放
function replay(s) {
  for (const x of s.messages) {
    if (x.role === 'user' && !x.tool) update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: x.content } });
    else if (x.role === 'assistant' && x.content) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: x.content } });
  }
}

// 换模型：noOff / plain 是按模型试出来的，换了就重新试（不然从回 400 的模型换到 Ollama，思考就关不掉了）
function setModel(s, m) { if (m !== s.model) { s.noOff = false; s.plain = false; } s.model = m; }

// ---------- 分发 ----------
const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [] }),
  'session/new': p => { const s = create(p.cwd); return { sessionId: s.id, configOptions: configOf(s) }; },
  'session/load': p => { const s = open(String(p.sessionId), p.cwd); replay(s); return { configOptions: configOf(s) }; },
  'session/close': p => { const s = sessions.get(String(p.sessionId)); s?.abort?.abort(); sessions.delete(String(p.sessionId)); return {}; },
  'session/prompt': async p => {
    const s = open(String(p.sessionId));
    const text = (p.prompt || []).map(b => b?.type === 'text' ? b.text : '').join('').trim();
    if (!text) return { stopReason: 'end_turn' };
    return { stopReason: await prompt(s, text) };
  },
  'session/set_model': p => { const s = open(String(p.sessionId)); setModel(s, String(p.modelId)); save(s); return {}; },
  'session/set_config_option': p => {
    const s = open(String(p.sessionId)), v = String(p.value);
    if (p.configId === 'model') setModel(s, v); else if (p.configId === 'effort') s.think = v === 'on'; else throw new Error('没有这一项：' + p.configId);
    save(s);
    return { configOptions: configOf(s) };
  },
};

let buf = '';
process.stdin.setEncoding('utf8');   // 按 UTF-8 流式解码：中文跨两块数据时不会变乱码
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.method === 'session/cancel') { sessions.get(String(m.params?.sessionId))?.abort?.abort(); continue; }
    if (m.method && m.id != null) {
      Promise.resolve().then(() => { const h = handlers[m.method]; if (!h) throw Object.assign(new Error('method not supported: ' + m.method), { code: -32601 }); return h(m.params || {}); })
        .then(result => send({ id: m.id, result }), e => send({ id: m.id, error: { code: e.code || -32000, message: e.message } }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
