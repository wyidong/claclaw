import { test } from 'node:test';
import assert from 'node:assert/strict';
import { familyOf, sizeOf, parseSize, isLocalHost, profileOf, autoTier, windowTier, tierOf, budgetOf, TIER_NAMES } from '../src/claws/kuai-profiles.mjs';

test('kuAi 画像：按名字认家族和参数量', () => {
  const fam = { 'claude-sonnet-5-5': 'claude', 'gpt-5.1': 'gpt', 'o3-mini': 'gpt', 'gemini-3.6-flash': 'gemini', 'gemma-4-31b-it': 'gemma', 'models/gemma-3-27b-it': 'gemma', 'deepseek-v4-pro': 'deepseek',
    'deepseek-r1-distill-qwen:8b': 'deepseek', 'qwen3:4b': 'qwen', 'Qwen/Qwen3-8B': 'qwen', 'glm-5.3': 'glm', 'kimi-k3': 'kimi', 'MiniMax-M3': 'minimax', 'doubao-seed-2.0-pro': 'doubao',
    'llama3.2:3b': 'llama', 'mistral-small3.2:24b': 'mistral', 'phi4-mini:3.8b': 'phi', 'sophia': '', 'photo-model': '' };
  for (const [m, f] of Object.entries(fam)) assert.equal(familyOf(m), f, m);
  const size = { 'qwen3:1.7b': 1.7, 'gemma-4-31b-it': 31, 'llama3.2:3b': 3, 'qwen2.5-coder:32b-instruct-q4_K_M': 32, 'smollm2:360m': 0.36, 'deepseek-v4-pro': null, 'gpt-5.1': null, 'qwen3:latest': null, 'model-8bit': null };
  for (const [m, n] of Object.entries(size)) assert.equal(sizeOf(m), n, m);
  assert.equal(parseSize('4.0B'), 4); assert.ok(Math.abs(parseSize('999.89M') - 0.99989) < 1e-9); assert.equal(parseSize(''), null); assert.equal(parseSize('big'), null);
  for (const h of ['127.0.0.1:11434', 'localhost:1234', '192.168.1.5:8000', '10.0.0.2', '172.20.1.1', '[::1]:11434', 'mac.local:11434', 'myhost:8080']) assert.equal(isLocalHost(h), true, h);
  for (const h of ['api.deepseek.com', 'generativelanguage.googleapis.com', '172.32.1.1', '8.8.8.8']) assert.equal(isLocalHost(h), false, h);
});

test('kuAi 画像：采样拿不准的不发，开源权重按模型卡；思考的关法按接口和家族', () => {
  // 云上的：采样不发
  for (const [model, host] of [['deepseek-v4-pro', 'api.deepseek.com'], ['gpt-5.1', 'api.openai.com'], ['kimi-k3', 'api.moonshot.cn'], ['some-model', 'openrouter.ai']]) {
    const p = profileOf({ model, format: 'openai', host });
    assert.deepEqual(p.sampling, { off: {}, on: {} }, model);
  }
  // 各家 OpenAI 兼容接口自己的思考开关
  assert.deepEqual(profileOf({ model: 'deepseek-flash', host: 'api.deepseek.com' }).think, { off: { thinking: { type: 'disabled' } }, on: { thinking: { type: 'enabled' } } });
  assert.deepEqual(profileOf({ model: 'qwen-plus', host: 'dashscope.aliyuncs.com' }).think, { off: { enable_thinking: false }, on: { enable_thinking: true } });
  assert.deepEqual(profileOf({ model: 'glm-5.2', host: 'open.bigmodel.cn' }).think.off, { thinking: { type: 'disabled' } });
  assert.equal(profileOf({ model: 'kimi-k3', host: 'api.moonshot.cn' }).think.off, null);            // 一直思考，关不掉：不发
  assert.deepEqual(profileOf({ model: 'kimi-k2.6', host: 'api.moonshot.cn' }).think.off, { thinking: { type: 'disabled' } });
  assert.deepEqual(profileOf({ model: 'MiniMax-M3', host: 'api.minimaxi.com' }).sampling.off, { reasoning_split: true });
  assert.deepEqual(profileOf({ model: 'gpt-5.1', host: 'api.openai.com' }).think, { off: { reasoning_effort: 'none' }, on: {} });
  // 同一个家族的模型放在别家的接口上（Ollama 上的 deepseek-r1）：按通用的写法，不带 DeepSeek 官方接口的字段
  assert.deepEqual(profileOf({ model: 'deepseek-r1:8b', host: '127.0.0.1:11434' }).think.off, { reasoning_effort: 'none' });
  // 自己跑的开源权重：Qwen3 思考 / 不思考各一套，Gemma 1.0 / 0.95
  const q = profileOf({ model: 'qwen3:4b', host: '127.0.0.1:11434' });
  assert.deepEqual(q.sampling, { off: { temperature: 0.7, top_p: 0.8 }, on: { temperature: 0.6, top_p: 0.95 } });
  assert.deepEqual(profileOf({ model: 'gemma3:12b', host: '127.0.0.1:11434' }).sampling.off, { temperature: 1, top_p: 0.95 });
  assert.deepEqual(profileOf({ model: 'qwen-plus', host: 'dashscope.aliyuncs.com' }).sampling.off, {});   // 云上的 Qwen 不替它定
  // gemini 格式：Flash 能关；Pro 关不掉只能压低；Gemma 4 只收 thinkingLevel；Gemma 1–3 没有思考、也不收系统提示
  assert.deepEqual(profileOf({ model: 'gemini-3.6-flash', format: 'gemini' }).think, { off: { thinkingBudget: 0 }, on: { includeThoughts: true } });
  assert.deepEqual(profileOf({ model: 'gemini-2.5-pro', format: 'gemini' }).think.off, { thinkingBudget: 128 });
  assert.deepEqual(profileOf({ model: 'gemini-3.6-pro', format: 'gemini' }).think.off, { thinkingLevel: 'low' });
  assert.deepEqual(profileOf({ model: 'gemma-4-31b-it', format: 'gemini' }).think, { off: { thinkingLevel: 'minimal' }, on: { includeThoughts: true } });
  const g3 = profileOf({ model: 'models/gemma-3-27b-it', format: 'gemini' });
  assert.equal(g3.think.off, null); assert.equal(g3.system, 'user');
  assert.equal(profileOf({ model: 'gemma-4-31b-it', format: 'gemini' }).system, 'system');
  // anthropic 格式：不带 thinking 就是不思考，采样不发
  const c = profileOf({ model: 'claude-sonnet-5-5', format: 'anthropic', host: 'api.anthropic.com' });
  assert.deepEqual(c.sampling, { off: {}, on: {} }); assert.equal(c.think.on.type, 'enabled');
});

