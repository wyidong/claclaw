// kuAi 的模型画像：按模型家族和接口定「怎么发请求」（采样、思考、system 放哪）和能力档的初值。
// 纯函数，不碰磁盘和网络；kuai-agent.mjs 用。规划见 data/PLAN-kuai.md（不进仓库）。
// 原则：拿不准的参数不发（让服务用自己的默认值）；发了被拒（400）由 agent 去掉重试并按模型记下。
// 标了「实测」的是 2026-11 在真实接口上试过的，其余按各家官方文档。

// ---------- 认家族 ----------
// 按模型名认（去掉「供应商/」前缀）；顺序有讲究：gemma 在 gemini 前，deepseek 在 qwen 前（deepseek-r1-distill-qwen）
const FAMILIES = [
  ['claude', /claude/], ['gemma', /gemma/], ['gemini', /gemini/], ['deepseek', /deepseek/], ['qwen', /qwen|qwq/], ['glm', /glm|chatglm/],
  ['kimi', /kimi|moonshot/], ['minimax', /minimax|abab/], ['doubao', /doubao|seed-/], ['llama', /llama/], ['mistral', /mistral|mixtral|magistral|devstral|codestral|ministral/],
  ['phi', /(^|[^a-z])phi-?\d/], ['gpt', /(^|[^a-z])(gpt|o[134]|chatgpt)(?![a-z])/],
];
const baseName = m => String(m || '').toLowerCase().replace(/^.*\//, '');
export const familyOf = model => { const n = baseName(model); return FAMILIES.find(([, re]) => re.test(n))?.[0] || ''; };

// 名字里的参数量（单位 B）：qwen3:1.7b → 1.7、gemma-4-31b-it → 31、smollm2:360m → 0.36；没写的（云上的模型）是 null
export function sizeOf(model) {
  const n = baseName(model);
  const b = /(\d+(?:\.\d+)?)b(?![a-z])/.exec(n); if (b) return Number(b[1]);
  const m = /(?:^|[^a-z0-9.])(\d{2,4})m(?![a-z])/.exec(n); return m ? Number(m[1]) / 1000 : null;
}
// Ollama /api/show 的 details.parameter_size（"4.0B"、"999.89M"）→ B
export function parseSize(v) {
  const x = /^\s*(\d+(?:\.\d+)?)\s*([BMK])\s*$/i.exec(String(v || '')); if (!x) return null;
  return Number(x[1]) * ({ B: 1, M: 1e-3, K: 1e-6 }[x[2].toUpperCase()]);
}
// 本机 / 局域网里的模型服务（Ollama、LM Studio、llama.cpp……）
export const isLocalHost = host => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|localhost(:|$)|\[?::1\]?|[^.:]+(:|$))|\.(local|lan|internal)(:|$)/i.test(String(host || ''));

// ---------- 接口方言（OpenAI 兼容接口里各家自己的思考开关） ----------
const DIALECTS = [
  ['deepseek', /(^|\.)deepseek\.com$/], ['dashscope', /(^|\.)aliyuncs\.com$/], ['glm', /(^|\.)(bigmodel\.cn|z\.ai)$/], ['kimi', /(^|\.)(moonshot\.(cn|ai)|kimi\.com)$/],
  ['minimax', /(^|\.)minimaxi?\.(com|chat|io)$/], ['doubao', /(^|\.)volces\.com$/],
];
const dialectOf = host => { const h = String(host || '').toLowerCase().replace(/:\d+$/, ''); return DIALECTS.find(([, re]) => re.test(h))?.[0] || ''; };

