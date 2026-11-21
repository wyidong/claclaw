#!/usr/bin/env node
// 极简对话 agent（ACP，stdin/stdout 一行一条 JSON-RPC）：问答为主，不碰这台电脑上的文件和任意命令；
// 给模型开放到哪一步看能力档（kuai-profiles.mjs）：模型库里手动设的 > 上岗小测验测出来的（kuai-quiz.mjs）> 按参数量和家族估的。
// L1（填空，kuai-fill.mjs）：程序按关键词认出用户想用哪个技能，模型只把参数填进固定的 JSON，程序跑技能、把结果贴出来。
// 能力档到 L2 的模型还能自己用 claclaw 自带的技能（skills/，电视、听歌、视频、换肤……）：
// 模型在回复里写 ```claw 代码块（read 技能名 / 技能命令），这边只认技能清单里的命令，不经 shell 直接用 node 跑技能脚本，结果再交给模型接着答。
// 同样的写法还能跑几条简单命令（date、ls、df、cat……，见 CMDS）：只读的直接跑，open、mkdir 这类要用户在网页上点确认；不经 shell，隐藏文件、~/Library、claclaw 的 data 不碰。
// 用途：拿模型库里的模型（尤其本地 Ollama）直接答疑，顺便看模型快不快、好不好用。
// - 每轮请求只有一段很短的系统提示 + 对话本身，首字最快（技能和命令只有一个 claw 工具）
// - 默认关思考；会话设置里可以打开。怎么关、带不带采样参数按模型画像来（kuai-profiles.mjs），拿不准的不发
// - 请求前缀保持不变（Ollama 能复用已处理的部分）；超出预算才一次性丢掉最早的几轮，不做「压缩」那种额外请求
// - 每轮结束在 usage_update 的 _meta.kuai 里带上首字耗时、生成速度，claclaw 显示成一行小字
// 试出来的特性（关不掉思考、不收调参、不收约束输出、Ollama 实际的窗口）和小测验的结果按模型记在 KUAI_LEARN 指的文件里，换会话不用再试
// 小测验：本机的模型（没手动设能力档的）用过一次后在后台自己测，来了新消息就让路、下次接着测；云上的只在模型管理里点了才测（_kuai/quiz）
// 环境变量：KUAI_QUIZ（=0 不自动测）、KUAI_MODEL_INFO（模型库里每个模型的窗口和手动设的能力档，JSON：{ 模型: { ctx, tier } }）、KUAI_LEARN、KUAI_META（=0 不问 Ollama 要模型信息）、KUAI_FORMAT（接口格式 openai | anthropic | gemini，默认 openai）、KUAI_BASE_URL（openai 写到 /v1；anthropic 写到 /v1 之前；gemini 写到 /v1beta）、KUAI_API_KEY、KUAI_MODELS（逗号分隔）、KUAI_MODEL、KUAI_DIR（会话目录）、KUAI_BUDGET（上下文预算 token）、KUAI_MAX_OUT
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, tilde, readJson, writeJsonAtomic, hash16 } from '../util.mjs';
import { profileOf, tierOf, parseSize, isLocalHost, budgetOf, TIER_BUILT } from './kuai-profiles.mjs';
import { loadFills, routeFill, askSlots, fillSchema, fillAsk, parseFill, enough, fillArgs, fillLine, fillLead, pasteOut } from './kuai-fill.mjs';
import { QUIZ_V, QUIZ_SKILLS, QUIZ_FILL_META, QUESTIONS, TOOL_KEYS, fakeRun, grade, settled, quizTier, quizCount, nextQuestion } from './kuai-quiz.mjs';

const BASE = (process.env.KUAI_BASE_URL || 'http://127.0.0.1:11434/v1').replace(/\/+$/, '');
const KEY = process.env.KUAI_API_KEY || 'none';
const FORMAT = ['anthropic', 'gemini'].includes(process.env.KUAI_FORMAT) ? process.env.KUAI_FORMAT : 'openai';
const hostOf = u => { try { return new URL(u).host; } catch { return ''; } };
const MODELS = (process.env.KUAI_MODELS || '').split(',').map(s => s.trim()).filter(Boolean);
const DEFAULT_MODEL = process.env.KUAI_MODEL || MODELS[0] || 'qwen3:1.7b';
const DIR = process.env.KUAI_DIR || path.join(HOME, '.claclaw-kuai', 'sessions');
const BUDGET = Math.max(2000, Number(process.env.KUAI_BUDGET) || 6000);
const MAX_OUT = Math.max(256, Number(process.env.KUAI_MAX_OUT) || 4096);   // 一次回复的 token 上限：小模型偶尔停不下来
const MODEL_INFO = (() => { try { const j = JSON.parse(process.env.KUAI_MODEL_INFO || '{}'); return j && typeof j === 'object' ? j : {}; } catch { return {}; } })();
const LEARN = process.env.KUAI_LEARN || path.join(DIR, '.learned');
const META_ON = process.env.KUAI_META !== '0';
// 技能：skills/index.json 里登记的、有命令脚本的（找会话、发文件 kuAi 用不上，不给）；KUAI_SKILLS_DIR 可以改目录（测试用；指到没有的目录就是不给技能）
const SKILLS_DIR = process.env.KUAI_SKILLS_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'skills');
const SKILL_SKIP = new Set(['claw-interconnect', 'claw-file']);
// skills/kuai.json：每个技能给 kuAi 的两样东西——brief（工具档清单里的一句话；完整的说明等模型 read 时才给，清单全量列出要一千多 token）和 fill（L1 填空的定义）
const KU_META = (() => { try { const j = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, 'kuai.json'), 'utf8')); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch { return {}; } })();
const briefOf = (name, desc) => String(KU_META[name]?.brief || '').trim() || (desc.split(/[：:。；]/)[0] || desc).slice(0, 40);
const SKILLS = (() => {
  let idx = []; try { idx = JSON.parse(fs.readFileSync(path.join(SKILLS_DIR, 'index.json'), 'utf8')); } catch {}
  return (Array.isArray(idx) ? idx : []).filter(x => /^claw-[a-z0-9-]+$/.test(x?.name || '') && !SKILL_SKIP.has(x.name)).map(x => {
    const dir = path.join(SKILLS_DIR, x.name), js = path.join(dir, x.name.slice(5) + '.mjs');
    let md = ''; try { md = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8'); } catch {}
    const desc = String(md.match(/^description:\s*(.+)$/m)?.[1] || x.desc || '').trim();
    return md && fs.existsSync(js) ? { name: x.name, desc, brief: briefOf(x.name, desc), eg: x.name === 'claw-tv' ? 'claw-tv "四川卫视"' : x.name + ' "关键词"', js, md: md.replace(/^---[\s\S]*?---\s*/, '').trim() } : null;
  }).filter(Boolean);
})();
const FILLS = loadFills(KU_META, n => SKILLS.some(k => k.name === n));
const QUIZ_FILL = loadFills(QUIZ_FILL_META)[0];
// 简单命令：KUAI_CMDS=0 关掉（测试用）
const CMDS_ON = process.env.KUAI_CMDS !== '0';
const MAX_STEPS = 4;          // 一轮里最多用几次技能（每次一个 claw 代码块，最多 3 条命令）
const QUIZ_AUTO = process.env.KUAI_QUIZ !== '0';
const QUIZ_STEP_MS = Math.max(1000, Number(process.env.KUAI_QUIZ_MS) || 180000);   // 小测验里一次请求最多等多久（本机小模型带着思考一次要一两分钟）
const QUIZ_WAIT = Math.max(0, Number(process.env.KUAI_QUIZ_WAIT) || 15000);        // 一轮结束后过多久开始后台测（用户多半还要接着问，别刚开始就被打断）
const SKILL_MS = 120000;      // 一条技能命令最多跑多久

fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });

