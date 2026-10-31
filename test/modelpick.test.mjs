import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeMatch, opencodeInject, splitGroups, hostOf } from '../modelpick.mjs';

const store = { version: 1, providers: [
  { id: 'deepseek', name: 'DeepSeek', endpoints: { anthropic: 'https://api.deepseek.com/anthropic', openai: 'https://api.deepseek.com' }, key: 'sk-ds-1234',
    models: [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', context: 1000000, reasoning: true }, { id: 'deepseek-flash', name: 'DeepSeek Flash', vision: true }] },
  { id: 'kimi', name: 'Kimi', endpoints: { openai: 'https://api.moonshot.cn/v1' }, models: [{ id: 'kimi-k2' }] },
  { id: 'empty', name: 'Empty', endpoints: { openai: 'https://e.example' }, key: 'k', models: [] },
] };

test('按接口地址的 host + 模型 ID 对上模型库', () => {
  assert.equal(hostOf('https://API.deepseek.com/v1'), 'api.deepseek.com');
  assert.equal(storeMatch(store, 'https://api.deepseek.com/v1', 'deepseek-flash').m.name, 'DeepSeek Flash');
  assert.equal(storeMatch(store, 'https://api.deepseek.com', 'deepseek-chat'), null);
  assert.equal(storeMatch(store, 'https://other.example', 'deepseek-flash'), null);
  assert.equal(storeMatch(store, '', 'deepseek-flash'), null);
});

test('OpenCode 注入：claclaw- 前缀、Anthropic 优先、key 只进环境变量、空供应商跳过', () => {
  const r = opencodeInject(store);
  const c = JSON.parse(r.content);
  assert.deepEqual(Object.keys(c.provider), ['claclaw-deepseek', 'claclaw-kimi']);
  const ds = c.provider['claclaw-deepseek'];
  assert.equal(ds.npm, '@ai-sdk/anthropic');
  assert.equal(ds.options.baseURL, 'https://api.deepseek.com/anthropic/v1');
  assert.equal(ds.options.apiKey, '{env:CLACLAW_KEY_DEEPSEEK}');
  assert.ok(!r.content.includes('sk-ds-1234'), '配置里不带 key');
  assert.deepEqual(r.env, { CLACLAW_KEY_DEEPSEEK: 'sk-ds-1234' });
  assert.deepEqual(ds.models['deepseek-v4-pro'], { name: 'DeepSeek V4 Pro', limit: { context: 1000000, output: 65536 }, reasoning: true });
  assert.deepEqual(ds.models['deepseek-flash'].modalities.input, ['text', 'image']);
  const k = c.provider['claclaw-kimi'];
  assert.equal(k.npm, '@ai-sdk/openai-compatible');
  assert.equal(k.options.apiKey, undefined, '没 key 就不写');
  assert.ok(r.sig && r.sig === opencodeInject(store).sig);
  const s2 = structuredClone(store); s2.providers[0].key = 'sk-new';
  assert.notEqual(opencodeInject(s2).sig, r.sig, '换 key 也算变了');
  assert.deepEqual(opencodeInject({ providers: [] }), { content: null, env: {}, sig: '' });
});

test('分组：对上的进「模型库」（用模型库的名字），其余进「<Claw> 自带」；模型库组排前面', () => {
  const g = splitGroups(store, 'dsh', [
    { value: 'a', label: 'deepseek-v4-flash', id: 'deepseek-v4-flash', base: 'https://api.deepseek.com' },
    { value: 'b', label: 'deepseek-v4-pro', id: 'deepseek-v4-pro', base: 'https://api.deepseek.com' },
    { value: 'c', label: 'x', id: 'x' },
  ], [{ value: 'z', label: 'Kimi', sub: '没放行', disabled: true }]);
  assert.deepEqual(g.map(x => x.name), ['模型库', 'dsh 自带']);
  assert.deepEqual(g[0].items, [{ value: 'b', label: 'DeepSeek V4 Pro', sub: 'DeepSeek · deepseek-v4-pro' }, { value: 'z', label: 'Kimi', sub: '没放行', disabled: true }]);
  assert.deepEqual(g[1].items.map(x => x.value), ['a', 'c']);
  assert.deepEqual(splitGroups(store, 'X', [{ value: 'c', label: 'x', id: 'x' }]).map(x => x.name), ['X 自带']);
});
