// 模型库：用户自己买的各家模型（供应商、接口地址、key、模型），存在 data/models.json（600）。
// 这一步只管增删改；接到各 Claw 上（新建会话 / 切模型时从这里选）是后面的事，设计见 .data/claclaw-model-management-design.md。
// key 只进不出：网页接口只给「有没有 key + 后 4 位」，日志里也不写；改 key 只能整个替换或清掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const FORMATS = ['anthropic', 'openai', 'gemini'];   // 一家可能同时有几种接口格式，每种一个地址
const MAX_PROVIDERS = 50, MAX_MODELS = 500;
const PROVIDER_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MODEL_ID = /^[A-Za-z0-9][\w.:/@+-]{0,119}$/;   // deepseek-v4-pro、gpt-5.1、Qwen/Qwen3-Coder、models/gemini-2.5-flash……

const fail = msg => { const e = new Error(msg); e.user = true; throw e; };
const str = (v, max) => String(v ?? '').trim().slice(0, max);

export function emptyStore() { return { version: 1, providers: [] }; }

export function loadStore(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return j && Array.isArray(j.providers) ? { version: 1, providers: j.providers } : emptyStore();
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
      id: p.id, name: p.name, endpoints: { ...p.endpoints },
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

function savePro(store, b, now) {
  const name = str(b.name, 40);
  if (!name) fail('填一个名字');
  const endpoints = {};
  for (const f of FORMATS) { const u = cleanUrl(b.endpoints?.[f], f); if (u) endpoints[f] = u; }
  if (!Object.keys(endpoints).length) fail('至少填一个接口地址');
  const key = str(b.key, 400);
  if (/\s/.test(key)) fail('key 里不能有空格或换行');
  const others = store.providers.filter(p => p.id !== b.orig);
  if (others.some(p => p.name === name)) fail('已经有叫「' + name + '」的供应商了');
  if (b.orig) {
    const p = store.providers.find(x => x.id === b.orig);
    if (!p) fail('没有这个供应商（可能已经删了）');
    p.name = name; p.endpoints = endpoints; p.updatedAt = now;
    if (b.clearKey === true) delete p.key;
    else if (key) p.key = key;
    return p;
  }
  if (store.providers.length >= MAX_PROVIDERS) fail('供应商太多了（最多 ' + MAX_PROVIDERS + ' 个）');
  let id = str(b.id, 32).toLowerCase();
  if (id) {
    if (!PROVIDER_ID.test(id)) fail('ID 只能用小写字母、数字和 -，最长 32 个字');
    if (store.providers.some(p => p.id === id)) fail('ID「' + id + '」已经有了');
  } else id = slug(name, new Set(store.providers.map(p => p.id)));
  const p = { id, name, endpoints, ...(key ? { key } : {}), models: [], createdAt: now, updatedAt: now };
  store.providers.push(p);
  return p;
}

function saveModel(store, b, now) {
  const p = store.providers.find(x => x.id === b.provider);
  if (!p) fail('没有这个供应商（可能已经删了）');
  const id = str(b.id, 120);
  if (!MODEL_ID.test(id)) fail('模型 ID 填调用接口时用的那个名字（字母数字开头，可以有 . - _ / : @ +）');
  if (p.models.some(m => m.id === id && m.id !== b.orig)) fail('这个供应商下已经有「' + id + '」了');
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
    if (p.models.length >= MAX_MODELS) fail('这个供应商下模型太多了（最多 ' + MAX_MODELS + ' 个）');
    p.models.push(m);
  }
  p.updatedAt = now;
  return m;
}

// 一次修改：op = provider-save | provider-delete | model-save | model-delete。
// 原地改 store，返回 { store, removed }（removed：删掉的供应商，调用方拿去备份）；输入不对抛 e.user = true 的错误
export function applyOp(store, b, now = Date.now()) {
  b = b && typeof b === 'object' ? b : {};
  if (b.op === 'provider-save') return { store, saved: savePro(store, b, now).id };
  if (b.op === 'provider-delete') {
    const i = store.providers.findIndex(p => p.id === b.id);
    if (i < 0) fail('没有这个供应商（可能已经删了）');
    const [removed] = store.providers.splice(i, 1);
    return { store, removed };
  }
  if (b.op === 'model-save') return { store, saved: saveModel(store, b, now).id };
  if (b.op === 'model-delete') {
    const p = store.providers.find(x => x.id === b.provider);
    if (!p) fail('没有这个供应商（可能已经删了）');
    const i = p.models.findIndex(m => m.id === b.id);
    if (i < 0) fail('没有这个模型（可能已经删了）');
    p.models.splice(i, 1);
    p.updatedAt = now;
    return { store };
  }
  fail('不认识的操作');
}