// ---------- 画像 ----------
// 返回：
//   family、dialect
//   sampling: { off, on }      关 / 开思考时各带哪些采样参数（OpenAI 的写法 temperature / top_p；多数是空的 = 不发）
//   think: { off, on }         关 / 开思考时请求里加什么。off 为 null = 这个模型关不掉（或者不知道怎么关），就不发
//                              openai 格式：并进请求体顶层；gemini 格式：generationConfig.thinkingConfig 的内容；anthropic 格式：thinking 字段的内容
//   system: 'system' | 'user'  'user' = 接口不收系统提示（Gemini 接口上的 Gemma 1–3），并进第一条用户消息
//   native: 能不能用接口原生的工具调用（不能的在回复里写 claw 代码块）。OpenAI 格式都按能（不收的回 400 后 agent 自己退回代码块）；
//           Gemini 格式：Gemini 能（实测 2.5-flash、3.6-flash 都调得出来，3.6 回传带签名的调用也不报错），Gemma 没测过，先写代码块；Anthropic 格式还没做
export function profileOf({ model, format = 'openai', host = '' } = {}) {
  const n = baseName(model), family = familyOf(model), dialect = format === 'openai' ? dialectOf(host) : '';
  const open = sizeOf(model) != null || isLocalHost(host);   // 开源权重自己跑的：没有服务商替它定默认采样，按模型卡给
  const p = { family, dialect, sampling: { off: {}, on: {} }, think: { off: null, on: {} }, system: 'system', native: format === 'openai' || (format === 'gemini' && family !== 'gemma') };

  if (format === 'anthropic') {
    // 不带 thinking 就是不思考；采样一律不发（新的 Claude 传非默认值会被拒，开思考时也不能带）
    p.think = { off: {}, on: { type: 'enabled', budget_tokens: 2048 } };
    return p;
  }
  if (format === 'gemini') {
    // 实测：gemini-2.5-flash、3.6-flash 收 thinkingBudget 0；gemma-4 不收（400），收 thinkingLevel minimal（关不干净，只能到最低）
    p.think = family === 'gemma' ? { off: /gemma-?[123](?!\d)/.test(n) ? null : { thinkingLevel: 'minimal' }, on: /gemma-?[123](?!\d)/.test(n) ? {} : { includeThoughts: true } }
      : /gemini-2\.5-pro/.test(n) ? { off: { thinkingBudget: 128 }, on: { includeThoughts: true } }          // 2.5 Pro 关不掉，最少 128
      : /gemini-[3-9][\d.]*-pro/.test(n) ? { off: { thinkingLevel: 'low' }, on: { includeThoughts: true } }  // 3 代起的 Pro 关不掉，最低 low
      : { off: { thinkingBudget: 0 }, on: { includeThoughts: true } };
    if (/gemma-?[123](?!\d)/.test(n)) p.system = 'user';
    return p;
  }
  // openai 格式
  p.think = dialect === 'deepseek' ? { off: { thinking: { type: 'disabled' } }, on: { thinking: { type: 'enabled' } } }     // 实测：disabled 和 reasoning_effort none 都能关
    : dialect === 'dashscope' ? { off: { enable_thinking: false }, on: { enable_thinking: true } }
    : dialect === 'glm' || dialect === 'doubao' ? { off: { thinking: { type: 'disabled' } }, on: { thinking: { type: 'enabled' } } }
    : dialect === 'kimi' ? { off: /k[3-9]/.test(n) ? null : { thinking: { type: 'disabled' } }, on: {} }                    // K3 起一直思考
    : dialect === 'minimax' ? { off: null, on: {} }
    : { off: { reasoning_effort: 'none' }, on: {} };                                                                         // Ollama（实测 qwen3:1.7b）、OpenAI、各家兼容层
  if (dialect === 'minimax') p.sampling = { off: { reasoning_split: true }, on: { reasoning_split: true } };               // 思考拆到 reasoning_content，不混进正文
  if (open) {
    if (family === 'qwen') p.sampling = { off: { temperature: 0.7, top_p: 0.8 }, on: { temperature: 0.6, top_p: 0.95 } };   // Qwen3 模型卡；不能用贪心解码
    else if (family === 'gemma') p.sampling = { off: { temperature: 1, top_p: 0.95 }, on: { temperature: 1, top_p: 0.95 } };
    else if (family === 'mistral' && /small/.test(n)) p.sampling = { off: { temperature: 0.15 }, on: { temperature: 0.15 } };
  }
  return p;
}

