// 模型库接到各 Claw 的会话里选（dsh / OpenCode / OpenClaw；Claude 会话有自己的选择）：
// - OpenCode：启动 `opencode acp` 时把模型库注入成 OPENCODE_CONFIG_CONTENT（和用户自己的配置合并），供应商 id 加 claclaw- 前缀；
//   key 放在子进程的环境变量里，配置里只写 {env:…}，不落盘
// - dsh / OpenClaw：它们自己已经配了供应商；按「同一个接口地址（host）+ 同一个模型 ID」把它们的模型对上模型库里的那一条
// 选择框的数据统一成 { current, label, groups: [{ name, items: [{ value, label, sub, disabled }] }] }，模型库的组排在前面
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA } from './auth.mjs';
import { loadStore } from './modelstore.mjs';

export const MODELS_FILE = path.join(DATA, 'models.json');
export const storeNow = () => loadStore(MODELS_FILE);
export const STORE_GROUP = '模型库';

export const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return ''; } };

// 某个接口地址 + 模型 ID 在模型库里是哪一条；对不上返回 null
export function storeMatch(store, baseUrl, modelId) {
  const h = hostOf(baseUrl);
  if (!h || !modelId) return null;
  for (const p of store.providers) {
    if (!Object.values(p.endpoints || {}).some(u => hostOf(u) === h)) continue;
    const m = p.models.find(x => x.id === modelId);
    if (m) return { p, m };
  }
  return null;
}

const envName = id => 'CLACLAW_KEY_' + String(id).toUpperCase().replace(/[^A-Z0-9]/g, '_');

// OpenCode 的注入：{ content（OPENCODE_CONFIG_CONTENT，没有可注入的为 null）, env（key）, sig（模型库变了没有） }
// 有 Anthropic 格式地址优先用它（@ai-sdk/anthropic，OpenCode 自带），其次 OpenAI 兼容，再次 Gemini
export function opencodeInject(store) {
  const provider = {}, env = {};
  for (const p of store.providers) {
    const ep = p.endpoints || {};
    if (!p.models.length) continue;
    let npm, baseURL;
    if (ep.anthropic) { npm = '@ai-sdk/anthropic'; baseURL = ep.anthropic.replace(/\/v1$/, '') + '/v1'; }
    else if (ep.openai) { npm = '@ai-sdk/openai-compatible'; baseURL = ep.openai; }
    else if (ep.gemini) { npm = '@ai-sdk/google'; baseURL = ep.gemini; }
    else continue;
    const options = { baseURL };
    if (p.key) { options.apiKey = '{env:' + envName(p.id) + '}'; env[envName(p.id)] = p.key; }
    const models = {};
    for (const m of p.models) {
      models[m.id] = {
        name: m.name || m.id,
        ...(m.context ? { limit: { context: m.context, output: Math.min(65536, m.context) } } : {}),
        ...(m.reasoning ? { reasoning: true } : {}),
        ...(m.vision ? { attachment: true, modalities: { input: ['text', 'image'], output: ['text'] } } : {}),
      };
    }
    provider['claclaw-' + p.id] = { name: p.name, npm, options, models };
  }
  if (!Object.keys(provider).length) return { content: null, env: {}, sig: '' };
  const content = JSON.stringify({ provider });
  const sig = crypto.createHash('sha256').update(content + '\n' + JSON.stringify(env)).digest('hex').slice(0, 16);
  return { content, env, sig };
}

// 把一个 Claw 自己的模型清单分成「模型库」和「<Claw> 自带」两组。
// own：[{ value, label, base（这个模型走的接口地址，对不上可以不给）, id（接口里的模型 ID）}]
// extra：模型库里有、这个 Claw 现在选不了的（灰着显示、写明原因）：[{ value, label, sub, disabled: true }]
export function splitGroups(store, ownName, own, extra = []) {
  const mine = [], rest = [];
  for (const o of own) {
    const hit = o.base ? storeMatch(store, o.base, o.id) : null;
    if (hit) mine.push({ value: o.value, label: hit.m.name || hit.m.id, sub: hit.p.name + ' · ' + hit.m.id });
    else rest.push({ value: o.value, label: o.label, ...(o.sub ? { sub: o.sub } : {}) });
  }
  return [
    ...(mine.length || extra.length ? [{ name: STORE_GROUP, items: [...mine, ...extra] }] : []),
    ...(rest.length ? [{ name: ownName + ' 自带', items: rest }] : []),
  ];
}

