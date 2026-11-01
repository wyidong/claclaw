// 模型库：用户自己买的各家模型，以 Key 为单位登记（Key + 至少一个接口地址必填；备注、ID、模型可不填），存在 data/models.json（600）。
// 一条 = { id, name（供应商：按主地址的域名认，不用填；同一家的地址域名相同，网页上归一组）, label?（备注，区分同一家的几个 Key）, endpoints, key, models }
// 各 Claw 新建会话 / 切模型时从这里选（modelpick.mjs）。
// key：列表接口只给「有没有 key + 后 4 位」，日志里不写；要看完整的 key 得再输一次 claclaw 用户名和密码（server.mjs /api/models/key）。
// 改 key 只能整个替换；key 必填，不能清掉（不用了就删掉这一条）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FORMATS = ['anthropic', 'openai', 'gemini'];   // 一家可能同时有几种接口格式，每种一个地址
const MAX_PROVIDERS = 50, MAX_MODELS = 500, MAX_KEY = 1000;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,119}$/;   // deepseek-v4-pro、gpt-5.1、Qwen/Qwen3-Coder、models/gemini-2.5-flash……

const fail = msg => { const e = new Error(msg); e.user = true; throw e; };
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function emptyStore() { return { version: 1, providers: [] }; }

export function loadStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!j || !Array.isArray(j.providers)) return emptyStore();
    for (const p of j.providers) { const u = Object.values(p?.endpoints || {})[0]; if (u) p.name = providerName(u); }   // 供应商一律按主地址认
    return { version: 1, providers: j.providers };
  } catch { return emptyStore(); }
}

export function saveStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 给网页看的：去掉 key，只留后 4 位
export function publicView(store) {
  return {
    formats: FORMATS,
    providers: store.providers.map(p => ({
      id: p.id, name: p.name, ...(p.label ? { label: p.label } : {}), endpoints: { ...p.endpoints },
      hasKey: !!p.key, keyLast4: p.key ? p.key.slice(-4) : '',
      models: p.models.map(m => ({ ...m })), createdAt: p.createdAt, updatedAt: p.updatedAt,
    })),
  };
}

