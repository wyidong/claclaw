import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { emptyStore, applyOp, publicView, loadStore, saveStore, revealKey, providerName, displayName, parseModels, fetchModels } from '../modelstore.mjs';

const KEY = 'sk-test-0123456789abcdefWXYZ';
const add = (s, b) => applyOp(s, { op: 'provider-save', ...b });
const err = (fn, re) => assert.throws(fn, e => e.user === true && re.test(e.message));

test('Key：新增（供应商按地址认、ID 按供应商生成、同一家几个 Key 加序号）、改地址、key 留空不改 / 整个替换', () => {
  const s = emptyStore();
  assert.equal(add(s, { endpoints: { anthropic: 'https://api.deepseek.com/anthropic/', openai: 'https://api.deepseek.com' }, key: KEY }).saved, 'deepseek');
  assert.equal(s.providers[0].name, 'DeepSeek');
  assert.equal(s.providers[0].endpoints.anthropic, 'https://api.deepseek.com/anthropic');   // 去掉末尾的 /
  assert.deepEqual(Object.keys(s.providers[0].endpoints), ['anthropic', 'openai'], '按填的顺序存，第一个是主地址');
  assert.equal(add(s, { endpoints: { openai: 'https://api.deepseek.com' }, key: 'sk-2', label: '公司' }).saved, 'deepseek-2');
  assert.deepEqual([s.providers[1].name, s.providers[1].label], ['DeepSeek', '公司']);
  assert.match(add(s, { endpoints: { openai: 'https://open.bigmodel.cn/api/paas/v4' }, key: 'sk-3' }).saved, /^p-[0-9a-f]{6}$/, '供应商名里没有字母数字（智谱）：ID 随机');
  add(s, { orig: 'deepseek', name: 'DeepSeek 官方', endpoints: { openai: 'https://api.deepseek.com' }, key: '' });
  assert.equal(s.providers[0].name, 'DeepSeek', '供应商不能手填，按地址认');
  assert.equal(s.providers[0].key, KEY, 'key 留空 = 不改');
  assert.equal(s.providers[0].endpoints.anthropic, undefined, '清空的地址去掉');
  add(s, { orig: 'deepseek', endpoints: { openai: 'https://api.deepseek.com' }, key: 'sk-new-9999', clearKey: true });
  assert.equal(s.providers[0].key, 'sk-new-9999', '换 key；clearKey 不再管用');
  add(s, { orig: 'deepseek', endpoints: { openai: 'https://x.example.com/v1' } });
  assert.equal(s.providers[0].name, 'Example', '换了地址，供应商跟着变');
  add(s, { orig: 'deepseek-2', endpoints: { openai: 'https://api.deepseek.com' }, label: '' });
  assert.equal(s.providers[1].label, undefined, '备注清空就去掉');
});

test('Key：输入检查（Key 和地址必填、Key 不重复）', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: 'k1' });
  err(() => add(s, { endpoints: { openai: 'https://a.example' } }), /填 Key/);
  err(() => add(s, { endpoints: { openai: 'https://a.example' }, key: 'k1' }), /已经加过了（A）/);
  err(() => add(s, { endpoints: { openai: 'https://b.example' }, key: 'k1' }), /已经加过了/);
});

test('Key：地址、ID、key 格式检查', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: 'k1' });
  assert.equal(add(s, { orig: 'a', endpoints: { openai: 'https://a.example' }, key: 'k1' }).saved, 'a', '自己的 key 不算重复');
  const k = { key: 'k2' };
  err(() => add(s, { name: 'B', endpoints: {}, ...k }), /至少填一个/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'ftp://a' }, ...k }), /https/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'https://u:p@a.example' }, ...k }), /用户名密码/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'https://a.example/?key=1' }, ...k }), /\?/);
  err(() => add(s, { name: 'B', endpoints: { openai: '不是网址' }, ...k }), /不是网址/);
  err(() => add(s, { name: 'C', id: 'A B', endpoints: { openai: 'https://b.example' }, ...k }), /小写字母/);
  err(() => add(s, { name: 'C', id: 'a', endpoints: { openai: 'https://b.example' }, ...k }), /已经有/);
  err(() => add(s, { name: 'C', endpoints: { openai: 'https://b.example' }, key: 'sk a' }), /空格/);
  err(() => add(s, { name: 'C', endpoints: { openai: 'https://b.example' }, key: 'x'.repeat(1001) }), /太长/);
  err(() => add(s, { orig: 'nope', name: 'C', endpoints: { openai: 'https://b.example' }, ...k }), /没有这个 Key/);
  err(() => applyOp(s, { op: 'xx' }), /不认识/);
  assert.equal(add(s, { endpoints: { openai: 'https://llm.a.example' }, ...k }).saved, 'a-2', '同一家（域名相同）可以有几个 Key');
  assert.equal(s.providers[1].name, s.providers[0].name);
});