// Kimi Code 的注入：kimi 只认 ~/.kimi-code/config.toml 里的供应商，没有内联配置的环境变量。
// 所以把模型库写成 config.toml 里 claclaw- 开头的供应商 / 模型别名（claclaw-<供应商>/<模型 ID>），
// key 不写文件：用 api_key_env 指向 CLACLAW_KEY_<供应商>，claclaw 起 `kimi acp` 时放进环境变量。
// 返回 { tables（要写进 config.toml 的那几段）, aliases（模型别名，按模型库顺序）, env, sig }
// OpenAI 兼容地址优先（kimi 对 DeepSeek 等推理模型的 openai 接法开箱即用），其次 Anthropic，再次 Gemini
const tomlStr = s => JSON.stringify(String(s));
export function kimiInject(store) {
  const out = [], env = {}, aliases = [];
  for (const p of store.providers) {
    const ep = p.endpoints || {};
    if (!p.models.length) continue;
    const [type, base] = ep.openai ? ['openai', ep.openai] : ep.anthropic ? ['anthropic', ep.anthropic] : ep.gemini ? ['google-genai', ep.gemini] : [];
    if (!type) continue;
    const pid = 'claclaw-' + p.id;
    out.push(`[providers.${tomlStr(pid)}]`, `type = ${tomlStr(type)}`, `base_url = ${tomlStr(base)}`);
    if (p.key) { out.push(`api_key_env = ${tomlStr(envName(p.id))}`); env[envName(p.id)] = p.key; }
    out.push('');
    for (const m of p.models) {
      const alias = pid + '/' + m.id;
      const caps = ['tool_use', ...(m.reasoning ? ['thinking'] : []), ...(m.vision ? ['image_in'] : [])];
      out.push(`[models.${tomlStr(alias)}]`, `provider = ${tomlStr(pid)}`, `model = ${tomlStr(m.id)}`,
        `max_context_size = ${Math.max(1, Number(m.context) || 131072)}`, `capabilities = ${JSON.stringify(caps)}`,
        `display_name = ${tomlStr(m.name || m.id)}`, '');
      aliases.push({ alias, provider: p, model: m });
    }
  }
  const tables = out.join('\n');
  const sig = tables ? crypto.createHash('sha256').update(tables + '\n' + JSON.stringify(env)).digest('hex').slice(0, 16) : '';
  return { tables, aliases, env, sig };
}

// 把 config.toml 里原来的 claclaw- 段落换成新的（用户自己的配置原样不动）。
// 段落按表头认：[providers."claclaw-…"]、[providers.claclaw-…]（含 .env 子表）、[models."claclaw-…"]（含 .overrides）。
// 没有 default_model（没登录过、也没配过模型）就设成模型库第一个；原来指向的 claclaw 模型被删了也换掉
const KIMI_MARK = '# —— 以下由 claclaw 按「模型管理」自动生成，改模型请在 claclaw 里改 ——';
export function kimiConfigMerge(text, inj) {
  const lines = String(text || '').split('\n'), keep = [];
  let skip = false;
  for (const l of lines) {
    const h = l.match(/^\s*\[\s*([^\]]+?)\s*\]\s*(#.*)?$/);
    if (h) skip = /^(providers|models)\.("?)claclaw-/.test(h[1]);
    if (!skip && l.trim() !== KIMI_MARK) keep.push(l);
  }
  let body = keep.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
  const dm = body.match(/^default_model\s*=\s*"([^"]*)"\s*$/m);
  const has = a => inj.aliases.some(x => x.alias === a);
  const first = inj.aliases[0]?.alias;
  if (dm && dm[1].startsWith('claclaw-') && !has(dm[1])) body = first ? body.replace(dm[0], 'default_model = ' + tomlStr(first)) : body.replace(dm[0] + '\n', '').replace(dm[0], '');
  else if (!dm && first) {
    // 顶层键要写在第一个表头之前
    const i = body.search(/^[ \t]*\[/m);
    const line = 'default_model = ' + tomlStr(first);
    body = i < 0 ? (body ? body + '\n' : '') + line : (body.slice(0, i).trimEnd() ? body.slice(0, i).trimEnd() + '\n' : '') + line + '\n\n' + body.slice(i);
  }
  return (body ? body.trimEnd() + '\n' : '') + (inj.tables ? '\n' + KIMI_MARK + '\n' + inj.tables.trimEnd() + '\n' : '');
}