function cleanUrl(v, fmt) {
  const s = str(v, 300);
  if (!s) return '';
  let u;
  try { u = new URL(s); } catch { fail(fmt + ' 地址不是网址：' + s.slice(0, 60)); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') fail(fmt + ' 地址要以 https:// 或 http:// 开头');
  if (u.username || u.password) fail(fmt + ' 地址里不要带用户名密码，key 填在 key 那一栏');
  if (u.search || u.hash) fail(fmt + ' 地址里不要带 ? 或 # 后面的部分（key 填在 key 那一栏）');
  return s.replace(/\/+$/, '');
}

function slug(name, taken) {
  let base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  if (!base) base = 'p-' + crypto.randomBytes(3).toString('hex');
  let id = base, n = 2;
  while (taken.has(id)) id = base + '-' + n++;
  return id;
}

// 供应商按主地址认：常见的几家写死，其他取域名主体（api.example.com、llm.example.com → Example）
const KNOWN = [
  [/(^|\.)deepseek\.com$/, 'DeepSeek'], [/(^|\.)moonshot\.(cn|ai)$/, 'Moonshot'], [/(^|\.)kimi\.com$/, 'Kimi'],
  [/(^|\.)anthropic\.com$/, 'Anthropic'], [/(^|\.)openai\.com$/, 'OpenAI'], [/(^|\.)googleapis\.com$/, 'Google'],
  [/(^|\.)openrouter\.ai$/, 'OpenRouter'], [/(^|\.)siliconflow\.(cn|com)$/, '硅基流动'], [/(^|\.)(bigmodel\.cn|z\.ai)$/, '智谱'],
  [/(^|\.)aliyuncs\.com$/, '阿里云百炼'], [/(^|\.)volces\.com$/, '火山方舟'], [/(^|\.)minimaxi?\.(com|chat|io)$/, 'MiniMax'],
  [/(^|\.)x\.ai$/, 'xAI'], [/(^|\.)mistral\.ai$/, 'Mistral'], [/(^|\.)groq\.com$/, 'Groq'], [/(^|\.)together\.(ai|xyz)$/, 'Together'],
];
export function providerName(url) {
  let h = '';
  try { h = new URL(url).hostname.toLowerCase(); } catch { return '其他'; }
  for (const [re, n] of KNOWN) if (re.test(h)) return n;
  if (/^[\d.]+$|^\[|^localhost$/.test(h)) return h;
  const parts = h.split('.');
  let i = parts.length - 2;
  if (i > 0 && parts.at(-1).length === 2 && ['com', 'net', 'org', 'co', 'ac', 'gov', 'edu'].includes(parts[i])) i--;   // example.com.cn
  const base = parts[Math.max(0, i)] || h;
  return base.charAt(0).toUpperCase() + base.slice(1);
}

// 给各 Claw 显示的名字：同一家有几个 Key 时带上备注（没备注带 key 后 4 位），选模型时分得清
export function displayName(p, all) {
  if (p.label) return p.name + ' · ' + p.label;
  return all.some(x => x !== p && x.name === p.name) ? p.name + (p.key ? ' …' + p.key.slice(-4) : ' · ' + p.id) : p.name;
}

function savePro(store, b, now) {
  const endpoints = {};   // 按填的顺序存：第一个是主地址
  const given = b.endpoints && typeof b.endpoints === 'object' ? b.endpoints : {};
  for (const f of [...Object.keys(given), ...FORMATS]) {
    if (!FORMATS.includes(f) || endpoints[f]) continue;
    const u = cleanUrl(given[f], f);
    if (u) endpoints[f] = u;
  }
  if (!Object.keys(endpoints).length) fail('至少填一个接口地址');
  const key = str(b.key, MAX_KEY + 1);
  if (key.length > MAX_KEY) fail('Key 太长了（最多 ' + MAX_KEY + ' 个字）');
  if (/\s/.test(key)) fail('key 里不能有空格或换行');
  const p0 = b.orig ? store.providers.find(x => x.id === b.orig) : null;
  if (b.orig && !p0) fail('没有这个 Key（可能已经删了）');
  if (!key && !p0?.key) fail('填 Key');
  const others = store.providers.filter(p => p !== p0);
  const dup = key && others.find(p => p.key === key);
  if (dup) fail('这个 Key 已经加过了（' + displayName(dup, store.providers) + '），别的地址加到它的「更多」里');
  const name = providerName(Object.values(endpoints)[0]);
  const label = str(b.label, 40);
  if (p0) {
    p0.name = name; p0.endpoints = endpoints; p0.updatedAt = now;
    if (label) p0.label = label; else delete p0.label;
    if (key) p0.key = key;
    return p0;
  }
  if (store.providers.length >= MAX_PROVIDERS) fail('Key 太多了（最多 ' + MAX_PROVIDERS + ' 个）');
  let id = str(b.id, 32).toLowerCase();
  if (id) {
    if (!PROVIDER_ID.test(id)) fail('ID 只能用小写字母、数字和 -，最长 32 个字');
    if (store.providers.some(p => p.id === id)) fail('ID「' + id + '」已经有了');
  } else id = slug(name, new Set(store.providers.map(p => p.id)));
  const src = b.copyFrom ? store.providers.find(x => x.id === b.copyFrom) : null;   // 「再加一个这家的 Key」：模型照抄过来
  const p = { id, name, ...(label ? { label } : {}), endpoints, key, models: src ? src.models.map(m => ({ ...m })) : [], createdAt: now, updatedAt: now };
  store.providers.push(p);
  return p;
}

function saveModel(store, b, now) {
  const p = store.providers.find(x => x.id === b.provider);
  if (!p) fail('没有这个 Key（可能已经删了）');
  const id = str(b.id, 120);
  if (!MODEL_ID.test(id)) fail('模型 ID 填调用接口时用的那个名字（字母数字开头，可以有 . - _ / : @ +）');
  if (p.models.some(m => m.id === id && m.id !== b.orig)) fail('这个 Key 下已经有「' + id + '」了');
  const m = { id, name: str(b.name, 60) };
  if (!m.name) delete m.name;
  const ctx = Math.round(Number(b.context));
  if (b.context != null && b.context !== '' && !(ctx >= 1000 && ctx <= 100_000_000)) fail('上下文长度不对（填 token 数，比如 128000）');
  if (ctx >= 1000) m.context = ctx;
  if (b.vision === true) m.vision = true;
  if (b.reasoning === true) m.reasoning = true;
  if (b.orig) {
    const i = p.models.findIndex(x => x.id === b.orig);
    if (i < 0) fail('没有这个模型（可能已经删了）');
    p.models[i] = m;
  } else {
    if (p.models.length >= MAX_MODELS) fail('这个 Key 下模型太多了（最多 ' + MAX_MODELS + ' 个）');
    p.models.push(m);
  }
  p.updatedAt = now;
  return m;
}

// 一次修改：op = provider-save | provider-delete | model-save | model-delete | models-add（从接口读到的模型一次加几个）。
// 原地改 store，返回 { store, saved, removed }（removed：删掉的那一条，调用方拿去备份）；输入不对抛 e.user = true 的错误
export function applyOp(store, b, now = Date.now()) {
  b = b && typeof b === 'object' ? b : {};
  const prov = id => store.providers.find(x => x.id === id) || fail('没有这个 Key（可能已经删了）');
  if (b.op === 'provider-save') return { store, saved: savePro(store, b, now).id };
  if (b.op === 'provider-delete') {
    const [removed] = store.providers.splice(store.providers.indexOf(prov(b.id)), 1);
    return { store, removed };
  }
  if (b.op === 'model-save') return { store, saved: saveModel(store, b, now).id };
  if (b.op === 'models-add') {
    const p = prov(b.provider);
    let n = 0;
    for (const x of (Array.isArray(b.models) ? b.models : []).slice(0, MAX_MODELS)) {
      if (!x || p.models.some(m => m.id === x.id)) continue;
      const ctx = Math.round(Number(x.context));
      saveModel(store, { provider: p.id, id: x.id, name: x.name, context: ctx >= 1000 && ctx <= 100_000_000 ? ctx : '' }, now);
      n++;
    }
    if (!n) fail('没有选要添加的模型');
    return { store, saved: n };
  }
  if (b.op === 'model-delete') {
    const p = prov(b.provider);
    const i = p.models.findIndex(m => m.id === b.id);
    if (i < 0) fail('没有这个模型（可能已经删了）');
    p.models.splice(i, 1);
    p.updatedAt = now;
    return { store };
  }
  fail('不认识的操作');
}

// 查看完整 key（调用方先验过 claclaw 用户名和密码）
export function revealKey(store, id) {
  const p = store.providers.find(x => x.id === id);
  if (!p) fail('没有这个 Key（可能已经删了）');
  if (!p.key) fail('这一条没有保存 Key');
  return p.key;
}

// 从接口读模型列表（不存）：OpenAI 格式 GET /models（再试 /v1/models），Anthropic 格式 GET /v1/models，Gemini 格式 GET /v1beta/models。
// 返回 [{id, name?, context?}]；都读不到抛 e.user 错误。错误信息里不带 key（key 只在请求头里）。
export async function fetchModels(p, { timeout = 8000, fetchImpl = globalThis.fetch } = {}) {
  if (!p?.key) fail('先填 Key');
  const eps = p.endpoints || {}, tries = [];
  if (eps.openai) {
    const h = { authorization: 'Bearer ' + p.key };
    tries.push(['OpenAI', eps.openai + '/models', h]);
    if (!/\/v\d+[a-z]*$/i.test(eps.openai)) tries.push(['OpenAI', eps.openai + '/v1/models', h]);
  }
  if (eps.anthropic) tries.push(['Anthropic', eps.anthropic.replace(/\/v1$/, '') + '/v1/models?limit=1000', { 'x-api-key': p.key, 'anthropic-version': '2023-06-01' }]);
  if (eps.gemini) tries.push(['Gemini', (/\/v1(beta)?$/.test(eps.gemini) ? eps.gemini : eps.gemini + '/v1beta') + '/models?pageSize=1000', { 'x-goog-api-key': p.key }]);
  let last = '';
  for (const [fmt, url, headers] of tries) {
    try {
      const r = await fetchImpl(url, { headers: { accept: 'application/json', ...headers }, redirect: 'error', signal: AbortSignal.timeout(timeout) });
      if (!r.ok) { last = fmt + ' 接口回 ' + r.status; continue; }
      const list = parseModels(await r.json().catch(() => null));
      if (list) return list;
      last = fmt + ' 接口回的不是模型列表';
    } catch (e) { last = fmt + ' 接口连不上' + (e?.name === 'TimeoutError' ? '（超时）' : ''); }
  }
  fail('没读到模型列表（' + (last || '没有接口地址') + '），可以手动添加');
}

export function parseModels(j) {
  const raw = Array.isArray(j?.data) ? j.data : Array.isArray(j?.models) ? j.models : null;
  if (!raw) return null;
  const out = [], seen = new Set();
  for (const m of raw) {
    if (!m || typeof m !== 'object') continue;
    if (Array.isArray(m.supportedGenerationMethods) && !m.supportedGenerationMethods.includes('generateContent')) continue;   // Gemini 的向量模型之类
    const id = String(m.id || m.name || '').replace(/^models\//, '');
    if (!MODEL_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const x = { id };
    const name = str(m.display_name || m.displayName || (m.id && m.name !== m.id ? m.name : ''), 60);
    if (name && name !== id) x.name = name;
    const ctx = Math.round(Number(m.context_length || m.context_window || m.inputTokenLimit || m.max_context_length || 0));
    if (ctx >= 1000 && ctx <= 100_000_000) x.context = ctx;
    out.push(x);
    if (out.length >= MAX_MODELS) break;
  }
  return out;
}