test('供应商名：常见几家写死，其他取域名主体；显示名同一家几个 Key 时带备注或后 4 位', () => {
  assert.equal(providerName('https://api.deepseek.com/anthropic'), 'DeepSeek');
  assert.equal(providerName('https://generativelanguage.googleapis.com/v1beta'), 'Google');
  assert.equal(providerName('https://dashscope.aliyuncs.com/compatible-mode/v1'), '阿里云百炼');
  assert.equal(providerName('https://api.example.com/v1'), 'Example');
  assert.equal(providerName('https://llm.foo.com.cn'), 'Foo');
  assert.equal(providerName('http://127.0.0.1:11434/v1'), '127.0.0.1');
  const a = { id: 'a', name: 'DeepSeek', key: 'sk-aaaa1111' }, b = { id: 'b', name: 'DeepSeek', key: 'sk-bbbb2222', label: '公司' }, c = { id: 'c', name: 'Kimi', key: 'k' };
  assert.deepEqual([a, b, c].map(p => displayName(p, [a, b, c])), ['DeepSeek …1111', 'DeepSeek · 公司', 'Kimi']);
});

test('模型：增、改（可改 ID）、删；同一供应商下 ID 不重复', () => {
  const s = emptyStore();
  add(s, { name: 'DeepSeek', endpoints: { openai: 'https://api.deepseek.com' }, key: KEY });
  const m = b => applyOp(s, { op: 'model-save', provider: 'deepseek', ...b });
  m({ id: 'deepseek-v4-pro', name: 'V4 Pro', context: 1000000, reasoning: true });
  m({ id: 'deepseek-v4-flash', context: '' });
  assert.deepEqual(s.providers[0].models, [{ id: 'deepseek-v4-pro', name: 'V4 Pro', context: 1000000, reasoning: true }, { id: 'deepseek-v4-flash' }]);
  err(() => m({ id: 'deepseek-v4-pro' }), /已经有/);
  err(() => m({ id: 'a b' }), /模型 ID/);
  err(() => m({ id: 'x', context: 12 }), /上下文/);
  m({ orig: 'deepseek-v4-flash', id: 'deepseek-v4-lite', vision: true });
  assert.deepEqual(s.providers[0].models[1], { id: 'deepseek-v4-lite', vision: true });
  err(() => m({ orig: 'deepseek-v4-lite', id: 'deepseek-v4-pro' }), /已经有/);
  m({ id: 'Qwen/Qwen3-Coder-480B' });
  applyOp(s, { op: 'model-delete', provider: 'deepseek', id: 'deepseek-v4-lite' });
  assert.deepEqual(s.providers[0].models.map(x => x.id), ['deepseek-v4-pro', 'Qwen/Qwen3-Coder-480B']);
  err(() => applyOp(s, { op: 'model-delete', provider: 'deepseek', id: 'nope' }), /没有这个模型/);
  err(() => applyOp(s, { op: 'model-save', provider: 'nope', id: 'x' }), /没有这个 Key/);
});

test('删除 Key：返回删掉的（调用方备份）', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: KEY });
  const r = applyOp(s, { op: 'provider-delete', id: 'a' });
  assert.equal(r.removed.key, KEY);
  assert.equal(s.providers.length, 0);
  err(() => applyOp(s, { op: 'provider-delete', id: 'a' }), /没有这个 Key/);
});

test('给网页看的不带 key，只有后 4 位；存盘权限 600', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: KEY });
  s.providers.push({ id: 'b', name: 'B', endpoints: { gemini: 'https://b.example' }, models: [] });   // 老数据：没有 key
  const v = publicView(s);
  assert.ok(!JSON.stringify(v).includes(KEY.slice(0, -4)));
  assert.deepEqual([v.providers[0].hasKey, v.providers[0].keyLast4, v.providers[1].hasKey], [true, 'WXYZ', false]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), f = path.join(dir, 'models.json');
  try {
    saveStore(f, s);
    // Windows 不是 POSIX 权限位：Node 的 mode 只映射「只读」，写得出来的文件一律报 0o666。
    // 那边护住 key 的是 data 目录的 ACL（启动时用 icacls 收紧），不是文件的 600。
    if (process.platform !== 'win32') assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(loadStore(f), s);
    fs.writeFileSync(f, '{坏的');
    assert.deepEqual(loadStore(f), emptyStore());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('看完整 key：revealKey', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: KEY });
  s.providers.push({ id: 'b', name: 'B', endpoints: { openai: 'https://b.example' }, models: [] });
  assert.equal(revealKey(s, 'a'), KEY);
  err(() => revealKey(s, 'b'), /没有保存 Key/);
  err(() => revealKey(s, 'x'), /没有这个 Key/);
});