// ---------- JSON-RPC ----------
const send = o => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...o }) + '\n');
const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

// ---------- 会话 ----------
const sessions = new Map();   // id → { id, cwd, model, think, noOff, plain, noFmt, bad, down, title, messages, from, abort }
const file = id => path.join(DIR, id + '.json');
const validId = id => /^[A-Za-z0-9_.-]{4,128}$/.test(id);
function save(s) {
  writeJsonAtomic(file(s.id), { sessionId: s.id, cwd: s.cwd, model: s.model, think: s.think, noOff: s.noOff, plain: s.plain, ...(s.bad ? { bad: s.bad } : {}), ...(s.down ? { down: s.down } : {}), title: s.title, from: s.from, messages: s.messages, updatedAt: new Date().toISOString() }, 0);
}
// 内存里的会话：o 是会话文件里存的（新建时为空）
const sessionOf = (id, cwd, o = {}) => ({ id, cwd: o.cwd || cwd || HOME, model: o.model || DEFAULT_MODEL, think: !!o.think, noOff: !!o.noOff, plain: !!o.plain, noFmt: false, bad: Number(o.bad) || 0, down: Number(o.down) || 0, title: o.title || '', messages: Array.isArray(o.messages) ? o.messages : [], from: Number(o.from) || 0, abort: null });
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

