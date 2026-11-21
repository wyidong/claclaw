#!/usr/bin/env node
// 极简对话 agent（ACP，stdin/stdout 一行一条 JSON-RPC）：问答为主，不碰这台电脑上的文件和任意命令；
// 能力够的模型（名字里的参数量不到 7B 的本机小模型除外）还能用 claclaw 自带的技能（skills/，电视、听歌、视频、换肤……）：
// 模型在回复里写 ```claw 代码块（read 技能名 / 技能命令），这边只认技能清单里的命令，不经 shell 直接用 node 跑技能脚本，结果再交给模型接着答。
// 同样的写法还能跑几条简单命令（date、ls、df、cat……，见 CMDS）：只读的直接跑，open、mkdir 这类要用户在网页上点确认；不经 shell，隐藏文件、~/Library、claclaw 的 data 不碰。
// 用途：拿模型库里的模型（尤其本地 Ollama）直接答疑，顺便看模型快不快、好不好用。
// - 每轮请求只有一段很短的系统提示 + 对话本身，首字最快（技能和命令只有一个 claw 工具）
// - 默认关思考（reasoning_effort=none）；会话设置里可以打开
// - 请求前缀保持不变（Ollama 能复用已处理的部分）；超出预算才一次性丢掉最早的几轮，不做「压缩」那种额外请求
// - 每轮结束在 usage_update 的 _meta.mini 里带上首字耗时、生成速度，claclaw 显示成一行小字
// 环境变量：MINI_FORMAT（接口格式 openai | anthropic | gemini，默认 openai）、MINI_BASE_URL（openai 写到 /v1；anthropic 写到 /v1 之前；gemini 写到 /v1beta）、MINI_API_KEY、MINI_MODELS（逗号分隔）、MINI_MODEL、MINI_DIR（会话目录）、MINI_BUDGET（上下文预算 token）、MINI_MAX_OUT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, tilde, readJson, writeJsonAtomic, hash16 } from '../util.mjs';

