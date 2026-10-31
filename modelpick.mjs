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
