import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storeMatch, opencodeInject, splitGroups, hostOf, kimiInject, kimiConfigMerge, qwenInject, qwenSettingsMerge } from '../modelpick.mjs';

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

test('Kimi 注入：OpenAI 兼容优先、key 只进环境变量、能力标签、空供应商跳过', () => {
  const inj = kimiInject(store);
  assert.deepEqual(inj.aliases.map(a => a.alias), ['claclaw-deepseek/deepseek-v4-pro', 'claclaw-deepseek/deepseek-flash', 'claclaw-kimi/kimi-k2']);
  assert.match(inj.tables, /\[providers\."claclaw-deepseek"\]\ntype = "openai"\nbase_url = "https:\/\/api\.deepseek\.com"\napi_key_env = "CLACLAW_KEY_DEEPSEEK"/);
  assert.match(inj.tables, /capabilities = \["tool_use","thinking"\]/);
  assert.match(inj.tables, /capabilities = \["tool_use","image_in"\]/);
  assert.ok(!inj.tables.includes(store.providers[0].key));
  assert.deepEqual(inj.env, { CLACLAW_KEY_DEEPSEEK: store.providers[0].key });
  assert.ok(!inj.tables.includes('claclaw-empty'));
  assert.equal(kimiInject({ providers: [] }).sig, '');
});

test('Kimi config.toml 合并：只换 claclaw- 段落、可重复执行、default_model 处理', () => {
  const inj = kimiInject(store), none = kimiInject({ providers: [] });
  const user = 'theme = "dark"\n\n[providers.mine]\ntype = "openai"\n\n[models."mine/x"]\nprovider = "mine"\n';
  const a = kimiConfigMerge(user, inj);
  assert.equal(kimiConfigMerge(a, inj), a);
  assert.match(a, /^theme = "dark"\ndefault_model = "claclaw-deepseek\/deepseek-v4-pro"\n\n\[providers.mine\]/);
  assert.ok(a.includes('[providers.mine]') && a.includes('[models."mine/x"]') && a.includes('theme = "dark"'));
  // 用户自己设了 default_model：不动
  assert.match(kimiConfigMerge('default_model = "mine/x"\n' + user, inj), /^default_model = "mine\/x"$/m);
  // 模型库清空：claclaw 段落和指向它的 default_model 都去掉，用户的原样
  const b = kimiConfigMerge(a, none);
  assert.ok(!b.includes('claclaw-') && !b.includes('default_model'));
  assert.ok(b.includes('[providers.mine]') && b.includes('theme = "dark"'));
  // kimi 重写过文件（表头不带引号、带子表）也认得出
  const c = kimiConfigMerge('[providers.claclaw-old]\ntype = "openai"\n[providers.claclaw-old.env]\nX = "1"\n[models."claclaw-old/m".overrides]\nmax_context_size = 1\n[keep]\na = 1\n', none);
  assert.equal(c, '[keep]\na = 1\n');
});

test('Qwen 注入：按接口类型分组、envKey 指向环境变量、key 不进设置', () => {
  const r = qwenInject(store);
  assert.deepEqual(Object.keys(r.entries), ['openai']);
  const [pro, flash, k2] = r.entries.openai;
  assert.equal(pro.id, 'deepseek-v4-pro'); assert.equal(pro.baseUrl, 'https://api.deepseek.com'); assert.equal(pro.envKey, 'CLACLAW_KEY_DEEPSEEK');
  assert.equal(pro.generationConfig.contextWindowSize, 1000000);
  assert.equal(flash.generationConfig.modalities.image, true);
  assert.equal(k2.envKey, 'CLACLAW_KEY_KIMI');
  const key = store.providers[0].key;
  assert.deepEqual(r.env, { CLACLAW_KEY_DEEPSEEK: key });
  assert.ok(!JSON.stringify(r.entries).includes(key));
  assert.equal(qwenInject({ providers: [] }).sig, '');
});

test('Qwen settings 合并：换掉旧的 claclaw 条目、保留用户的、没选模型时选第一个', () => {
  const inj = qwenInject(store);
  const cur = { theme: 'x', model: { name: 'gone' }, modelProviders: { openai: [{ id: 'mine', envKey: 'MY_KEY' }, { id: 'gone', envKey: 'CLACLAW_KEY_OLD' }], anthropic: [{ id: 'old', envKey: 'CLACLAW_KEY_OLD' }] } };
  const s = qwenSettingsMerge(cur, inj);
  assert.equal(s.theme, 'x');
  assert.deepEqual(s.modelProviders.openai.map(e => e.id), ['mine', 'deepseek-v4-pro', 'deepseek-flash', 'kimi-k2']);
  assert.equal(s.modelProviders.anthropic, undefined);
  assert.equal(s.model.name, 'deepseek-v4-pro'); assert.equal(s.security.auth.selectedType, 'openai');
  // 用户自己选的模型不动
  const s2 = qwenSettingsMerge({ model: { name: 'mine' }, security: { auth: { selectedType: 'anthropic' } } }, inj);
  assert.equal(s2.model.name, 'mine'); assert.equal(s2.security.auth.selectedType, 'anthropic');
  // 模型库清空：claclaw 的条目都拿掉
  const s3 = qwenSettingsMerge(s, qwenInject({ providers: [] }));
  assert.deepEqual(s3.modelProviders.openai.map(e => e.id), ['mine']);
});
test('Qwen settings 合并：模型库清空时不留指向已删模型的 model.name', () => {
  const s = qwenSettingsMerge({}, qwenInject(store));
  const s2 = qwenSettingsMerge(s, qwenInject({ providers: [] }));
  assert.equal(s2.model.name, undefined);
});