const BASE = (process.env.MINI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const KEY = process.env.MINI_API_KEY || 'none';
const FORMAT = ['anthropic', 'gemini'].includes(process.env.MINI_FORMAT) ? process.env.MINI_FORMAT : 'openai';
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
const MODELS = (process.env.MINI_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_MODEL = process.env.MINI_MODEL || MODELS[0] || 'qwen3:1.7b';
const DIR = process.env.MINI_DIR || path.join(HOME, '.claclaw-mini', 'sessions');
const BUDGET = Math.max(2000, Number(process.env.MINI_BUDGET) || 6000);
const MAX_OUT = Math.max(256, Number(process.env.MINI_MAX_OUT) || 4096);   // 一次回复的 token 上限：小模型偶尔停不下来
// 技能：skills/index.json 里登记的、有命令脚本的（找会话、发文件 Mini 用不上，不给）；MINI_SKILLS_DIR 可以改目录（测试用；指到没有的目录就是不给技能）
const SKILLS_DIR = process.env.MINI_SKILLS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const SKILL_SKIP = new Set(['claw-interconnect', 'claw-file']);
const SKILLS = (() => {
  let idx = []; try { idx = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, 'index.json'), 'utf8')); } catch {}
  return (Array.isArray(idx) ? idx : []).filter(x => /^claw-[a-z0-9-]+$/.test(x?.name || '') && !SKILL_SKIP.has(x.name)).map(x => {
    const dir = path.join(SKILLS_DIR, x.name), js = path.join(dir, x.name.slice(5) + '.mjs');
    let md = ''; try { md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch {}
    const desc = String(md.match(/^description:\s*(.+)$/m)?.[1] || x.desc || '').trim();
    return md && fs.existsSync(js) ? { name: x.name, desc, js, md: md.replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
  }).filter(Boolean);
})();
// 简单命令：MINI_CMDS=0 关掉（测试用）
const CMDS_ON = process.env.MINI_CMDS !== '0';
const MAX_STEPS = 4;          // 一轮里最多用几次技能（每次一个 claw 代码块，最多 3 条命令）
const SKILL_MS = 120000;      // 一条技能命令最多跑多久

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

// ---------- JSON-RPC ----------
const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

// ---------- 会话 ----------
const sessions = new Map();   // id → { id, cwd, model, think, noOff, plain, title, messages, from, abort }
const file = id => path.join(DIR, id + '.json');
const validId = id => /^[A-Za-z0-9_.-]{4,128}$/.test(id);
function save(s) {
  writeJsonAtomic(file(s.id), { sessionId: s.id, cwd: s.cwd, model: s.model, think: s.think, noOff: s.noOff, plain: s.plain, title: s.title, from: s.from, messages: s.messages, updatedAt: new Date().toISOString() }, 0);
}
// 内存里的会话：o 是会话文件里存的（新建时为空）
const sessionOf = (id, cwd, o = {}) => ({ id, cwd: o.cwd || cwd || HOME, model: o.model || DEFAULT_MODEL, think: !!o.think, noOff: !!o.noOff, plain: !!o.plain, title: o.title || '', messages: Array.isArray(o.messages) ? o.messages : [], from: Number(o.from) || 0, abort: null });
function open(id, cwd) {
  if (!validId(id)) throw new Error('会话 id 不对');
  let s = sessions.get(id);
  if (s) return s;
  const o = readJson(file(id), null);
  if (!o) throw new Error('找不到这个会话');
  s = sessionOf(id, cwd, o);
  sessions.set(id, s);
  return s;
}
// 图片：存在会话文件旁边的 <id>.files/ 里（按内容取名，同一张只存一份），会话文件里只记 { mime, file }
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const MAX_IMGS = 6, IMG_TOK = 800;   // 发给模型的历史里最多带最近 6 张图；估算上下文时一张图按 800 token 算
const imgDir = id => path.join(DIR, id + '.files');
function saveImg(id, mime, data) {
  const buf = Buffer.from(data, 'base64');
  const name = hash16(buf) + '.' + EXT[mime];
  fs.mkdirSync(imgDir(id), { recursive: true, mode: 0o700 });
  const f = path.join(imgDir(id), name);
  if (!fs.existsSync(f)) fs.writeFileSync(f, buf, { mode: 0o600 });
  return { mime, file: name };
}
const imgCache = new Map();   // 一轮里会读好几次（估算、记录、真正发出去），留最近几张
function readImg(id, im) {
  const f = path.join(imgDir(id), path.basename(String(im?.file || '')));
  if (imgCache.has(f)) return imgCache.get(f);
  let d = null; try { d = fs.readFileSync(f).toString('base64'); } catch {}
  imgCache.set(f, d); if (imgCache.size > MAX_IMGS * 2) imgCache.delete(imgCache.keys().next().value);
  return d;
}
function create(cwd) {
  const s = sessionOf(crypto.randomUUID(), cwd);
  sessions.set(s.id, s); save(s);
  return s;
}
const configOf = s => [
  { id: 'model', name: '模型', category: 'model', type: 'select', currentValue: s.model, options: (MODELS.includes(s.model) ? MODELS : [s.model, ...MODELS]).map(m => ({ value: m, name: m })) },
  { id: 'effort', name: '思考', category: 'thought_level', type: 'select', currentValue: s.think ? 'on' : 'off', options: [{ value: 'off', name: '关' }, { value: 'on', name: '开' }] },
];

// ---------- 提示词 ----------
// 日期按天变、模型换了才变：前缀照样能复用。写明当前模型：会话中途换了模型，新模型会跟着历史里旧模型的自我介绍说（「我是通义千问」）
// 命令要放进标了语言的代码块、一行一条（网页会给每条加复制图标、多条的能下载成脚本）；用户的设备由网页按浏览器判断后随消息带来（s.dev），放在最后，换设备才变。
// 设备那句只在知道时写，并且写明「要给命令时」才用：不知道就不写（小模型会把「先问系统」当成每句话都要说的）
const DEVICES = { mac: 'Mac 电脑', windows: 'Windows 电脑', linux: 'Linux 电脑', chromeos: 'Chromebook', iphone: 'iPhone', ipad: 'iPad', android: '安卓手机 / 平板', harmony: '鸿蒙手机' };
const devLine = d => !DEVICES[d] ? ''
  : /^(iphone|ipad|android|harmony)$/.test(d) ? `\n用户在用${DEVICES[d]}和你对话；只有要给电脑命令、又不知道电脑是什么系统时，才先问一句。`
  : `\n用户在用${DEVICES[d]}和你对话；要给命令时按这个系统给${d === 'windows' ? '（默认 PowerShell）' : ''}，用户说了别的系统就按说的给。`;
// 模型够不够用技能、命令：名字里写了参数量、不到 7B 的（本机小模型）不给——跟不住「先读说明、再写命令、再按结果回复」这几步，清单还拖慢首字
const sizeOf = m => { const x = /(\d+(?:\.\d+)?)b(?![a-z])/i.exec(String(m || '').replace(/^.*\//, '')); return x ? Number(x[1]) : null; };
const bigEnough = s => { const n = sizeOf(s.model); return n == null || n >= 7; };   // 没写参数量的（云上的大模型）算够
const skillsOn = s => SKILLS.length > 0 && bigEnough(s);
const cmdsOn = s => CMDS_ON && bigEnough(s);
const toolsOn = s => skillsOn(s) || cmdsOn(s);
const whatOf = s => skillsOn(s) && cmdsOn(s) ? '技能和简单命令' : skillsOn(s) ? '技能' : '简单命令';
// 怎么调：OpenAI 格式的接口用原生工具调用（声明一个 claw 工具；DeepSeek 这类不声明工具时会把自己的工具调用标记当文字写出来）；
// 别的格式、或者接口不收工具（回 400 后 plain）就在回复里写 claw 代码块。技能和简单命令走同一个工具 / 代码块：以技能名开头的是技能，别的按简单命令认
const nativeOn = s => FORMAT === 'openai' && toolsOn(s) && !s.plain;
const CLAW_TOOL = { type: 'function', function: { name: 'claw', description: '运行 claclaw 技能或简单命令：read 技能名（看它的说明）、技能命令（以技能名开头、不写路径），或者清单里的简单命令；一次最多 3 条',
  parameters: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' }, description: '比如 ["read claw-tv"]、["claw-tv \\"四川卫视\\""]、["df -h"]' } }, required: ['commands'] } } };
const cwdLine = s => { const wd = cwdOf(s); return wd === HOME_REAL ? '命令在主目录 ~ 里跑，相对路径从这里算；隐藏文件、~/Library 不能碰。'
  : `命令在会话目录 ${tilde(wd)} 里跑，相对路径从这里算；主目录下这个目录以外的文件、隐藏文件不能碰。`; };
const OS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform] || process.platform;
const toolsText = s => {
  const sk = skillsOn(s), cm = cmdsOn(s), what = whatOf(s), use = sk && cm ? '要用时' : '要用' + what + '时';
  const how = nativeOn(s)
    ? `${use}调用 claw 工具。` + (sk ? `第一次用某个技能先读它的说明（commands 写 ["read claw-tv"]），读过就照说明写命令（以技能名开头，不写路径），比如 ["claw-tv \\"四川卫视\\""]。` : '') + (cm ? `命令照常写，比如 ["df -h"]。` : '')
    : `${use}，回复里写一个 claw 代码块就停下，等结果。` + (sk ? `第一次用某个技能先读它的说明：
\`\`\`claw
read claw-tv
\`\`\`
读过就照说明写命令（一行一条，最多 3 条，以技能名开头，不写路径），比如：
\`\`\`claw
claw-tv "四川卫视"
\`\`\`` : '') + (cm ? (sk ? '\n' : '') + `命令也写在 claw 代码块里（一行一条，最多 3 条），比如：
\`\`\`claw
df -h
\`\`\`` : '');
  return `

你还能用 claclaw 的${what}：命令由 claclaw 在它所在的电脑（${OS}）上替你跑，结果再发给你。` + (sk ? `技能有：
${SKILLS.map(k => '- ' + k.name + '：' + k.desc).join('\n')}
` : '\n') + (cm ? `简单命令：${cmdList(false)} 直接跑；${cmdList(true)} 要用户在网页上点确认。不经 shell：不能用管道、重定向、cd（~ 和通配符可以用）。${cwdLine(s)}别的命令跑不了，就给出命令让用户自己跑。
` : '') + how + `
结果回来后${sk && cm ? '接着回答用户，用了技能就照它的说明回复（要原样贴的代码块原样贴）。用不上就直接回答，不要提这些' : sk ? '照技能说明回复用户（要原样贴的代码块原样贴）。用不上技能就直接回答，不要提技能' : '接着回答用户。用不上就直接回答，不要提简单命令'}。`;
};
const systemOf = s => `你是答疑助手，简洁回答；用户用什么语言就用什么语言。今天是 ${new Date().toLocaleDateString('sv')}。
你不能上网，也不能操作用户的电脑${toolsOn(s) ? '（下面的' + whatOf(s) + '除外）' : ''}；需要在电脑上动手的事，给出具体命令或步骤让用户自己做。不知道就说不知道。
要给命令时，放进标明语言的代码块（bash、powershell、cmd 等），一行一条，说明写在代码块外面。
你现在用的模型是 ${s.model}。对话里更早的回答可能出自别的模型；被问到你是谁、是什么模型时，以这一句为准。${toolsOn(s) ? toolsText(s) : ''}${devLine(s.dev)}`;
// 发给模型的历史：旧版本（还能调工具时）留下的工具标签和工具结果不发；空回复不发；
// 去掉这些后相邻同角色的并成一条（有的接口不收连续两条 user / assistant），开头不能是 assistant
const LEGACY_TOOL = /^\s*<(run|read|write)[\s>]/;
// 用户消息带的图跟着发（{ mime, data }），只发最近 MAX_IMGS 张；更早的、文件读不到的换成一句话，让模型知道那里原来有图
function history(s) {
  const out = [];
  for (const x of s.messages.slice(s.from)) {
    const imgs = x.role === 'user' && Array.isArray(x.images) ? x.images : [];
    if (x.tool || (!x.content && !imgs.length) || (x.role === 'assistant' && LEGACY_TOOL.test(x.content))) continue;
    const last = out.at(-1);
    if (last?.role === x.role) { last.content = [last.content, x.content].filter(Boolean).join('\n\n'); if (imgs.length) last.images = [...(last.images || []), ...imgs]; }
    else if (out.length || x.role === 'user') out.push({ role: x.role, content: x.content || '', ...(imgs.length ? { images: [...imgs] } : {}) });
  }
  let left = MAX_IMGS;
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (!m.images) continue;
    const keep = []; let gone = 0;
    for (let k = m.images.length - 1; k >= 0; k--) {
      const d = left > 0 ? readImg(s.id, m.images[k]) : null;
      if (d) { keep.unshift({ mime: m.images[k].mime, data: d }); left--; } else gone++;
    }
    if (keep.length) m.images = keep; else delete m.images;
    if (gone) m.content = `[这里原来有 ${gone} 张图，这次没再发给你]` + (m.content ? '\n' + m.content : '');
  }
  return out;
}

// token 估算：中文约 1 字 1 token，英文约 3.5 字符 1 token
const tok = t => { let n = 0; for (const c of String(t)) n += c.charCodeAt(0) > 255 ? 1 : 0.29; return Math.ceil(n); };
// 超出预算时一次性丢掉最早的几轮，降到 60%（前缀不再每轮变，Ollama 才能复用缓存）；从用户消息处断开，保证最后一轮完整
// 旧版本（还能调工具时）存下的工具结果也是 role:user，带 tool:true，不能当断点
function trim(s) {
  const m = s.messages, size = from => m.slice(from).reduce((a, x) => a + tok(x.content) + 4 + (Array.isArray(x.images) ? x.images.length * IMG_TOK : 0), 0) + tok(systemOf(s));
  if (size(s.from) <= BUDGET) return;
  const starts = m.map((x, i) => x.role === 'user' && !x.tool ? i : -1).filter(i => i >= 0);
  for (const i of starts) {
    if (i <= s.from || i === starts.at(-1)) continue;
    s.from = i;
    if (size(i) <= BUDGET * 0.6) break;
  }
}

// ---------- 调模型 ----------
// 有的模型（如 Ollama 的 qwen3:4b，模板里已经替它写了 <think>）关思考时服务端不再分离思考，输出以「思考…</think>回答」的样子混在正文里：
// 只取 </think> 之后的；没写完的 <think> 后面也先不显示。碰到这种模型记下来（noOff），之后不再发 reasoning_effort=none
const clean = full => { const k = full.lastIndexOf('</think>'); return k >= 0 ? full.slice(k + 8).replace(/^\s+/, '') : full.replace(/<think>[\s\S]*$/, ''); };
// 三种接口格式（模型库里一家有几种时，claclaw 按 openai → anthropic → gemini 挑一种传进来）。
// plain：接口不收调参（temperature、关思考那几项，比如 OpenAI 官方的推理模型）回 400 时，去掉重试一次，成了就记下来以后都不发
function reqOf(s, extra = []) {
  const system = systemOf(s), msgs = [...history(s), ...extra], tune = !s.plain;
  if (FORMAT === 'anthropic') return {
    url: BASE + '/v1/messages', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    // 不带 thinking 就是不思考；开思考时不能再带 temperature，max_tokens 要比思考预算大
    body: { model: s.model, stream: true, max_tokens: MAX_OUT, system,
      messages: msgs.map(x => x.images ? { role: x.role, content: [...x.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), ...(x.content ? [{ type: 'text', text: x.content }] : [])] } : { role: x.role, content: x.content }),
      ...(tune ? s.think ? { thinking: { type: 'enabled', budget_tokens: 2048 }, max_tokens: MAX_OUT + 2048 } : { temperature: 0.3 } : {}) },
  };
  if (FORMAT === 'gemini') return {
    url: BASE + '/models/' + encodeURIComponent(String(s.model).replace(/^models\//, '')) + ':streamGenerateContent?alt=sse', headers: { 'x-goog-api-key': KEY },
    body: { systemInstruction: { parts: [{ text: system }] },
      contents: msgs.map(x => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [...(x.images || []).map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })), ...(x.content || !x.images ? [{ text: x.content }] : [])] })),
      // thinkingBudget 0 = 关思考（关不掉的模型回 400，走 plain）
      generationConfig: { maxOutputTokens: MAX_OUT, ...(tune ? { temperature: 0.3, thinkingConfig: s.think ? { includeThoughts: true } : { thinkingBudget: 0 } } : {}) } },
  };
  const native = nativeOn(s);
  return {
    url: BASE + '/chat/completions', headers: { authorization: 'Bearer ' + KEY },
    body: { model: s.model, stream: true, stream_options: { include_usage: true }, max_tokens: MAX_OUT, ...(native ? { tools: [CLAW_TOOL] } : {}),
      // calls / tool：这一轮里原生调技能的来回（模型的 tool_calls、技能结果）
      messages: [{ role: 'system', content: system }, ...msgs.map(x => x.calls ? { role: 'assistant', content: x.content || null, tool_calls: x.calls.map(c => ({ id: c.id, type: 'function', function: { name: 'claw', arguments: JSON.stringify({ commands: c.lines }) } })) }
        : x.role === 'tool' ? { role: 'tool', tool_call_id: x.toolId, content: x.content } : x.images ? { role: x.role, content: [...(x.content ? [{ type: 'text', text: x.content }] : []), ...x.images.map(i => ({ type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.data } }))] } : { role: x.role, content: x.content })],
      ...(tune ? { temperature: 0.3 } : {}),
      ...(s.think || s.noOff || !tune ? {} : { reasoning_effort: 'none' }) },   // noOff：这个模型关不掉思考（见 clean），不发 none，让服务端自己把思考分出去
  };
}
// 这次请求实际发了什么（给解剖看）：接口路径、除对话以外的全部参数、每条消息的角色和字数。不含 key（key 在请求头里，不记）
const reqRec = q => {
  const b = q.body, list = b.messages || b.contents || [];
  const params = Object.fromEntries(Object.entries(b).filter(([k]) => !['messages', 'contents', 'system', 'systemInstruction'].includes(k)));
  // 每条 [角色, 字数, 图数（有图才写）]；图的数据不记
  const len = x => { const c = x.content ?? x.parts; if (typeof c === 'string') return [c.length, 0]; let n = 0, im = 0; for (const p of c || []) { if (typeof p.text === 'string') n += p.text.length; else if (p.type === 'image' || p.type === 'image_url' || p.inline_data) im++; } return [n, im]; };
  let path = ''; try { path = new URL(q.url).pathname; } catch {}
  const sys = b.system ?? b.systemInstruction?.parts?.[0]?.text;   // anthropic / gemini 的系统提示不在对话里，补成第一条，三种格式看起来一样
  const rows = list.map(x => { const [n, im] = len(x); return [x.role === 'model' ? 'assistant' : x.role, n, ...(im ? [im] : [])]; });
  const imgs = rows.reduce((a, r) => a + (r[2] || 0), 0);
  return { path, params, msgs: [...(sys != null ? [['system', String(sys).length]] : []), ...rows], ...(imgs ? { imgs } : {}) };
};
async function post(s, signal, extra) {
  const q = reqOf(s, extra);
  try {
    return await fetch(q.url, { method: 'POST', signal, headers: { 'content-type': 'application/json', ...q.headers }, body: JSON.stringify(q.body) });
  } catch (e) {
    if (e.name === 'AbortError') throw e;
    throw new Error('连不上模型服务 ' + BASE + (e.cause?.code ? '（' + e.cause.code + '）' : '：' + e.message));
  }
}
// 流里的一条 → { text, thought（有没有思考）, tt（思考原文）, usage: { in（输入合计，含缓存）, cr（缓存读）, cw（缓存写）, out（输出，含思考）, think（其中思考） }, stop }
// 各格式的字段不一样，统一成这个样子；没报的项不给（解剖时显示 --，不补 0）
function pieceOf(j) {
  if (j.error) throw new Error('模型服务出错：' + String(j.error.message || JSON.stringify(j.error)).slice(0, 300));
  if (FORMAT === 'anthropic') {
    if (j.type === 'content_block_delta') return j.delta?.type === 'thinking_delta' ? { thought: true, tt: j.delta.thinking || '' } : { text: j.delta?.text || '' };
    if (j.type === 'message_start') { const u = j.message?.usage || {}; return { usage: { in: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cr: u.cache_read_input_tokens, cw: u.cache_creation_input_tokens } }; }
    if (j.type === 'message_delta') return { usage: j.usage ? { out: j.usage.output_tokens } : null, stop: stopOf(j.delta?.stop_reason) };
    return {};
  }
  if (FORMAT === 'gemini') {
    const c = j.candidates?.[0], parts = c?.content?.parts || [], u = j.usageMetadata;
    return { text: parts.filter(x => !x.thought).map(x => x.text || '').join(''), thought: parts.some(x => x.thought), tt: parts.filter(x => x.thought).map(x => x.text || '').join(''),
      usage: u ? { in: u.promptTokenCount, cr: u.cachedContentTokenCount, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0), think: u.thoughtsTokenCount } : null,
      stop: stopOf(c?.finishReason || j.promptFeedback?.blockReason) };
  }
  const dl = j.choices?.[0]?.delta;
  return { calls: Array.isArray(dl?.tool_calls) ? dl.tool_calls : null, text: dl?.content || '', thought: !!(dl?.reasoning || dl?.reasoning_content), tt: String(dl?.reasoning || dl?.reasoning_content || ''), usage: j.usage ? { in: j.usage.prompt_tokens, cr: j.usage.prompt_tokens_details?.cached_tokens, out: j.usage.completion_tokens, think: j.usage.completion_tokens_details?.reasoning_tokens } : null,
    stop: stopOf(j.choices?.[0]?.finish_reason) };
}
// 各家的结束原因 → 'stop'（正常写完）| 'length'（到了输出上限，没写完）| 其他原样（被过滤拦下之类：RECITATION / SAFETY / content_filter / refusal…）
const LENGTH = new Set(['length', 'max_tokens', 'MAX_TOKENS']), DONE = new Set(['stop', 'end_turn', 'stop_sequence', 'STOP', 'FINISH_REASON_UNSPECIFIED', 'tool_calls', 'tool_use', 'pause_turn']);
const stopOf = r => !r ? null : LENGTH.has(r) ? 'length' : DONE.has(r) ? 'stop' : String(r);
// 接口报错：各家都是 JSON 里带 error.message（Gemini 有时包在数组里），取出说明，不贴整段 JSON
function errOf(status, body, headers) {
  let msg = '', e = null;
  try { const j = JSON.parse(body); e = (Array.isArray(j) ? j[0] : j)?.error; msg = typeof e === 'string' ? e : e?.message || ''; } catch {}
  msg = String(msg || body).replace(/\s+/g, ' ').trim();
  if (status === 429) return '模型服务说额度或频率超限（429）：' + (waitOf(e, msg, headers) || '等一会儿再试，或者换个模型') + '。原话：' + msg.slice(0, 200);
  return (status === 401 || status === 403 ? '模型服务拒绝了 key（' + status + '），去模型库检查 key：' : '模型服务返回 ' + status + '：') + msg.slice(0, 300);
}
// 429 多久恢复：Gemini 在 details 里写明超的是哪项额度（QuotaFailure：每分钟 / 每天）和 RetryInfo.retryDelay；
// OpenAI、Anthropic 等在 retry-after 头里给秒数（或时间）；都没有就看说明里的「retry in 37.5s」。每天的额度按太平洋时间 0 点重置
function waitOf(e, msg, headers) {
  const det = Array.isArray(e?.details) ? e.details : [];
  const vs = det.find(d => /QuotaFailure/.test(d?.['@type']))?.violations || [];
  const day = vs.find(v => /PerDay/i.test(v?.quotaId || '')), min = vs.find(v => /PerMinute/i.test(v?.quotaId || ''));
  const lim = v => v?.quotaValue ? '（上限 ' + v.quotaValue + ' 次）' : '';
  if (day) return '今天的额度' + lim(day) + '用完了，' + dayReset() + '恢复';
  let sec = parseFloat(det.find(d => /RetryInfo/.test(d?.['@type']))?.retryDelay);
  const ra = String(headers?.get?.('retry-after') || '').trim();
  if (!(sec >= 0) && ra) sec = /^\d+(\.\d+)?$/.test(ra) ? Number(ra) : (Date.parse(ra) - Date.now()) / 1000;
  const m = /retry (?:in|after) ([\d.]+)\s*(ms|s)\b/i.exec(msg);
  if (!(sec >= 0) && m) sec = Number(m[1]) / (m[2].toLowerCase() === 'ms' ? 1000 : 1);
  const head = min ? '每分钟的次数' + lim(min) + '用完了，' : '';
  return sec >= 0 ? head + '约 ' + waitText(sec) + '后恢复' : head ? head + '过一分钟再试' : '';
}
const waitText = s => s < 60 ? Math.max(1, Math.ceil(s)) + ' 秒' : s < 3600 ? Math.ceil(s / 60) + ' 分钟' : (s / 3600).toFixed(1) + ' 小时';
function dayReset(now = new Date()) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(now).map(x => [x.type, x.value]));
  const at = new Date(now.getTime() + 86400000 - ((Number(p.hour) % 24) * 3600 + Number(p.minute) * 60 + Number(p.second)) * 1000);
  const hm = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  return (at.toDateString() === now.toDateString() ? '今天 ' : '明天 ') + hm + '（太平洋时间 0 点）';
}
// 每次请求记一条进 calls（给会话解剖用）：{ at, status, ms, ttftMs, inp, cr, cw, out, think, stop, chars, plain, err }
async function chat(s, signal, onText, onThought, extra, calls = []) {
  const t0 = Date.now();
  let call = { at: t0, req: reqRec(reqOf(s, extra)) }; calls.push(call);
  const fail = (c, e) => { c.ms = Date.now() - c.at; if (e.name === 'AbortError') c.cancelled = true; else c.err = String(e.message).slice(0, 2000); };
  let r;
  try {
    r = await post(s, signal, extra);
    if (r.status === 400 && !s.plain) {
      const first = await r.text();
      Object.assign(call, { status: 400, ms: Date.now() - call.at, err: errOf(400, first).slice(0, 2000), body: first.slice(0, 4000), plain: false });
      s.plain = true;
      call = { at: Date.now(), retry: true, req: reqRec(reqOf(s, extra)) }; calls.push(call);
      r = await post(s, signal, extra);
      if (!r.ok) {   // 重试还是 400：不是调参的事，换回来、报第一次的原话；别的错（503 忙、429 超额）：调参确实不收，记下，报这次的原话
        const b2 = await r.text().catch(() => ''); call.status = r.status; call.body = b2.slice(0, 4000);
        if (r.status === 400) { s.plain = false; throw new Error(errOf(400, first) + imgHint(400, call)); }
        throw new Error(errOf(r.status, b2, r.headers) + imgHint(r.status, call));
      }
    }
    call.status = r.status; call.plain = !!s.plain;
    if (!r.ok) { const b = await r.text(); call.body = b.slice(0, 4000); throw new Error(errOf(r.status, b, r.headers) + imgHint(r.status, call)); }   // body：服务返回的原文，给解剖看
  } catch (e) { fail(call, e); throw e; }
  let text = '', tt = '', buf = '', first = 0, stop = null; const tc = [];   // tc：原生工具调用（按 index 拼参数）   // first：第一个字（含思考）到达的时刻；text / tt 是模型原样的输出和思考（不剥标签），记进 calls 给解剖看
  const u = {};
  const dec = new TextDecoder();
  try {
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') continue;
        let j; try { j = JSON.parse(d); } catch { continue; }
        const x = pieceOf(j);
        if (x.usage) for (const k of ['in', 'cr', 'cw', 'out', 'think']) if (x.usage[k] != null) u[k] = x.usage[k];
        if (x.stop) stop = x.stop;
        if (x.calls) for (const c of x.calls) { const t = tc[c.index ?? 0] ||= { id: '', name: '', args: '' }; if (c.id) t.id = c.id; if (c.function?.name) t.name = c.function.name; if (c.function?.arguments) t.args += c.function.arguments; }
        if ((x.text || x.thought || x.calls) && !first) first = Date.now();
        if (x.thought) { tt += x.tt || ''; onThought(); }
        if (x.text) { text += x.text; onText(text); }
      }
    }
  } catch (e) { Object.assign(call, usageRec(u), { chars: clean(text).length }, rawRec(text, tt)); fail(call, e); throw e; }
  const end = Date.now();
  Object.assign(call, { ms: end - call.at, ttftMs: first ? first - call.at : null, ...usageRec(u), stop, chars: clean(text).length, ...rawRec(text, tt) });
  if (tc.length) call.calls = tc.filter(Boolean).map(t => ({ name: t.name, args: t.args.slice(0, 2000) }));
  return { text: clean(text), calls: tc.filter(Boolean), tin: u.in || 0, tout: u.out || 0, leaked: text.includes('</think>'), stop, t0, first, end };
}
// 带了图、服务说请求不对（400 / 413 / 415 / 422）：多半是这个模型不收图或者图太大
const imgHint = (st, c) => c.req?.imgs && [400, 413, 415, 422].includes(st) ? '（这次带了图：这个模型可能不收图片，或者图太大，换个能看图的模型试试）' : '';
// 原样的输出 / 思考：空的不写
const rawRec = (text, tt) => ({ ...(text ? { text } : {}), ...(tt ? { thought: tt } : {}) });
// 用量 → 记录里的字段：inp 是输入合计（含缓存）；没报的项不写
const usageRec = u => Object.fromEntries([['inp', u.in], ['cr', u.cr], ['cw', u.cw], ['out', u.out], ['think', u.think]].filter(([, v]) => v != null));