// ---------- 提示怎么写（kuai-render.mjs 按这个渲染） ----------
// 'xml'：Claude（官方建议用 XML 标签分段）；'md'：GPT、Gemini、Mistral（Markdown 标题分节，资料用 XML 标签包）；'plain'：短句加空行。
// 不到 7B 的小模型一律 plain（标题和标签对它们是负担）。国产几家没查到官方的说法：
// 实测 DeepSeek（deepseek-flash，2026-11，同样两个跨文件查找的任务各跑一遍）：三种写法都查到了，请求数 plain 3–4、md 3–5、xml 4–7，md 没有更好，就留在实测最多的 plain；别的家族没测过，也先用 plain。
// Gemini（gemini-3.6-flash）用 md 实测能查对；Claude、GPT 这台机器上没有 key，没测过，只是照官方的建议。
const STYLES = { claude: 'xml', gpt: 'md', gemini: 'md', mistral: 'md' };
export function styleOf({ model, size = sizeOf(model) } = {}) {
  if (size != null && size < 7) return 'plain';
  return STYLES[familyOf(model)] || 'plain';
}

// ---------- 能力档 ----------
// L0 问答 · L1 填空（程序认意图、模型只填参数）· L2 单工具（技能 + 白名单命令）· L3 只读多步 · L4 动手 · L5 规划
// 现在做出来的是 L0–L3：再高的都按 L3 给。
export const TIER_NAMES = ['问答', '填空', '单工具', '只读多步', '动手', '规划'];
export const TIER_AUTO_MAX = 3;   // 自动最多定到 L3，往上要用户在模型库里打开
export const TIER_BUILT = 3;      // 现在做出来的最高一档（再高的都按它给）
// 没有实测（上岗小测验 kuai-quiz.mjs 还没跑过）时按参数量和家族给初值：
//   没写参数量的当云上的模型 → L3；不到 1.5B → L0；不到 7B → L1；不到 24B → L2；再大 → L3。
//   Gemma 多步明显弱（BFCL：Gemma-3-27B 多步 10.8%，不如 Qwen3-4B 的 22%），封在 L2。
//   Qwen3 4B–8B 单步有 86–88%，够 L2，但小模型要等小测验通过才自动放开（本机的模型用过一次后自己在后台测）。
export function autoTier({ model, size = sizeOf(model) } = {}) {
  const family = familyOf(model);
  if (size == null) return { tier: TIER_AUTO_MAX, why: '没写参数量，按云上的模型算' };
  const label = (size < 1 ? Math.round(size * 1000) + 'M' : (Math.round(size * 10) / 10) + 'B');
  let tier = size < 1.5 ? 0 : size < 7 ? 1 : size < 24 ? 2 : 3;
  if (family === 'gemma' && tier > 2) return { tier: 2, why: label + '，Gemma 多步弱' };
  return { tier, why: label };
}
// 窗口允许到哪一档：L2 要 8k，L3 要 16k，L4 要 64k，L5 要 128k；不知道窗口就不限
export const windowTier = ctx => !(ctx > 0) ? 5 : ctx < 8000 ? 1 : ctx < 16000 ? 2 : ctx < 64000 ? 3 : ctx < 128000 ? 4 : 5;
// 档位 = min(能力档, 窗口允许的档)。能力档：用户在模型库里设的 > 小测验测出来的（quiz：{ tier, pass, of }）> 按参数量和家族估的
export function tierOf({ model, size, user, quiz, ctx } = {}) {
  const u = Number.isInteger(user) && user >= 0 && user <= 5 ? user : null;
  const q = quiz && Number.isInteger(quiz.tier) ? { tier: Math.max(0, Math.min(quiz.tier, TIER_AUTO_MAX)), why: '小测验 ' + quiz.pass + '/' + quiz.of } : null;
  const a = u != null ? { tier: u, why: '模型库里设的' } : q || autoTier({ model, size });
  const w = windowTier(ctx);
  return w < a.tier ? { tier: w, why: '窗口只有 ' + Math.round(ctx / 1000) + 'k', auto: u == null } : { ...a, auto: u == null };
}

// ---------- 上下文预算 ----------
// 发给模型的对话上限（budget）和一次回复的上限（maxOut）：窗口知道时给回复留出位置（最多一半），剩下的才是对话的。
// known = false：窗口是猜的（Ollama 没设时默认 4096），只收紧对话，不动回复上限
export function budgetOf({ ctx, known = true, budget, maxOut }) {
  if (!(ctx > 0)) return { budget, maxOut };
  const out = Math.min(maxOut, Math.floor(ctx / 2));
  return { budget: Math.max(500, Math.min(budget, ctx - out - 256)), maxOut: known ? out : maxOut };
}
