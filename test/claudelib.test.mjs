import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLibPick, claudeLibEnv, claudeLibProviders, noProxyAdd } from '../modelpick.mjs';

test('parseLibPick：lib:<Key id>/<模型>', () => {
  assert.deepEqual(parseLibPick('lib:deepseek/deepseek-v4-pro'), { provider: 'deepseek', model: 'deepseek-v4-pro' });
  assert.deepEqual(parseLibPick('lib:bailian/Qwen/Qwen3-Coder'), { provider: 'bailian', model: 'Qwen/Qwen3-Coder' });
  for (const v of ['opus', 'default', 'lib:', 'lib:Deep/x', 'lib:x/', '', null]) assert.equal(parseLibPick(v), null);
});

test('claudeLibEnv：地址去掉 /v1，别名都指到所选模型', () => {
  const env = claudeLibEnv({ endpoints: { anthropic: 'https://api.x.com/anthropic/v1/' }, key: 'k' }, 'm1');
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.x.com/anthropic');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'k');
  for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) assert.equal(env[k], 'm1');
});

test('claudeLibProviders：只要有 Anthropic 地址、有 Key、有模型的', () => {
  const ps = [
    { id: 'a', endpoints: { anthropic: 'https://a' }, key: 'k', models: [{ id: 'm' }] },
    { id: 'b', endpoints: { openai: 'https://b' }, key: 'k', models: [{ id: 'm' }] },
    { id: 'c', endpoints: { anthropic: 'https://c' }, key: '', models: [{ id: 'm' }] },
    { id: 'd', endpoints: { anthropic: 'https://d' }, key: 'k', models: [] },
  ];
  assert.deepEqual(claudeLibProviders({ providers: ps }).map(p => p.id), ['a']);
});

test('noProxyAdd：开着代理时把那一家加进 NO_PROXY，没开代理不动', () => {
  const e = noProxyAdd({ HTTPS_PROXY: 'http://127.0.0.1:7890', NO_PROXY: 'localhost,127.0.0.1' }, 'https://api.deepseek.com/anthropic');
  assert.equal(e.NO_PROXY, 'localhost,127.0.0.1,api.deepseek.com');
  assert.equal(e.no_proxy, e.NO_PROXY);
  assert.equal(noProxyAdd(e, 'https://api.deepseek.com/anthropic').NO_PROXY, e.NO_PROXY);
  assert.equal(noProxyAdd({ PATH: '/bin' }, 'https://api.deepseek.com').NO_PROXY, undefined);
});