// ---------- 技能 ----------
// 回复里的 ```claw 代码块：写完的（有收尾）或写到最后没收尾的；流式显示时从代码块开头（含正在写的 ``` 开头）起先不显示
const CLAW_RE = /(^|\n)```claw[^\n]*\n([\s\S]*?)(?:\n```[^\n]*(?:\n|$)|$)/;
function clawBlock(t) {
  const m = CLAW_RE.exec(t);
  if (!m) return null;
  const lines = m[2].split('\n').map(x => x.trim()).filter(x => x && !x.startsWith('#')).slice(0, 3);
  return lines.length ? { at: m.index + m[1].length, end: m.index + m[0].length, lines } : null;
}
// 原生调的 claw 工具 → 和代码块一样的 { lines }，多带 id（结果按 id 发回去）；同时调了几次只认第一次
function nativeBlock(r, step) {
  const c = r.calls?.find(x => x.name === 'claw');
  if (!c) return null;
  let a = {}; try { a = JSON.parse(c.args || '{}'); } catch {}
  const v = Array.isArray(a.commands) ? a.commands : String(a.commands || a.command || '').split('\n');
  return { id: c.id || 'call_' + step, at: r.text.length, end: r.text.length, lines: v.map(x => String(x).trim()).filter(Boolean).slice(0, 3) };
}
function hideClaw(t) {
  const i = t.search(/(^|\n)```claw/);
  if (i >= 0) return t.slice(0, i);
  const m = /(^|\n)(`{1,3}(?:c(?:l(?:a(?:w)?)?)?)?)$/.exec(t);
  return m ? t.slice(0, m.index) : t;
}
// 命令行拆参数：空白分隔，'…' "…" 里的原样（"…" 里认 \" \\），不经 shell
function argsOf(line) {
  const out = []; let cur = '', q = '', any = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ''; else if (q === '"' && c === '\\' && /["\\]/.test(line[i + 1] || '')) cur += line[++i]; else cur += c; }
    else if (c === '"' || c === "'") { q = c; any = true; }
    else if (/\s/.test(c)) { if (cur || any) out.push(cur); cur = ''; any = false; }
    else cur += c;
  }
  if (cur || any) out.push(cur);
  return out;
}
const skillOf = name => SKILLS.find(k => k.name === String(name || '').replace(/^.*\//, '').replace(/\.(cmd|mjs)$/, '')) || null;
const cap = (t, n) => t.length > n ? t.slice(0, n) + '\n…（后面还有 ' + (t.length - n) + ' 字，没给出）' : t;
// 跑一条技能命令：用这个进程的 node 直接跑技能脚本（和 ~/.claclaw/bin/ 下的命令一样），参数原样传，超时、停止都会杀掉
function runSkill(k, args, signal) {
  return new Promise(res => {
    let out = '', err = '', done = false;
    const p = spawn(process.execPath, [k.js, ...args], { cwd: HOME, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    const fin = code => { if (done) return; done = true; clearTimeout(to); signal?.removeEventListener?.('abort', kill); res({ code, out, err }); };
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const to = setTimeout(() => { err += '\n（超过 ' + SKILL_MS / 1000 + ' 秒，停掉了）'; kill(); }, SKILL_MS);
    signal?.addEventListener?.('abort', kill, { once: true });
    p.stdout.on('data', d => { if (out.length < 200000) out += d; });
    p.stderr.on('data', d => { if (err.length < 20000) err += d; });
    p.on('error', e => { err += e.message; fin(-1); });
    p.on('close', code => fin(code));
  });
}
// 一个 claw 代码块：一条条跑（read 技能名 = 给它的说明），网页上每条显示成一张工具卡片；返回发给模型的结果。
// seen：这一轮里给过说明的技能。没读说明就直接跑命令的（有的模型不听「先读」），结果后面附上说明，让它照「怎么回复」贴
async function runClaw(s, lines, signal, seen = new Set()) {
  const outs = [], docs = [];
  let used = false;   // 用了技能（不只是简单命令）
  for (const raw of lines) {
    const line = raw.replace(/^\$\s+/, ''), a = argsOf(line), id = 'claw-' + crypto.randomUUID().slice(0, 8);
    const read = /^read$/i.test(a[0] || ''), k = skillOf(read ? a[1] : a[0]);
    // 不是技能（也不像技能名）的按简单命令跑
    if (!read && !k && cmdsOn(s) && !/(^|\/)claw-/.test(a[0] || '')) { outs.push('$ ' + line + '\n' + ((await runSimple(s, line, id, signal)) || '（没有输出）')); continue; }
    used = true;
    update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title: k ? k.name : 'claw', kind: read ? 'read' : 'execute', status: 'in_progress', rawInput: { command: line } });
    let text, ok = true;
    if (!k) { ok = false; text = '没有这个技能：' + (read ? a[1] : a[0]) + '。能用的：' + SKILLS.map(x => x.name).join('、'); }
    else if (read) { text = k.md.replace(/~\/\.claclaw\/bin\//g, ''); seen.add(k.name); }
    else {
      if (!seen.has(k.name)) { seen.add(k.name); docs.push(k); }
      const r = await runSkill(k, a.slice(1), signal);
      if (signal?.aborted) { update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' }); throw aborted(); }
      ok = r.code === 0;
      text = cap(r.out.trim(), 12000) + (ok ? '' : '\n（退出码 ' + r.code + (r.err.trim() ? '：' + cap(r.err.trim(), 1500) : '') + '）');
    }
    update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: cap(text, 4000) } }] });
    outs.push('$ ' + line + '\n' + (text || '（没有输出）'));
  }
  const doc = docs.map(k => '\n\n[' + k.name + ' 的说明（你没读过，照里面的「怎么回复」回复）]\n' + k.md.replace(/~\/\.claclaw\/bin\//g, '')).join('');
  const more = nativeOn(s) ? '再调用 claw 工具' : '再写一个 claw 代码块';
  return used ? '[技能结果]\n' + outs.join('\n\n') + doc + '\n\n照技能说明回复用户；还要用技能就' + more + '。'
    : '[命令结果]\n' + outs.join('\n\n') + '\n\n接着回答用户；还要跑命令就' + more + '。';
}

// ---------- 简单命令 ----------
// 名字 → { ask：有动静的，要用户在网页上点确认；no(args)：不让跑的原因；fix(args)：改参数 }。别的只读，直接跑。
// 不经 shell：管道、重定向、命令替换一律不收；开头的 ~、$HOME 和没加引号的通配符这边展开（展开不带隐藏文件，和 shell 一样）；只按名字在 PATH 里找（写了路径也只认名字）。
// 环境变量只给 PATH、HOME 这几个（Mini 进程里有 API Key，不能带过去）；工作目录是主目录，20 秒超时，输出超过 10 万字就停。
// 隐藏的目录和文件（.ssh、.claclaw、.env……）、~/Library、claclaw 的 data、/dev，以及名字像密钥、密码的文件不碰（链接按真实位置算）。
// 协同 / 群里别人转来的那一轮（session/prompt 的 _meta.peer）每条都要确认（claclaw 那边先过 peerguard）
const CMD_MS = 20000, CMD_OUT = 100000;
const flags = a => a.filter(x => /^-[^-]/.test(x)).join('');   // 短选项拼在一起看（-rn 里有 r）
const CMDS = {
  date: {}, cal: {}, uptime: {}, whoami: {}, hostname: {}, uname: {}, sw_vers: {}, pwd: {}, which: {}, echo: {},
  ls: {}, du: {}, df: {}, stat: {}, wc: {}, head: {}, cat: {}, md5: {}, shasum: {}, vm_stat: {}, system_profiler: {},
  file: { no: a => /C/.test(flags(a)) ? 'file 不能 -C（会写文件）' : '' },
  tail: { no: a => /[fF]/.test(flags(a)) || a.some(x => /^--follow/.test(x)) ? 'tail 不能 -f（停不下来）' : '' },
  grep: { no: a => /[rR]/.test(flags(a)) || a.some((x, i) => /^--(recursive|dereference-recursive|directories=recurse)$/.test(x) || (x === '-d' && a[i + 1] === 'recurse')) ? 'grep 不能搜整个目录（-r），把要搜的文件写出来' : '' },
  find: { no: a => a.some(x => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/.test(x)) ? 'find 不能带 -exec、-delete 这类' : '' },
  sysctl: { no: a => a.some(x => x.includes('=') || /^-\w*w/.test(x)) ? 'sysctl 只能查' : '' },
  pmset: { no: a => a[0] !== '-g' ? 'pmset 只能 -g 查' : '' },
  diskutil: { no: a => /^(list|info)$/.test(a[0] || '') || (a[0] === 'apfs' && a[1] === 'list') ? '' : 'diskutil 只能 list、info、apfs list' },
  ipconfig: { no: a => a[0] === 'getifaddr' ? '' : 'ipconfig 只能 getifaddr' },
  ifconfig: { no: a => a.length > 1 ? 'ifconfig 只能查' : '' },
  ping: { fix: a => {   // 最多 5 次
    const i = a.indexOf('-c'), n = Math.min(5, Math.max(1, parseInt(i >= 0 ? a[i + 1] : a.find(x => /^-c\d+$/.test(x))?.slice(2), 10) || 4));
    return ['-c', String(n), ...a.filter((x, j) => !(i >= 0 && (j === i || j === i + 1)) && !/^-c\d+$/.test(x))];
  } },
  open: { ask: true }, mkdir: { ask: true }, touch: { ask: true }, cp: { ask: true }, mv: { ask: true }, say: { ask: true },
};
const cmdList = ask => Object.keys(CMDS).filter(k => !!CMDS[k].ask === ask).join(' ');
// 真实位置：不存在的按上一级的真实位置拼（mkdir、touch 的新名字）
function realOf(p) {
  try { return fs.realpathSync(p); } catch {}
  try { return path.join(fs.realpathSync(path.dirname(p)), path.basename(p)); } catch { return path.resolve(p); }
}
const NO_GO = [path.join(HOME, 'Library'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'), process.env.CLACLAW_DATA,
  path.basename(DIR) === 'mini-sessions' ? path.dirname(DIR) : '', '/dev'].filter(Boolean).map(realOf);
const SECRET = /(credential|secret|token|passw|id_rsa|id_ed25519|id_ecdsa|keychain|cookies?$|\.(pem|key|p12|pfx|kdbx)$)/i;
// 命令在会话的目录里跑（新建会话时选的；没有、不是目录就用主目录）。不是主目录时就是「小目录」：主目录下这个目录以外的个人文件不碰（系统目录照常能看）；
// 会话目录本身是隐藏目录下的（用户自己选的）也照常用，只是目录里面的隐藏文件不碰
const HOME_REAL = realOf(HOME);
const inside = (p, d) => p === d || p.startsWith(d + path.sep);
function cwdOf(s) { try { const d = realOf(s.cwd || HOME); return fs.statSync(d).isDirectory() ? d : HOME_REAL; } catch { return HOME_REAL; } }
// 一个参数要是路径（带 / 或 ~，或者当前目录下有这个名字；选项看 = 后面或 / 起的部分；网址不算）：碰不碰得
function badPath(arg, wd = HOME_REAL) {
  let v = arg;
  if (v.startsWith('-')) { const i = v.search(/[=/~]/); if (i < 0) return ''; v = v.slice(v[i] === '=' ? i + 1 : i); }
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return '';
  if (!/[/~]/.test(v) && !fs.existsSync(path.join(wd, v))) return '';
  const abs = realOf(path.resolve(wd, v.replace(/^~(?=\/|$)/, HOME)));
  v = tilde(v);   // 说的时候照模型的写法
  if ((inside(abs, wd) ? path.relative(wd, abs) : abs).split(path.sep).some(c => c.startsWith('.'))) return v + ' 是隐藏的目录 / 文件，不能碰';
  if (wd !== HOME_REAL && inside(abs, HOME_REAL) && !inside(abs, wd)) return v + ' 在会话目录（' + tilde(wd) + '）外面，不能碰';
  if (NO_GO.some(d => abs === d || abs.startsWith(d + path.sep))) return v + ' 所在的目录不能碰';
  if (SECRET.test(path.basename(abs))) return v + ' 看着像密钥、密码一类的文件，不能碰';
  return '';
}
// 命令行 → 参数（同 argsOf，另外记下有没有没加引号的通配符），以及引号外面有没有 shell 才认的符号
function cmdArgs(line) {
  const out = []; let cur = '', q = '', any = false, glob = false, shell = false;
  const push = () => { if (cur || any) out.push({ v: cur, glob }); cur = ''; any = false; glob = false; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === q) q = ''; else if (q === '"' && c === '\\' && /["\\$`]/.test(line[i + 1] || '')) cur += line[++i]; else { if (q === '"' && (c === '`' || (c === '$' && line[i + 1] === '('))) shell = true; cur += c; } }
    else if (c === '"' || c === "'") { q = c; any = true; }
    else if (/\s/.test(c)) push();
    else { if (/[|;&<>`]/.test(c) || (c === '$' && line[i + 1] === '(')) shell = true; if (/[*?[]/.test(c)) glob = true; cur += c; }
  }
  push();
  return { args: out, shell };
}
const homeOf = v => v.replace(/^~(?=\/|$)/, HOME).replace(/^\$(HOME|\{HOME\})(?=\/|$)/, HOME);
function expand(args, wd) {
  const out = [];
  for (const { v, glob } of args) {
    const x = homeOf(v);
    let hit = [];
    if (glob) { try { hit = fs.globSync(x, { cwd: wd }).filter(p => !path.basename(p).startsWith('.') && !badPath(p, wd)).sort(); } catch {} }   // 碰不得的（~/Library 等）当没有
    out.push(...(hit.length ? hit.slice(0, 500) : [x]));   // 没匹配到的原样传（和 shell 一样）
  }
  return out;
}
function cmdEnv() {
  const e = { TERM: 'dumb', PAGER: 'cat' };
  for (const k of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR', 'SHELL']) if (process.env[k]) e[k] = process.env[k];
  return e;
}
function runCmd(argv, signal, wd) {
  return new Promise(res => {
    let out = '', note = '', done = false;
    const p = spawn(argv[0], argv.slice(1), { cwd: wd, stdio: ['ignore', 'pipe', 'pipe'], env: cmdEnv() });
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const fin = code => { if (done) return; done = true; clearTimeout(to); signal?.removeEventListener?.('abort', kill); res({ code, out, note }); };
    const to = setTimeout(() => { note = '超过 ' + CMD_MS / 1000 + ' 秒，停掉了'; kill(); }, CMD_MS);
    signal?.addEventListener?.('abort', kill, { once: true });
    const take = d => { if (out.length >= CMD_OUT) return; out += d; if (out.length >= CMD_OUT) { note = '输出太多，停掉了'; kill(); } };
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.on('error', e => { out += e.code === 'ENOENT' ? '这台电脑上没有 ' + argv[0] + ' 命令' : e.message; fin(-1); });
    p.on('close', code => fin(code));
  });
}
// 要用户确认：发 session/request_permission，claclaw 显示成和别家一样的确认条；停掉这一轮就不等了
const waits = new Map(); let askSeq = 0;
function askUser(s, toolCallId, line, signal) {
  return new Promise(res => {
    const id = 'ask-' + (++askSeq);
    const fin = ok => { if (!waits.delete(id)) return; signal?.removeEventListener?.('abort', stop); res(ok); };
    const stop = () => fin(false);
    waits.set(id, r => fin(r?.outcome?.outcome === 'selected' && r.outcome.optionId === 'allow'));
    signal?.addEventListener?.('abort', stop, { once: true });
    send({ id, method: 'session/request_permission', params: { sessionId: s.id, toolCall: { toolCallId, title: 'Bash', kind: 'execute', rawInput: { command: line } },
      options: [{ optionId: 'allow', name: '允许', kind: 'allow_once' }, { optionId: 'reject', name: '不允许', kind: 'reject_once' }] } });
  });
}
const aborted = () => Object.assign(new Error('cancelled'), { name: 'AbortError' });
// 一条简单命令：网页上一张 Bash 卡片；返回发给模型的结果
async function runSimple(s, line, id, signal) {
  update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title: 'Bash', kind: 'execute', status: 'in_progress', rawInput: { command: line } });
  const end = (ok, text) => { update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: cap(text, 4000) } }] }); return text; };
  const { args: toks, shell } = cmdArgs(line);
  const name = (toks[0]?.v || '').replace(/^.*\//, ''), c = Object.hasOwn(CMDS, name) ? CMDS[name] : null;
  if (!c) return end(false, '这条命令跑不了：' + (name || '（空）') + ' 不在简单命令清单里。能跑的：' + Object.keys(CMDS).join(' ') + '。别的给出命令让用户自己跑。');
  if (shell) return end(false, '没跑：不经 shell，不能用管道、重定向、;、&&、命令替换。拆成单独的命令再跑（比如只跑 ls ~/Desktop，数数、筛选你自己来）。');
  const wd = cwdOf(s);
  let args = expand(toks.slice(1), wd);
  const why = args.map(x => badPath(x, wd)).find(Boolean) || c.no?.(args) || '';
  if (why) return end(false, '没跑：' + why + '。');
  if (c.fix) args = c.fix(args);
  if (c.ask || s.peer) {
    const ok = await askUser(s, id, line, signal);
    if (signal?.aborted) { end(false, '已停止'); throw aborted(); }
    if (!ok) return end(false, '用户没有允许跑这条命令。');
  }
  const r = await runCmd([name, ...args], signal, wd);
  if (signal?.aborted) { end(false, '已停止'); throw aborted(); }
  const ok = r.code === 0;
  // macOS 的隐私保护（桌面、文稿、下载等要单独授权）：说清楚是系统拦的、怎么开，模型好转告用户
  const tcc = process.platform === 'darwin' && /Operation not permitted/.test(r.out) ? '\n（macOS 隐私保护拦下了：claclaw 没有读这个文件夹的权限。要用的话，用户在「系统设置 → 隐私与安全性 → 完全磁盘访问权限」里加上 ' + process.execPath + '，再重启 claclaw）' : '';
  return end(ok, cap(r.out.trim(), 12000) + (r.note ? '\n（' + r.note + '）' : '') + (ok ? '' : '\n（退出码 ' + r.code + '）') + tcc);
}