test('kuAi 能力档：用户设的 > 自动（参数量 + 家族），再被窗口封顶；自动最多到 L3', () => {
  assert.equal(TIER_NAMES.length, 6);
  const auto = m => autoTier({ model: m }).tier;
  assert.equal(auto('deepseek-v4-pro'), 3); assert.equal(auto('smollm2:360m'), 0); assert.equal(auto('qwen3:1.7b'), 1); assert.equal(auto('qwen3:4b'), 1);
  assert.equal(auto('llama3.1:8b'), 2); assert.equal(auto('qwen3:32b'), 3);
  assert.equal(auto('gemma-4-31b-it'), 2); assert.equal(auto('gemma3:27b'), 2);   // Gemma 多步弱，封在 L2
  // 参数量另外给（Ollama 报的）时不看名字
  assert.equal(autoTier({ model: 'mystery:latest', size: 1.2 }).tier, 0); assert.equal(autoTier({ model: 'mystery:latest' }).tier, 3);
  assert.deepEqual([0, 4096, 8192, 16384, 65536, 200000].map(windowTier), [5, 1, 2, 3, 4, 5]);
  assert.deepEqual(tierOf({ model: 'qwen3:4b' }), { tier: 1, why: '4B', auto: true });
  assert.deepEqual(tierOf({ model: 'qwen3:4b', user: 2 }), { tier: 2, why: '模型库里设的', auto: false });
  assert.equal(tierOf({ model: 'deepseek-v4-pro', user: 0 }).tier, 0);
  assert.equal(tierOf({ model: 'deepseek-v4-pro', user: 5 }).tier, 5);
  assert.deepEqual(tierOf({ model: 'qwen3:4b', user: 2, ctx: 4096 }), { tier: 1, why: '窗口只有 4k', auto: false });
  assert.equal(tierOf({ model: 'llama3.1:8b', ctx: 16384 }).tier, 2);
  assert.equal(tierOf({ model: 'x', user: 9 }).tier, 3);   // 不对的值当没设
});

test('kuAi 上下文预算：窗口够大时不变；窗口小就给回复留一半、对话跟着收紧；窗口是猜的只收紧对话', () => {
  assert.deepEqual(budgetOf({ ctx: 0, budget: 6000, maxOut: 4096 }), { budget: 6000, maxOut: 4096 });
  assert.deepEqual(budgetOf({ ctx: 1048576, budget: 6000, maxOut: 4096 }), { budget: 6000, maxOut: 4096 });
  assert.deepEqual(budgetOf({ ctx: 16384, budget: 6000, maxOut: 4096 }), { budget: 6000, maxOut: 4096 });
  assert.deepEqual(budgetOf({ ctx: 8192, budget: 6000, maxOut: 4096 }), { budget: 3840, maxOut: 4096 });
  assert.deepEqual(budgetOf({ ctx: 4096, budget: 6000, maxOut: 4096 }), { budget: 1792, maxOut: 2048 });
  assert.deepEqual(budgetOf({ ctx: 4096, known: false, budget: 6000, maxOut: 4096 }), { budget: 1792, maxOut: 4096 });
  assert.deepEqual(budgetOf({ ctx: 1024, budget: 6000, maxOut: 4096 }), { budget: 500, maxOut: 512 });
});