// ---------- 按模型记下的特性、模型信息 ----------
// 记在 LEARN 文件里：{ '主机|模型': { noOff: 时刻, plain: 时刻, noFmt: 时刻, ctx: 窗口, quiz: 小测验的结果 } }。noOff / plain / noFmt 记的是试出来的时刻，30 天后重新试（服务商可能改了）
const HOST = hostOf(BASE), LOCAL = isLocalHost(HOST), LEARN_MS = 30 * 864e5;
const readLearn = () => { const j = readJson(LEARN, {}); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; };
let learned = readLearn();
const lkey = m => HOST + '|' + m;
const fresh = t => typeof t === 'number' && Date.now() - t < LEARN_MS;
const knows = (m, k) => fresh(learned[lkey(m)]?.[k]);
const RAW = new Set(['ctx', 'quiz']);   // 这两项记的是值本身，别的记时刻
function learn(m, k, v) {
  const old = learned[lkey(m)]?.[k];
  if (k === 'quiz' ? false : k === 'ctx' ? old === v : !!v === fresh(old)) return;
  const all = readLearn(), r = { ...(all[lkey(m)] || {}) };   // 几家供应商各一个进程，共用这个文件：写之前重读
  if (v) r[k] = RAW.has(k) ? v : Date.now(); else delete r[k];
  all[lkey(m)] = r; learned = all;
  try { writeJsonAtomic(LEARN, all, 0); } catch {}
}
// 本机的模型服务是 Ollama 时问它要模型信息：参数量（名字里没写的也有）和实际的窗口。
// Ollama 没设窗口时默认只有 4096，超出的部分它不报错、直接丢掉最早的消息，所以对话的预算得跟着实际的窗口走
const ORIGIN = (() => { try { return new URL(BASE).origin; } catch { return ''; } })();
async function getJson(p, body, ms = 1500) {
  const r = await fetch(ORIGIN + p, { method: body ? 'POST' : 'GET', ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
let ollama = null, isOllama = false;
const askOllama = () => ollama ||= (META_ON && LOCAL && FORMAT !== 'gemini' && ORIGIN ? getJson('/api/version').then(j => typeof j?.version === 'string', () => false) : Promise.resolve(false)).then(ok => (isOllama = ok));
const metas = new Map();   // 模型 → { size（B）, caps, numCtx, mod（模型文件的修改时间：变了说明重新拉过，小测验要重测） }；问不到的记成空的，不反复问
const metaOf = m => metas.get(m) || {};
async function loadMeta(m) {
  if (!(await askOllama())) return;
  if (!metas.has(m)) {
    try {
      const j = await getJson('/api/show', { model: m }, 3000);
      metas.set(m, { size: parseSize(j?.details?.parameter_size), caps: Array.isArray(j?.capabilities) ? j.capabilities : null, mod: typeof j?.modified_at === 'string' ? j.modified_at : '', numCtx: Number(/(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(j?.parameters || ''))?.[1]) || 0 });
    } catch { metas.set(m, {}); }
  }
  await seeCtx(m);
}
// 模型装载着时 /api/ps 报它实际用的窗口：记下来（没装载就问不到，沿用上次记的）
async function seeCtx(m) {
  if (!(await askOllama())) return;
  try { const x = ((await getJson('/api/ps'))?.models || []).find(x => x?.name === m || x?.model === m || x?.name === m + ':latest'); if (x?.context_length > 0) learn(m, 'ctx', Number(x.context_length)); } catch {}
}
// 这个模型的窗口：Ollama 报的实际值（记下的）> Modelfile 里的 num_ctx > Ollama 上都不知道时按默认的 4096 猜（known=false）> 模型库里填的
function ctxOf(s) {
  const m = s.model, l = Number(learned[lkey(m)]?.ctx);
  if (l > 0) return { ctx: l, known: true };
  if (metaOf(m).numCtx > 0) return { ctx: metaOf(m).numCtx, known: true };
  if (isOllama) return { ctx: 4096, known: false };
  const c = Number(MODEL_INFO[m]?.ctx);
  return c > 0 ? { ctx: c, known: true } : { ctx: 0, known: false };
}
// 对话预算和一次回复的上限：跟着窗口收紧（窗口够大时就是 BUDGET / MAX_OUT）
const limitsOf = s => { const c = ctxOf(s); return budgetOf({ ctx: c.ctx, known: c.known, budget: BUDGET, maxOut: MAX_OUT }); };

// ---------- 提示词 ----------
// 日期按天变、模型换了才变：前缀照样能复用。写明当前模型：会话中途换了模型，新模型会跟着历史里旧模型的自我介绍说（「我是通义千问」）
// 命令要放进标了语言的代码块、一行一条（网页会给每条加复制图标、多条的能下载成脚本）；用户的设备由网页按浏览器判断后随消息带来（s.dev），放在最后，换设备才变。
// 设备那句只在知道时写，并且写明「要给命令时」才用：不知道就不写（小模型会把「先问系统」当成每句话都要说的）
const DEVICES = { mac: 'Mac 电脑', windows: 'Windows 电脑', linux: 'Linux 电脑', chromeos: 'Chromebook', iphone: 'iPhone', ipad: 'iPad', android: '安卓手机 / 平板', harmony: '鸿蒙手机' };
const devLine = d => !DEVICES[d] ? ''
  : /^(iphone|ipad|android|harmony)$/.test(d) ? `\n用户在用${DEVICES[d]}和你对话；只有要给电脑命令、又不知道电脑是什么系统时，才先问一句。`
  : `\n用户在用${DEVICES[d]}和你对话；要给命令时按这个系统给${d === 'windows' ? '（默认 PowerShell）' : ''}，用户说了别的系统就按说的给。`;
// 模型够不够用技能、命令：能力档到 L2 才给（档位怎么定见 kuai-profiles.mjs）——不到的跟不住「先读说明、再写命令、再按结果回复」这几步，清单还拖慢首字
// 参数量：Ollama 报的优先（名字里没写的也有），没有就看名字；窗口是猜的（known=false）时不拿它限档
// 小测验的结果：版本对得上、测完了的才算；Ollama 上模型重新拉过（修改时间变了）就不算
const quizOf = m => { const q = learned[lkey(m)]?.quiz, mod = metaOf(m).mod; return q && q.v === QUIZ_V && q.at && (!mod || !q.mod || q.mod === mod) ? q : null; };
// s.tierForce：小测验用的假会话，档位是定死的。s.down：这个会话里调用出错多，降了档（从现在做出来的最高一档 L2 往下降）
const tierNow = s => {
  if (s.tierForce != null) return { tier: s.tierForce, why: '小测验', auto: false };
  const c = ctxOf(s), q = quizOf(s.model);
  const t = tierOf({ model: s.model, size: metaOf(s.model).size ?? undefined, user: MODEL_INFO[s.model]?.tier, quiz: q ? { tier: q.tier, ...quizCount(q.pass) } : null, ctx: c.known ? c.ctx : 0 });
  return s.down && t.tier > 0 ? { ...t, tier: Math.max(0, Math.min(t.tier, TIER_BUILT) - s.down), why: t.why + '；这个会话里调用出错多，降了一档' } : t;
};
const bigEnough = s => tierNow(s).tier >= 2;
const skillsFor = s => s.quiz ? QUIZ_SKILLS : SKILLS;
const skillsOn = s => skillsFor(s).length > 0 && bigEnough(s);
const cmdsOn = s => (CMDS_ON || !!s.quiz) && bigEnough(s);
const toolsOn = s => skillsOn(s) || cmdsOn(s);
const whatOf = s => skillsOn(s) && cmdsOn(s) ? '技能和简单命令' : skillsOn(s) ? '技能' : '简单命令';
// 怎么调：OpenAI 格式的接口用原生工具调用（声明一个 claw 工具；DeepSeek 这类不声明工具时会把自己的工具调用标记当文字写出来）；
// 别的格式、或者接口不收工具（回 400 后 plain）就在回复里写 claw 代码块；小测验里原生调用做不对、换成代码块就对了的模型也写代码块（s.block；实测 qwen3:1.7b 原生调用时只把命令当文字写出来，代码块就写对了）。
// 技能和简单命令走同一个工具 / 代码块：以技能名开头的是技能，别的按简单命令认
const nativeOn = s => FORMAT === 'openai' && toolsOn(s) && !s.plain && !s.block;
const egOf = s => { const l = skillsFor(s); return l.find(k => k.name === 'claw-tv') || l[0] || { name: 'claw-tv', eg: 'claw-tv "四川卫视"' }; };
const clawTool = s => { const eg = egOf(s); return { type: 'function', function: { name: 'claw', description: '运行 claclaw 技能或简单命令：read 技能名（看它的说明）、技能命令（以技能名开头、不写路径），或者清单里的简单命令；一次最多 3 条',
  parameters: { type: 'object', properties: { commands: { type: 'array', items: { type: 'string' }, description: '比如 ' + JSON.stringify(['read ' + eg.name]) + '、' + JSON.stringify([eg.eg]) + '、["df -h"]' } }, required: ['commands'] } } }; };
const cwdLine = s => { const wd = cwdOf(s); return wd === HOME_REAL ? '命令在主目录 ~ 里跑，相对路径从这里算；隐藏文件、~/Library 不能碰。'
  : `命令在会话目录 ${tilde(wd)} 里跑，相对路径从这里算；主目录下这个目录以外的文件、隐藏文件不能碰。`; };
const OS = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[process.platform] || process.platform;
const toolsText = s => {
  const sk = skillsOn(s), cm = cmdsOn(s), what = whatOf(s), use = sk && cm ? '要用时' : '要用' + what + '时', eg = egOf(s);
  const how = nativeOn(s)
    ? `${use}调用 claw 工具。` + (sk ? `第一次用某个技能先读它的说明（commands 写 ${JSON.stringify(['read ' + eg.name])}），读过就照说明写命令（以技能名开头，不写路径），比如 ${JSON.stringify([eg.eg])}。` : '') + (cm ? `命令照常写，比如 ["df -h"]。` : '')
    : `${use}，回复里写一个 claw 代码块就停下，等结果。` + (sk ? `第一次用某个技能先读它的说明：
\`\`\`claw
read ${eg.name}
\`\`\`
读过就照说明写命令（一行一条，最多 3 条，以技能名开头，不写路径），比如：
\`\`\`claw
${eg.eg}
\`\`\`` : '') + (cm ? (sk ? '\n' : '') + `命令也写在 claw 代码块里（一行一条，最多 3 条），比如：
\`\`\`claw
df -h
\`\`\`` : '');
  return `

你还能用 claclaw 的${what}：命令由 claclaw 在它所在的电脑（${OS}）上替你跑，结果再发给你。` + (sk ? `技能有（每个只写了一句，怎么用在它的说明里）：
${skillsFor(s).map(k => '- ' + k.name + '：' + k.brief).join('\n')}
` : '\n') + (cm ? `简单命令：${cmdList(false)} 直接跑；${cmdList(true)} 要用户在网页上点确认。不经 shell：不能用管道、重定向、cd（~ 和通配符可以用）。${cwdLine(s)}别的命令跑不了，就给出命令让用户自己跑。
` : '') + how + `
结果回来后${sk && cm ? '接着回答用户，用了技能就照它的说明回复（要原样贴的代码块原样贴）。用不上就直接回答，不要提这些' : sk ? '照技能说明回复用户（要原样贴的代码块原样贴）。用不上技能就直接回答，不要提技能' : '接着回答用户。用不上就直接回答，不要提简单命令'}。`;
};
const systemOf = s => `你是 kuAi，claclaw 自带的答疑助手，简洁回答；用户用什么语言就用什么语言。今天是 ${new Date().toLocaleDateString('sv')}。
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
  const B = limitsOf(s).budget;
  if (size(s.from) <= B) return;
  const starts = m.map((x, i) => x.role === 'user' && !x.tool ? i : -1).filter(i => i >= 0);
  for (const i of starts) {
    if (i <= s.from || i === starts.at(-1)) continue;
    s.from = i;
    if (size(i) <= B * 0.6) break;
  }
}

// ---------- 调模型 ----------
// 有的模型（如 Ollama 的 qwen3:4b，模板里已经替它写了 <think>）关思考时服务端不再分离思考，输出以「思考…</think>回答」的样子混在正文里：
// 只取 </think> 之后的；没写完的 <think> 后面也先不显示。碰到这种模型记下来（noOff），之后不再发 reasoning_effort=none
const clean = full => { const k = full.lastIndexOf('</think>'); return k >= 0 ? full.slice(k + 8).replace(/^\s+/, '') : full.replace(/<think>[\s\S]*$/, ''); };
// 三种接口格式（模型库里一家有几种时，claclaw 按 openai → anthropic → gemini 挑一种传进来）。
// plain：接口不收调参（temperature、关思考那几项，比如 OpenAI 官方的推理模型）回 400 时，去掉重试一次，成了就记下来以后都不发
// opt.fill：这次是填空（L1）——填空说明接在最后一条用户消息后面，不带工具，输出约束成那个 JSON（接口不收约束 noFmt 就只靠说明）
function reqOf(s, extra = [], opt = {}) {
  const system = systemOf(s), msgs = [...history(s), ...extra], tune = !s.plain, fill = opt.fill || null;
  if (fill && msgs.at(-1)?.role === 'user') msgs[msgs.length - 1] = { ...msgs.at(-1), content: (msgs.at(-1).content || '') + fillAsk(fill) };
  const schema = fill && !s.noFmt ? fillSchema(fill) : null;
  // 采样、思考按模型画像来：拿不准的不发。plain（接口回过 400）：这些都不带。
  // 思考：开 → 画像里的开法；关 → 画像里的关法；关不掉的（画像里没有关法，或者试出来关不掉 noOff）不发，让服务端自己把思考分出去
  const prof = profileOf({ model: s.model, format: FORMAT, host: HOST }), maxOut = limitsOf(s).maxOut;
  const samp = tune ? prof.sampling[s.think ? 'on' : 'off'] : {};
  // 填空时输出被约束成 JSON，第一个字就得是 {，思考混不进来：关不掉思考的模型（noOff）这时照样发关思考（实测 qwen3:4b：发了 29 秒填完，不发要先想一两分钟）
  const think = !tune ? null : s.think && !schema ? prof.think.on : s.noOff && !schema ? null : prof.think.off;
  if (FORMAT === 'anthropic') return {
    url: BASE + '/v1/messages', headers: { 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    // 不带 thinking 就是不思考；max_tokens 要比思考预算大
    body: { model: s.model, stream: true, max_tokens: maxOut, system,
      messages: msgs.map(x => x.images ? { role: x.role, content: [...x.images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.mime, data: i.data } })), ...(x.content ? [{ type: 'text', text: x.content }] : [])] } : { role: x.role, content: x.content }),
      ...(think && s.think ? { thinking: think, max_tokens: maxOut + (think.budget_tokens || 0) } : {}) },
  };
  if (FORMAT === 'gemini') return {
    url: BASE + '/models/' + encodeURIComponent(String(s.model).replace(/^models\//, '')) + ':streamGenerateContent?alt=sse', headers: { 'x-goog-api-key': KEY },
    // 接口不收系统提示的模型（Gemma 1–3）：并进第一条用户消息
    body: { ...(prof.system === 'user' ? {} : { systemInstruction: { parts: [{ text: system }] } }),
      contents: msgs.map((x, i) => ({ role: x.role === 'assistant' ? 'model' : 'user', parts: [...(prof.system === 'user' && i === 0 ? [{ text: system }] : []), ...(x.images || []).map(i => ({ inline_data: { mime_type: i.mime, data: i.data } })), ...(x.content || !x.images ? [{ text: x.content }] : [])] })),
      generationConfig: { maxOutputTokens: maxOut, ...(samp.temperature != null ? { temperature: samp.temperature } : {}), ...(samp.top_p != null ? { topP: samp.top_p } : {}), ...(think && Object.keys(think).length ? { thinkingConfig: think } : {}),
        ...(schema ? { responseMimeType: 'application/json', responseSchema: geminiSchema(schema) } : {}) } },
  };
  const native = nativeOn(s) && !fill;
  return {
    url: BASE + '/chat/completions', headers: { authorization: 'Bearer ' + KEY },
    body: { model: s.model, stream: true, stream_options: { include_usage: true }, max_tokens: maxOut, ...(native ? { tools: [clawTool(s)] } : {}),
      // calls / tool：这一轮里原生调技能的来回（模型的 tool_calls、技能结果）
      messages: [{ role: 'system', content: system }, ...msgs.map(x => x.calls ? { role: 'assistant', content: x.content || null, tool_calls: x.calls.map(c => ({ id: c.id, type: 'function', function: { name: 'claw', arguments: JSON.stringify({ commands: c.lines }) } })) }
        : x.role === 'tool' ? { role: 'tool', tool_call_id: x.toolId, content: x.content } : x.images ? { role: x.role, content: [...(x.content ? [{ type: 'text', text: x.content }] : []), ...x.images.map(i => ({ type: 'image_url', image_url: { url: 'data:' + i.mime + ';base64,' + i.data } }))] } : { role: x.role, content: x.content })],
      ...samp, ...(think || {}), ...(schema ? { response_format: { type: 'json_schema', json_schema: { name: 'fill', strict: true, schema } } } : {}) },
  };
}
// Gemini 的 responseSchema：类型名大写，不认 additionalProperties
const geminiSchema = x => Array.isArray(x) ? x.map(geminiSchema) : x && typeof x === 'object'
  ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== 'additionalProperties').map(([k, v]) => [k, k === 'type' && typeof v === 'string' ? v.toUpperCase() : k === 'enum' ? v.filter(Boolean) : geminiSchema(v)])) : x;
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
async function post(s, signal, extra, opt) {
  const q = reqOf(s, extra, opt);
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
async function chat(s, signal, onText, onThought, extra, calls = [], opt = {}) {
  const t0 = Date.now();
  let call = { at: t0, req: reqRec(reqOf(s, extra, opt)) }; calls.push(call);
  const fail = (c, e) => { c.ms = Date.now() - c.at; if (e.name === 'AbortError') c.cancelled = true; else c.err = String(e.message).slice(0, 2000); };
  let r;
  try {
    r = await post(s, signal, extra, opt);
    if (r.status === 400 && opt.fill && !s.noFmt && FORMAT !== 'anthropic') {   // 填空：接口不收约束输出（DeepSeek 只收 json_object）→ 去掉，只靠提示里的说明；成了就按模型记下
      const b = await r.text();
      Object.assign(call, { status: 400, ms: Date.now() - call.at, err: errOf(400, b).slice(0, 2000), body: b.slice(0, 4000), plain: !!s.plain });
      s.noFmt = true;
      call = { at: Date.now(), retry: true, req: reqRec(reqOf(s, extra, opt)) }; calls.push(call);
      r = await post(s, signal, extra, opt);
      if (r.ok) learn(s.model, 'noFmt', true); else if (r.status === 400) s.noFmt = false;   // 还是 400：不是约束输出的事，换回来，接着按调参的路子试
    }
    if (r.status === 400 && !s.plain) {
      const first = await r.text();
      Object.assign(call, { status: 400, ms: Date.now() - call.at, err: errOf(400, first).slice(0, 2000), body: first.slice(0, 4000), plain: false });
      s.plain = true;
      call = { at: Date.now(), retry: true, req: reqRec(reqOf(s, extra, opt)) }; calls.push(call);
      r = await post(s, signal, extra, opt);
      if (!r.ok) {   // 重试还是 400：不是调参的事，换回来、报第一次的原话；别的错（503 忙、429 超额）：调参确实不收，记下，报这次的原话
        const b2 = await r.text().catch(() => ''); call.status = r.status; call.body = b2.slice(0, 4000);
        if (r.status === 400) { s.plain = false; throw new Error(errOf(400, first) + imgHint(400, call)); }
        throw new Error(errOf(r.status, b2, r.headers) + imgHint(r.status, call));
      }
    }
    call.status = r.status; call.plain = !!s.plain;
    if (r.ok && s.plain) learn(s.model, 'plain', true);   // 去掉调参才成的：按模型记下，别的会话不用再撞一次 400
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
// 原生调的 claw 工具 → 和代码块一样的 { lines }，多带 id（结果按 id 发回去）；同时调了几次只认第一次。
// 调的不是 claw、参数认不出来：lines 是空的（那次不跑，告诉模型格式不对）
function nativeBlock(r, step) {
  const c = r.calls?.find(x => x.name === 'claw') || r.calls?.[0];
  if (!c) return null;
  if (c.name !== 'claw') return { id: c.id || 'call_' + step, at: r.text.length, end: r.text.length, lines: [] };
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
  return wrapResult(s, used, outs, docs);
}
// 发给模型的结果：outs 一条命令一段，docs 是没读过说明就用了的技能（附上说明）
function wrapResult(s, used, outs, docs = []) {
  const doc = docs.map(k => '\n\n[' + k.name + ' 的说明（你没读过，照里面的「怎么回复」回复）]\n' + k.md.replace(/~\/\.claclaw\/bin\//g, '')).join('');
  const more = nativeOn(s) ? '再调用 claw 工具' : '再写一个 claw 代码块';
  return used ? '[技能结果]\n' + outs.join('\n\n') + doc + '\n\n照技能说明回复用户；还要用技能就' + more + '。'
    : '[命令结果]\n' + outs.join('\n\n') + '\n\n接着回答用户；还要跑命令就' + more + '。';
}

// ---------- 简单命令 ----------
// 名字 → { ask：有动静的，要用户在网页上点确认；no(args)：不让跑的原因；fix(args)：改参数 }。别的只读，直接跑。
// 不经 shell：管道、重定向、命令替换一律不收；开头的 ~、$HOME 和没加引号的通配符这边展开（展开不带隐藏文件，和 shell 一样）；只按名字在 PATH 里找（写了路径也只认名字）。
// 环境变量只给 PATH、HOME 这几个（kuAi 进程里有 API Key，不能带过去）；工作目录是主目录，20 秒超时，输出超过 10 万字就停。
// 隐藏的目录和文件（.ssh、.claclaw、.env……）、~/Library、claclaw 的 data、/dev，以及名字像密钥、密码的文件不碰（链接按真实位置算）。
// 协同 / 群里别人转来的那一轮（session/prompt 的 _meta.peer）每条都要确认（claclaw 那边先过 peerguard）
const CMD_MS = 20000, CMD_OUT = 100000;
const flags = a => a.filter(x => /^-[^-]/.test(x)).join('');   // 短选项拼在一起看（-rn 里有 r）
const CMDS = {
  date: {}, cal: {}, uptime: {}, whoami: {}, hostname: {}, uname: {}, sw_vers: {}, pwd: {}, which: {}, echo: {},
  df: {}, stat: {}, wc: {}, head: {}, cat: {}, md5: {}, shasum: {}, vm_stat: {}, system_profiler: {},
  file: { no: a => /C/.test(flags(a)) ? 'file 不能 -C（会写文件）' : '' },
  tail: { no: a => /[fF]/.test(flags(a)) || a.some(x => /^--follow/.test(x)) ? 'tail 不能 -f（停不下来）' : '' },
  grep: { no: a => /[rR]/.test(flags(a)) || a.some((x, i) => /^--(recursive|dereference-recursive|directories=recurse)$/.test(x) || (x === '-d' && a[i + 1] === 'recurse')) ? 'grep 不能搜整个目录（-r），把要搜的文件写出来' : '' },
  find: { no: a => a.some(x => /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls|print0|printf)$/.test(x)) ? 'find 不能带 -exec、-delete、-print0 这类' : '', out: dropHidden },
  du: { out: dropHidden },
  ls: { no: a => /R/.test(flags(a)) && /[aA]/.test(flags(a)) ? 'ls 不能连隐藏的一起递归列（-R 和 -a 不能一起用）' : '' },
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
// find、du 会钻进隐藏目录：输出里路径带隐藏的一段（./.ssh/…）的行不给，末尾说一句
function dropHidden(t) {
  const lines = t.split('\n'), keep = lines.filter(l => !/(^|[/\s])\.(?!\.?(?:\/|\s|$))[^/\s]/.test(l));
  return keep.join('\n') + (keep.length < lines.length ? '\n（另有 ' + (lines.length - keep.length) + ' 行在隐藏目录里，没给出）' : '');
}
const cmdList = ask => Object.keys(CMDS).filter(k => !!CMDS[k].ask === ask).join(' ');
// 真实位置：不存在的按上一级的真实位置拼（mkdir、touch 的新名字）
// 用 native：macOS 默认不分大小写，~/LIBRARY 也是 ~/Library，native 会还原成磁盘上的写法；不存在的一段段往上找到存在的那级再拼回去
function realOf(p) {
  let head = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(head), ...rest); } catch {}
    const up = path.dirname(head);
    if (up === head) return path.resolve(p);
    rest.unshift(path.basename(head)); head = up;
  }
}
// 比较路径：macOS / Windows 默认不分大小写（新建的名字 native 还原不了大小写，比较时一律按小写）
const fold = process.platform === 'darwin' || process.platform === 'win32' ? x => x.toLowerCase() : x => x;
const NO_GO = [path.join(HOME, 'Library'), path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data'), process.env.CLACLAW_DATA,
  path.basename(DIR) === 'kuai-sessions' ? path.dirname(DIR) : '', '/dev'].filter(Boolean).map(realOf);
const SECRET = /(credential|secret|token|passw|id_rsa|id_ed25519|id_ecdsa|keychain|cookies?$|\.(pem|key|p12|pfx|kdbx)$)/i;
// 命令在会话的目录里跑（新建会话时选的；没有、不是目录就用主目录）。不是主目录时就是「小目录」：主目录下这个目录以外的个人文件不碰（系统目录照常能看）；
// 会话目录本身是隐藏目录下的（用户自己选的）也照常用，只是目录里面的隐藏文件不碰
const HOME_REAL = realOf(HOME);
const inside = (p, d) => { p = fold(p); d = fold(d); return p === d || p.startsWith(d + path.sep); };
function cwdOf(s) { try { const d = realOf(s.cwd || HOME); return fs.statSync(d).isDirectory() ? d : HOME_REAL; } catch { return HOME_REAL; } }
// 一个参数碰不碰得。选项里可能连着写了路径：--file=X 看 = 后面；短选项（-f.env、-of.env）把第 2 个字符起的每一段都当路径看一遍
function badPath(arg, wd = HOME_REAL) {
  if (!arg.startsWith('-')) return badOne(arg, wd);
  const eq = arg.indexOf('='), parts = eq > 0 ? [arg.slice(eq + 1)] : [];
  if (!arg.startsWith('--')) for (let i = 2; i < arg.length; i++) parts.push(arg.slice(i));
  for (const x of parts) { const why = badOne(x, wd); if (why) return why; }
  return '';
}
// 一段要是路径（带 / 或 ~，或者当前目录下有这个名字；网址不算）：碰不碰得
function badOne(v, wd) {
  if (!v || /^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return '';
  if (!/[/~]/.test(v) && !fs.existsSync(path.join(wd, v))) return '';
  const abs = realOf(path.resolve(wd, v.replace(/^~(?=\/|$)/, HOME)));
  v = tilde(v);   // 说的时候照模型的写法
  if ((inside(abs, wd) ? path.relative(wd, abs) : abs).split(path.sep).some(c => c.startsWith('.'))) return v + ' 是隐藏的目录 / 文件，不能碰';
  if (fold(wd) !== fold(HOME_REAL) && inside(abs, HOME_REAL) && !inside(abs, wd)) return v + ' 在会话目录（' + tilde(wd) + '）外面，不能碰';
  if (NO_GO.some(d => inside(abs, d))) return v + ' 所在的目录不能碰';
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
  if (c.out) r.out = c.out(r.out.trim());
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
// 思考混进正文了（关思考的参数这个模型不认）：按模型记下，之后不再发
const noteLeak = (s, r) => { if (r.leaked && !s.noOff && !s.think) { s.noOff = true; learn(s.model, 'noOff', true); } };
const TIER_SAY = ['只问答', '简单技能（程序代填参数）', '技能和命令'];
const tierSay = t => TIER_SAY[Math.max(0, Math.min(t, TIER_BUILT))];

// 填空（L1）：程序认出了用户想用的技能 f。模型只填参数（参数全由程序定的不问模型），程序校验、跑技能。
// 返回 { text }（跑成了，text 是贴给用户的，不再问模型）| { ex }（跑了没成：把经过交给模型照实说）| null（不用，照常问答）
async function tryFill(s, f, text, signal, run, tally) {
  const k = skillOf(f.name);
  if (!k) return null;
  const rec = run.fill = { skill: f.name };
  let raw = '';
  if (askSlots(f).length) {
    let r;
    try { r = await chat(s, signal, () => {}, () => update(s.id, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '' } }), [], run.calls, { fill: f }); }
    catch (e) { if (e.name === 'AbortError') throw e; rec.error = String(e.message).slice(0, 300); return null; }   // 填空这一步出错：照常问答（服务真有问题的话，下面那次请求会报出来）
    tally(r); noteLeak(s, r);
    raw = r.text;
  }
  const got = parseFill(f, raw, text);
  if (!got) { rec.bad = true; return null; }
  Object.assign(rec, { slots: got.slots }, got.said != null ? { said: got.said } : {});
  const other = !got.use && got.said !== false && !!f.else && !enough(f, got.slots);   // 参数不够：有兜底的命令就跑它
  const args = got.use ? fillArgs(f, got.slots) : other ? f.else : null;
  if (!args) { rec.use = false; return null; }
  const line = rec.cmd = fillLine(f.name, args), id = 'claw-' + crypto.randomUUID().slice(0, 8);
  update(s.id, { sessionUpdate: 'tool_call', toolCallId: id, title: k.name, kind: 'execute', status: 'in_progress', rawInput: { command: line } });
  const r = await runSkill(k, args, signal);
  if (signal?.aborted) { update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: 'failed' }); throw aborted(); }
  const ok = rec.ok = r.code === 0 && !!r.out.trim();
  const out = cap(r.out.trim(), 12000) + (ok ? '' : '\n（退出码 ' + r.code + (r.err.trim() ? '：' + cap(r.err.trim(), 1500) : '') + '）');
  update(s.id, { sessionUpdate: 'tool_call_update', toolCallId: id, status: ok ? 'completed' : 'failed', content: [{ type: 'content', content: { type: 'text', text: cap(out, 4000) } }] });
  if (ok) return { text: [other ? f.elseLead : fillLead(f, got.slots), pasteOut(f, cap(r.out.trim(), 12000))].filter(Boolean).join('\n\n') };
  return { ex: [{ role: 'assistant', content: '（我用 claclaw 的「' + f.what + '」试了一下。）' },
    { role: 'user', content: '[claclaw] 刚才替你跑了 ' + line + '，没成：\n' + out + '\n\n用一两句话照实告诉用户没成、是什么原因；不要编结果，不要提命令和这段说明。' }] };
}

async function prompt(s, text, images = []) {
  stopQuiz(true);   // 后台正在测这台机器上的模型：先让路，这一轮结束后接着测
  const ac = new AbortController(); s.abort = ac;
  const um = { role: 'user', content: text, ...(images.length ? { images: images.map(i => saveImg(s.id, i.mime, i.data)) } : {}), at: Date.now() };
  s.messages.push(um);
  if (!s.title) { s.title = text.replace(/\s+/g, ' ').slice(0, 50) || '图片'; update(s.id, { sessionUpdate: 'session_info_update', title: s.title }); }
  let full = '', parts = 0, steps = 0, seg = '';   // seg：上次用技能之后写的（到了长度上限接着写时整段发回去）
  let tools = false; const ex = [], seen = new Set();                    // ex：这一轮里用技能 / 命令的来回（模型写的 claw 代码块、结果）
  const ran = new Set(); let slips = 0, again = 0, empty = false;        // ran：这一轮跑过的调用；slips：调用出错的次数（格式不对、重复调用）；again：其中重复的
  const say = t => update(s.id, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
  let kept = false;
  const keep = () => { if (full && !kept) { kept = true; s.messages.push({ role: 'assistant', content: full, model: s.model, at: Date.now(), ...(parts > 1 ? { parts } : {}) }); } };
  try {
    await loadMeta(s.model);
    if (ac.signal.aborted) throw aborted();
    if (knows(s.model, 'noOff')) s.noOff = true;   // 以前试出来的（按模型记的）：不用每个会话再试一遍
    if (knows(s.model, 'plain')) s.plain = true;
    if (knows(s.model, 'noFmt')) s.noFmt = true;
    s.block = !!quizOf(s.model)?.block;            // 小测验里试出来：这个模型原生调用不行、写代码块行
    tools = toolsOn(s);
    trim(s);
    const tier = tierNow(s), lim = limitsOf(s), win = ctxOf(s);
    // 这一轮怎么答的（给会话解剖、调 kuAi 用）：用的哪个模型、什么接口和参数、发了几条历史、丢了几条、系统提示，以及每次请求的明细
    const run = um.run = { model: s.model, api: FORMAT, host: hostOf(BASE), think: !!s.think, noOff: !!s.noOff, maxOut: lim.maxOut, budget: lim.budget, ...(win.ctx ? { ctx: win.ctx, ...(win.known ? {} : { ctxGuess: true }) } : {}), tier: tier.tier, tierWhy: tier.why, sys: systemOf(s), sent: history(s).length, dropped: s.from, calls: [] };
    let tin = 0, tout = 0, gen = 0, t0 = 0, first = 0, end = 0, stop = null;
    const tally = r => { if (!t0) { t0 = r.t0; first = r.first; } tin = r.tin || tin; tout += r.tout; end = r.end; if (r.first) gen += (r.end - r.first) / 1000; };
    // L1：这句话像是要用某个技能 → 模型填参数、程序跑。跑成了结果直接贴出来，这一轮就完了；没成、不用的接着走下面的问答
    const fl = tier.tier === 1 && !images.length ? routeFill(FILLS, text) : null;
    const filled = fl ? await tryFill(s, fl, text, ac.signal, run, tally) : null;
    if (filled?.ex) ex.push(...filled.ex);
    if (filled?.text) { full = filled.text; say(full); parts = 1; if (!t0) t0 = um.at; end = Date.now(); }
    let after = false;   // 上一次是用技能：这一段和前面写的之间空一行
    while (!filled?.text && parts < MAX_PARTS) {
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
      noteLeak(s, r);
      const blk = tools && steps < MAX_STEPS ? nativeBlock(r, steps) || clawBlock(r.text) : null;
      if (blk) {   // 用技能：代码块前面写的照常显示；跑完把结果交给模型接着写（不算「接着写」的段数）
        steps++; parts--;
        full = glue(r.text.slice(0, blk.at).replace(/\s+$/, ''));
        if (full.length > sent) say(full.slice(sent));
        // 调用出错的两种：格式不对（调了没有的工具、参数认不出来）、和刚才一模一样的调用。都不跑，告诉模型；同一轮里重复两次就不再让它调了
        const key = blk.lines.join('\n');
        let res;
        if (!blk.lines.length) { slips++; res = '[claclaw] 这次调用的格式不对，没有跑。只有 claw 一个工具，参数是 {"commands": ["命令"]}；用不上就直接回答用户。'; }
        else if (ran.has(key)) { slips++; if (++again >= 2) steps = MAX_STEPS; res = '[claclaw] 这条刚才已经跑过，结果在上面，没有再跑。不要重复调用，直接用已有的结果回答用户。'; }
        else { ran.add(key); res = await runClaw(s, blk.lines, ac.signal, seen); }
        if (blk.id) ex.push({ role: 'assistant', content: (seg + r.text).trim(), calls: [{ id: blk.id, lines: blk.lines }] }, { role: 'tool', toolId: blk.id, content: res });
        else ex.push({ role: 'assistant', content: seg + r.text.slice(0, blk.end).replace(/\s+$/, '') }, { role: 'user', content: res });
        seg = ''; after = true;
        tally(r);
        continue;
      }
      const txt = tools ? r.text.replace(/(^|\n)```claw[\s\S]*?(?:\n```[^\n]*|$)/g, '$1').replace(/\s+$/, '') : r.text;   // 技能用满了还写 claw 块：不显示
      empty = steps > 0 && !txt.trim();   // 用过技能 / 命令，最后却什么都没写（次数用满了还在调工具）
      full = glue(txt); seg += r.text; after = false;
      if (full.length > sent) say(full.slice(sent));
      tally(r); stop = r.stop;
      if (stop !== 'length' || !r.text) break;
    }
    const notes = [noteOf(stop), empty ? '模型一直在调技能 / 命令，没写出回答；已经拿到的结果在上面的卡片里' : ''].filter(Boolean).join('；');
    // 给用户的提示（不是出错）：这个会话里调用出错多了，降一档；后台的小测验测完了
    const info = [];
    if (slips) {
      s.bad = (s.bad || 0) + slips;
      if (s.bad >= 2 && !s.down && tier.tier >= 2) { s.down = 1; info.push(s.model + ' 在这个会话里调用技能 / 命令出错 ' + s.bad + ' 次（格式不对或者重复调用），先降到「' + tierSay(tierNow(s).tier) + '」；换模型或者新开会话会恢复'); }
    }
    if (quizNews.has(s.model)) { info.push(quizLine(s.model, quizNews.get(s.model))); quizNews.delete(s.model); }
    Object.assign(run, { endAt: Date.now(), parts, stop, ...(steps ? { steps } : {}), ...(slips ? { slips } : {}), ...(notes ? { note: notes } : {}) });
    keep(); save(s);
    // 生成速度只算第一个字之后的；输出太短（< 8 tok）算出的速度没意义，不报；没有 usage 的服务不报速度（估出来的不准，调试时会误导）
    const stats = { model: s.model, ttft: first ? (first - t0) / 1000 : null, outTokens: tout || null, tps: tout >= 8 && gen > 0.05 ? tout / gen : null, total: (end - t0) / 1000,
      ...(parts > 1 ? { parts } : {}), ...(notes ? { note: notes } : {}), ...(filled?.text ? { fill: fl.name } : {}), ...(info.length ? { info } : {}) };
    update(s.id, { sessionUpdate: 'usage_update', used: tin ? tin + tout : 0, size: lim.budget, _meta: { kuai: stats } });
    seeCtx(s.model);   // 模型这会儿装载着：顺手记下它实际的窗口
    autoQuiz(s.model);
    return 'end_turn';
  } catch (e) {
    if (um.run) Object.assign(um.run, { endAt: Date.now(), parts }, e.name === 'AbortError' ? { cancelled: true } : { error: String(e.message).slice(0, 500) });
    keep(); save(s);   // 停掉、出错时已经写出来的那部分也留着（网页上已经显示了）
    if (e.name === 'AbortError') return 'cancelled';
    throw e;
  } finally { s.abort = null; }
}

// ---------- 上岗小测验（题目、假结果、判分在 kuai-quiz.mjs） ----------
// 用的就是平时那套请求（systemOf / reqOf / chat），只是会话是假的（不落盘、档位定死）、技能和命令不真跑。
// 一个进程一次只测一个模型；测到哪题记到哪题（没测完的没有 at），后台自动测的被新消息打断后下次接着测。
// 每题的经过另存一份在 KUAI_LEARN 旁边的 kuai-quiz/ 里（调题目、看模型怎么错的时候用）
let quizRun = null;                 // 正在测的：{ model, ac, auto, promise }
const quizNews = new Map();         // 模型 → 后台测完、还没告诉用户的结果
const quizFails = new Map();        // 模型 → 这个进程里自动测出错的次数（两次就不再自动试）；被新消息打断算半次（打断四回也不再试，免得聊着天一直在后台占 CPU，要测去模型管理里点）
const QUIZ_DIR = path.join(path.dirname(LEARN), 'kuai-quiz');
const stopQuiz = onlyAuto => { if (quizRun && (!onlyAuto || quizRun.auto)) quizRun.ac.abort(); };
const quizSession = (model, tierForce, block = false) => ({ id: 'quiz', quiz: true, tierForce, block, cwd: HOME, model, think: false, noOff: knows(model, 'noOff'), plain: knows(model, 'plain'), noFmt: knows(model, 'noFmt'), messages: [], from: 0 });
const quizLine = (m, q) => { const c = quizCount(q.pass); return m + ' 的上岗小测验做完了：' + c.of + ' 题过 ' + c.pass + ' 题，' + (MODEL_INFO[m]?.tier != null ? '测出来是「' + tierSay(q.tier) + '」（模型库里手动设了能力档，以手动的为准）' : '放开到「' + tierSay(q.tier) + '」'); };
// 一道题 → 过没过。rec：这道题的经过（请求明细、模型要跑的命令、最后的回答）
async function askQuiz(qn, model, signal, rec, block = false) {
  const calls = rec.calls = [], noop = () => {};
  const s = quizSession(model, qn.key === 'fill' ? 1 : 2, block);
  s.messages = [{ role: 'user', content: qn.text }];
  if (qn.key === 'fill') {
    const r = await chat(s, signal, noop, noop, [], calls, { fill: QUIZ_FILL });
    noteLeak(s, r);
    const fill = parseFill(QUIZ_FILL, r.text, qn.text);
    rec.fill = fill?.slots || null;
    return grade('fill', { fill });
  }
  const ex = [], lines = [];
  let text = '';
  for (let step = 0; step < qn.steps; step++) {
    const r = await chat(s, signal, noop, noop, ex, calls);
    noteLeak(s, r);
    const blk = nativeBlock(r, step) || clawBlock(r.text);
    if (!blk) { text = r.text; break; }
    lines.push(...blk.lines);
    if (qn.key === 'chat' || !blk.lines.length || settled(qn.key, { lines })) break;   // 已经有结论了，不用往下跑
    const rs = blk.lines.map(l => ({ l, ...fakeRun(l) }));
    const res = wrapResult(s, rs.some(x => x.skill), rs.map(x => '$ ' + x.l + '\n' + x.out), [...new Set(rs.map(x => x.doc).filter(Boolean))].map(n => QUIZ_SKILLS.find(k => k.name === n)));
    if (blk.id) ex.push({ role: 'assistant', content: r.text.trim(), calls: [{ id: blk.id, lines: blk.lines }] }, { role: 'tool', toolId: blk.id, content: res });
    else ex.push({ role: 'assistant', content: r.text.slice(0, blk.end).replace(/\s+$/, '') }, { role: 'user', content: res });
  }
  rec.lines = lines; if (text) rec.text = text.slice(0, 500);
  return grade(qn.key, { lines, text });
}
function runQuiz(model, { auto = false } = {}) {
  if (quizRun) {
    if (quizRun.model !== model) return Promise.reject(new Error('正在测 ' + quizRun.model + '，等它测完再测这个'));
    if (!auto) quizRun.auto = false;   // 后台正测着、用户又点了：算用户要的，来了新消息也不停
    return quizRun.promise;
  }
  const ac = new AbortController(), job = quizRun = { model, ac, auto };
  const tell = p => send({ method: '_kuai/quiz', params: { model, ...p } });
  job.promise = (async () => {
    const log = [];
    try {
      await loadMeta(model);
      const mod = metaOf(model).mod || '', old = learned[lkey(model)]?.quiz;
      const resume = auto && old && old.v === QUIZ_V && !old.at && (old.mod || '') === mod;   // 自动测的接着上次没测完的做；手动点的从头来
      const pass = resume ? { ...old.pass } : {};
      let ms = resume ? Number(old.ms) || 0 : 0;
      let slow = new Set(resume && Array.isArray(old.slow) ? old.slow : []);   // 因为太慢没过的题
      // 做一遍题：p 里没做的接着做（工具题错一题就停）。block：工具题改用代码块的写法；late：这一遍里太慢的题记在哪
      const round = async (p, block, lateSet) => {
        for (let qn; (qn = nextQuestion(p));) {
          tell({ state: 'running', done: Object.keys(p).length, of: QUESTIONS.length, name: qn.name + (block ? '（换成代码块的写法再试）' : '') });
          const rec = { key: qn.key, ...(block ? { block } : {}) }, t0 = Date.now(), qc = new AbortController(), limit = QUIZ_STEP_MS * (qn.steps || 1);
          let late = false;
          const to = setTimeout(() => { late = true; qc.abort(); }, limit), stop = () => qc.abort();
          ac.signal.addEventListener('abort', stop, { once: true });
          if (ac.signal.aborted) qc.abort();
          log.push(rec);
          try { p[qn.key] = await askQuiz(qn, model, qc.signal, rec, block); }
          catch (e) { if (!late || ac.signal.aborted) throw ac.signal.aborted ? aborted() : e; p[qn.key] = false; lateSet.add(qn.key); rec.error = '太慢：超过 ' + Math.round(limit / 1000) + ' 秒没做完'; }
          finally { clearTimeout(to); ac.signal.removeEventListener('abort', stop); }
          rec.pass = p[qn.key]; rec.ms = Date.now() - t0; ms += rec.ms;
          if (!block) learn(model, 'quiz', { v: QUIZ_V, pass: { ...p }, ms, mod, ...(slow.size ? { slow: [...slow] } : {}) });   // 进度（没有 at = 没测完）
        }
      };
      await round(pass, false, slow);
      // 原生调用没到 L2、又不是因为慢：工具题换成代码块的写法再做一遍，更好就用它（以后这个模型都写代码块）。闲聊那题过了的不重做（本机小模型一题要一分钟）
      let block = false;
      const p0 = quizSession(model, 2);
      if (quizTier(pass) < 2 && nativeOn(p0) && !TOOL_KEYS.some(k => slow.has(k))) {
        const alt = { fill: pass.fill, ...(pass.chat ? { chat: true } : {}) }, slow2 = new Set();
        await round(alt, true, slow2);
        if (quizTier(alt) > quizTier(pass)) { Object.assign(pass, alt); block = true; slow = slow2; }
      }
      for (const q of QUESTIONS) if (!(q.key in pass)) pass[q.key] = null;   // 没做的：前面错了，后面的档到不了，不用做
      const q = { v: QUIZ_V, at: Date.now(), tier: quizTier(pass), pass, ms, mod, ...(block ? { block } : {}), ...(slow.size ? { slow: [...slow].filter(k => pass[k] === false) } : {}) };
      learn(model, 'quiz', q);
      if (auto) quizNews.set(model, q);
      tell({ state: 'done', quiz: q });
      return q;
    } catch (e) {
      tell(e.name === 'AbortError' ? { state: 'stopped' } : { state: 'error', error: String(e.message).slice(0, 300) });
      throw e;
    } finally {
      quizRun = null;
      try { fs.mkdirSync(QUIZ_DIR, { recursive: true, mode: 0o700 }); writeJsonAtomic(path.join(QUIZ_DIR, (HOST + '_' + model).replace(/[^A-Za-z0-9_.-]+/g, '_') + '.json'), { host: HOST, model, at: new Date().toISOString(), log }, 0); } catch {}
    }
  })();
  job.promise.catch(() => {});
  return job.promise;
}
// 本机的模型（没手动设能力档、还没测过的）：这一轮结束后过一会儿在后台测。云上的不自动测（花钱、占额度），在模型管理里点了才测
function autoQuiz(model) {
  if (!QUIZ_AUTO || !LOCAL || quizRun || quizOf(model) || MODEL_INFO[model]?.tier != null || (quizFails.get(model) || 0) >= 2) return;
  const t = setTimeout(() => {
    if (quizRun || [...sessions.values()].some(x => x.abort)) return;   // 又有会话在回复：等它那一轮结束再说
    runQuiz(model, { auto: true }).catch(e => quizFails.set(model, (quizFails.get(model) || 0) + (e.name === 'AbortError' ? 0.5 : 1)));
  }, QUIZ_WAIT);
  t.unref?.();
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

// 换模型：noOff / plain / noFmt 是按模型试出来的，换了就重新试（不然从回 400 的模型换到 Ollama，思考就关不掉了）；调用出错的次数、降的档也重新算
function setModel(s, m) { if (m !== s.model) { s.noOff = false; s.plain = false; s.noFmt = false; s.bad = 0; s.down = 0; } s.model = m; }

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
  // 小测验：模型管理里点「测一下」（从头测，测完才回；进度另发 _kuai/quiz 通知）
  '_kuai/quiz': p => { const m = String(p.model || '').trim(); if (!m) throw new Error('没说测哪个模型'); return runQuiz(m); },
  '_kuai/quiz_stop': () => { stopQuiz(false); return {}; },
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