// ---------- 一轮 ----------
// 回复到了输出上限（没写完）就自动接着写，最多 MAX_PARTS 段，拼成同一条回复
const MAX_PARTS = 4;
const CONTINUE = '上面的回答因为长度限制断了。从断开的地方直接接着写，不要重复已经写过的内容，也不要加开场白或总结。';
// 被过滤拦下（不自动重试：防复述、安全过滤是对方的规矩）
function noteOf(stop) {
  if (!stop || stop === 'stop') return '';
  if (stop === 'length') return `回复太长，已经分 ${MAX_PARTS} 段接着写了还没写完；发「继续」让它接着写`;
  if (stop === 'RECITATION') return '模型判定在大段照搬已有的原文（Gemini 的防复述限制），中途停了。可以让它分段讲、讲大意或译成白话，或者换个模型';
  if (/SAFETY|PROHIBITED|BLOCKLIST|SPII|content_filter|refusal/i.test(stop)) return `回复被模型的安全过滤拦下，中途停了（${stop}）`;
  return `模型中途停了（${stop}）`;
}
async function prompt(s, text, images = []) {
  const ac = new AbortController(); s.abort = ac;
  const um = { role: 'user', content: text, ...(images.length ? { images: images.map(i => saveImg(s.id, i.mime, i.data)) } : {}), at: Date.now() };
  s.messages.push(um);
  if (!s.title) { s.title = text.replace(/\s+/g, ' ').slice(0, 50) || '图片'; update(s.id, { sessionUpdate: 'session_info_update', title: s.title }); }
  let full = '', parts = 0, steps = 0, seg = '';   // seg：上次用技能之后写的（到了长度上限接着写时整段发回去）
  const tools = toolsOn(s), ex = [], seen = new Set();                   // ex：这一轮里用技能 / 命令的来回（模型写的 claw 代码块、结果）
  const say = t => update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  let kept = false;
  const keep = () => { if (full && !kept) { kept = true; s.messages.push({ role: 'assistant', content: full, model: s.model, at: Date.now(), ...(parts > 1 ? { parts } : {}) }); } };
  try {
    trim(s);
    // 这一轮怎么答的（给会话解剖、调 Mini 用）：用的哪个模型、什么接口和参数、发了几条历史、丢了几条、系统提示，以及每次请求的明细
    const run = um.run = { model: s.model, api: FORMAT, host: hostOf(BASE), think: !!s.think, noOff: !!s.noOff, maxOut: MAX_OUT, sys: systemOf(s), sent: history(s).length, dropped: s.from, calls: [] };
    let tin = 0, tout = 0, gen = 0, t0 = 0, first = 0, end = 0, stop = null;
    let after = false;   // 上一次是用技能：这一段和前面写的之间空一行
    while (parts < MAX_PARTS) {
      parts++;
      const base = full, extra = [...ex, ...(seg ? [{ role: 'assistant', content: seg }, { role: 'user', content: CONTINUE }] : [])];
      const glue = t => { if (!base) return t.replace(/^\s+/, ''); return base + (after && t && !/\n\s*$/.test(base) ? '\n\n' : '') + t; };   // 开头的空行不要
      const vis = t => tools ? hideClaw(t) : t;
      let sent = base.length, cut = false;
      const r = await chat(s, ac.signal, raw => {
        const now = glue(vis(clean(raw)));
        if (!cut && raw.includes('</think>')) { cut = true; sent = base.length; }   // 刚发现思考混在正文里：已经流出去的没法收回，从这一段开头重新算
        if (now.length > sent) { say(now.slice(sent)); sent = now.length; }
      }, () => update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }), extra, run.calls);
      if (r.leaked && !s.noOff && !s.think) s.noOff = true;
      const blk = tools && steps < MAX_STEPS ? nativeBlock(r, steps) || clawBlock(r.text) : null;
      if (blk) {   // 用技能：代码块前面写的照常显示；跑完把结果交给模型接着写（不算「接着写」的段数）
        steps++; parts--;
        full = glue(r.text.slice(0, blk.at).replace(/\s+$/, ''));
        if (full.length > sent) say(full.slice(sent));
        const res = await runClaw(s, blk.lines, ac.signal, seen);
        if (blk.id) ex.push({ role: 'assistant', content: (seg + r.text).trim(), calls: [{ id: blk.id, lines: blk.lines }] }, { role: 'tool', toolId: blk.id, content: res });
        else ex.push({ role: 'assistant', content: seg + r.text.slice(0, blk.end).replace(/\s+$/, '') }, { role: 'user', content: res });
        seg = ''; after = true;
        if (!t0) { t0 = r.t0; first = r.first; }
        tin = r.tin || tin; tout += r.tout; end = r.end;
        if (r.first) gen += (r.end - r.first) / 1000;
        continue;
      }
      const txt = tools ? r.text.replace(/(^|\n)```claw[\s\S]*?(?:\n```[^\n]*|$)/g, '$1').replace(/\s+$/, '') : r.text;   // 技能用满了还写 claw 块：不显示
      full = glue(txt); seg += r.text; after = false;
      if (full.length > sent) say(full.slice(sent));
      if (!t0) { t0 = r.t0; first = r.first; }
      tin = r.tin || tin; tout += r.tout; end = r.end; stop = r.stop;
      if (r.first) gen += (r.end - r.first) / 1000;
      if (stop !== 'length' || !r.text) break;
    }
    Object.assign(run, { endAt: Date.now(), parts, stop, ...(steps ? { steps } : {}), ...(noteOf(stop) ? { note: noteOf(stop) } : {}) });
    keep(); save(s);
    // 生成速度只算第一个字之后的；输出太短（< 8 tok）算出的速度没意义，不报；没有 usage 的服务不报速度（估出来的不准，调试时会误导）
    const stats = { model: s.model, ttft: first ? (first - t0) / 1000 : null, outTokens: tout || null, tps: tout >= 8 && gen > 0.05 ? tout / gen : null, total: (end - t0) / 1000,
      ...(parts > 1 ? { parts } : {}), ...(noteOf(stop) ? { note: noteOf(stop) } : {}) };
    update(s.id, { sessionUpdate: 'usage_update', used: tin ? tin + tout : 0, size: BUDGET, _meta: { mini: stats } });
    return 'end_turn';
  } catch (e) {
    if (um.run) Object.assign(um.run, { endAt: Date.now(), parts }, e.name === 'AbortError' ? { cancelled: true } : { error: String(e.message).slice(0, 500) });
    keep(); save(s);   // 停掉、出错时已经写出来的那部分也留着（网页上已经显示了）
    if (e.name === 'AbortError') return 'cancelled';
    throw e;
  } finally { s.abort = null; }
}