test('再加一个同家的 Key：copyFrom 把模型抄过来；models-add 一次加几个（跳过已有的）', () => {
  const s = emptyStore();
  add(s, { endpoints: { openai: 'https://api.deepseek.com' }, key: 'k1' });
  applyOp(s, { op: 'model-save', provider: 'deepseek', id: 'deepseek-chat', context: 128000 });
  add(s, { endpoints: { openai: 'https://api.deepseek.com' }, key: 'k2', copyFrom: 'deepseek' });
  assert.deepEqual(s.providers[1].models, [{ id: 'deepseek-chat', context: 128000 }]);
  s.providers[1].models[0].name = 'x';
  assert.equal(s.providers[0].models[0].name, undefined, '抄的是副本');
  const r = applyOp(s, { op: 'models-add', provider: 'deepseek', models: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner', name: 'R1', context: 5 }, { id: 'gpt-x', context: 64000 }] });
  assert.equal(r.saved, 2);
  assert.deepEqual(s.providers[0].models.slice(1), [{ id: 'deepseek-reasoner', name: 'R1' }, { id: 'gpt-x', context: 64000 }], '上下文不对的去掉');
  err(() => applyOp(s, { op: 'models-add', provider: 'deepseek', models: [{ id: 'gpt-x' }] }), /没有选/);
  err(() => applyOp(s, { op: 'models-add', provider: 'deepseek', models: [{ id: 'a b' }] }), /模型 ID/);
});

test('从接口读模型：几种格式的返回、按顺序试、错误信息不带 key', async () => {
  assert.deepEqual(parseModels({ data: [{ id: 'deepseek-chat', object: 'model' }, { id: 'deepseek-chat' }, { id: 'bad id' }, { id: 'or/x', name: 'X 模型', context_length: 200000 }] }),
    [{ id: 'deepseek-chat' }, { id: 'or/x', name: 'X 模型', context: 200000 }]);
  assert.deepEqual(parseModels({ data: [{ id: 'claude-x', display_name: 'Claude X' }] }), [{ id: 'claude-x', name: 'Claude X' }]);
  assert.deepEqual(parseModels({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, thinking: true, supportedGenerationMethods: ['generateContent'] }, { name: 'models/embedding-001', supportedGenerationMethods: ['embedContent'] }] }),
    [{ id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', context: 1048576, reasoning: true }]);
  assert.equal(parseModels({ error: 'x' }), null);
  const seen = [];
  const fake = map => async (url, o) => { seen.push([url, o.headers]); const r = map[url]; if (!r) return { ok: false, status: 404, json: async () => ({}) }; return { ok: true, status: 200, json: async () => r }; };
  const p = { key: KEY, endpoints: { anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com' } };
  const list = await fetchModels(p, { fetchImpl: fake({ 'https://api.deepseek.com/v1/models': { data: [{ id: 'deepseek-chat' }] } }) });
  assert.deepEqual(list, [{ id: 'deepseek-chat' }]);
  assert.deepEqual(seen.map(x => x[0]), ['https://api.deepseek.com/models', 'https://api.deepseek.com/v1/models'], 'OpenAI 格式先试，/models 不行再 /v1/models');
  assert.equal(seen[0][1].authorization, 'Bearer ' + KEY);
  seen.length = 0;
  await fetchModels({ key: KEY, endpoints: { anthropic: 'https://api.anthropic.com' } }, { fetchImpl: fake({ 'https://api.anthropic.com/v1/models?limit=1000': { data: [] } }) });
  assert.equal(seen[0][1]['x-api-key'], KEY);
  await assert.rejects(fetchModels(p, { fetchImpl: fake({}) }), e => e.user && /没读到模型列表（Anthropic 接口回 404）/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(fetchModels(p, { fetchImpl: async () => { throw new Error('boom ' + KEY); } }), e => e.user && /连不上/.test(e.message) && !e.message.includes(KEY));
  await assert.rejects(fetchModels({ endpoints: { openai: 'https://x' } }), /先填 Key/);
});

test('从接口读模型：服务端请求按 HTTP_PROXY / NO_PROXY 走代理（Node 自带 fetch 不读这些变量）', async () => {
  const hits = [];
  const proxy = http.createServer((q, s) => { hits.push(q.url); s.writeHead(200, { 'content-type': 'application/json' }); s.end(JSON.stringify({ data: [{ id: 'via-proxy' }] })); });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const names = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'], old = Object.fromEntries(names.map(k => [k, process.env[k]]));
  try {
    for (const k of names) delete process.env[k];
    process.env.HTTP_PROXY = process.env.http_proxy = 'http://127.0.0.1:' + proxy.address().port;
    assert.deepEqual(await fetchModels({ key: 'k', endpoints: { openai: 'http://models.invalid/v1' } }), [{ id: 'via-proxy' }]);
    assert.equal(hits[0], 'http://models.invalid/v1/models', '经代理发出（.invalid 直连解析不了）');
    process.env.NO_PROXY = process.env.no_proxy = 'models.invalid';
    await assert.rejects(fetchModels({ key: 'k', endpoints: { openai: 'http://models.invalid/v1' } }, { timeout: 3000 }), /连不上/);
    assert.equal(hits.length, 1, 'NO_PROXY 里的不走代理');
  } finally {
    for (const k of names) { if (old[k] == null) delete process.env[k]; else process.env[k] = old[k]; }
    proxy.close();
  }
});