// 历史重放（session/load）：只放用户和回复。旧版本存下的工具结果（tool:true）不放
function replay(s) {
  for (const x of s.messages) {
    if (x.role === 'user' && !x.tool) {
      if (x.content || !x.images?.length) update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: x.content } });
      for (const im of Array.isArray(x.images) ? x.images : []) { const d = readImg(s.id, im); if (d) update(s.id, { sessionUpdate: 'user_message_chunk', content: { type: 'image', mimeType: im.mime, data: d } }); }
    }
    else if (x.role === 'assistant' && x.content) update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: x.content } });
  }
}

// 换模型：noOff / plain 是按模型试出来的，换了就重新试（不然从回 400 的模型换到 Ollama，思考就关不掉了）
function setModel(s, m) { if (m !== s.model) { s.noOff = false; s.plain = false; } s.model = m; }

// ---------- 分发 ----------
const handlers = {
  initialize: () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, authMethods: [] }),
  'session/new': p => { const s = create(p.cwd); return { sessionId: s.id, configOptions: configOf(s) }; },
  'session/load': p => { const s = open(String(p.sessionId), p.cwd); replay(s); return { configOptions: configOf(s) }; },
  'session/close': p => { const s = sessions.get(String(p.sessionId)); s?.abort?.abort(); sessions.delete(String(p.sessionId)); return {}; },
  'session/prompt': async p => {
    const s = open(String(p.sessionId));
    const text = (p.prompt || []).map(b => b?.type === 'text' ? b.text : '').join('').trim();
    const images = (p.prompt || []).filter(b => b?.type === 'image' && EXT[b.mimeType] && typeof b.data === 'string' && b.data).map(b => ({ mime: b.mimeType, data: b.data }));
    if (!text && !images.length) return { stopReason: 'end_turn' };
    s.dev = DEVICES[p._meta?.device] ? p._meta.device : '';   // 这一条是用什么设备发的（协同、群里转来的没有）
    s.peer = p._meta?.peer === true;                          // 协同 / 群里别人转来的：简单命令每条都要用户确认
    return { stopReason: await prompt(s, text, images) };
  },
  'session/set_model': p => { const s = open(String(p.sessionId)); setModel(s, String(p.modelId)); save(s); return {}; },
  'session/set_config_option': p => {
    const s = open(String(p.sessionId)), v = String(p.value);
    if (p.configId === 'model') setModel(s, v); else if (p.configId === 'effort') s.think = v === 'on'; else throw new Error('没有这一项：' + p.configId);
    save(s);
    return { configOptions: configOf(s) };
  },
};

let buf = '';
process.stdin.setEncoding('utf8');   // 按 UTF-8 流式解码：中文跨两块数据时不会变乱码
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (!m.method && m.id != null && waits.has(m.id)) { waits.get(m.id)(m.result); continue; }   // 确认的答复
    if (m.method === 'session/cancel') { sessions.get(String(m.params?.sessionId))?.abort?.abort(); continue; }
    if (m.method && m.id != null) {
      Promise.resolve().then(() => { const h = handlers[m.method]; if (!h) throw Object.assign(new Error('method not supported: ' + m.method), { code: -32601 }); return h(m.params || {}); })
        .then(result => send({ id: m.id, result }), e => send({ id: m.id, error: { code: e.code || -32000, message: e.message } }));
    }
  }
});
process.stdin.on('end', () => process.exit(0));
