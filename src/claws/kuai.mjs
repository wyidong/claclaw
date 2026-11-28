// kuAi（代码、数据目录叫 kuai，会话 id 前缀 ku:）：claclaw 自带的问答 agent，能力够的模型还能用 claclaw 的技能和几条简单命令（只读的直接跑，有动静的要确认，见 kuai-agent.mjs）；接模型库里的模型（尤其本地 Ollama）答疑、看模型快不快。
// agent 本体在 kuai-agent.mjs（ACP，stdin/stdout）。每轮结束显示一行：模型 · 首字耗时 · 生成速度。
// - 会话：agent 把每个会话存成 data/kuai-sessions/<id>.json（title / cwd / model / messages…）；历史靠 session/load 重放
// - 模型：模型库里的都能选（OpenAI 兼容 / Anthropic / Gemini 三种接口，一家有几种时按这个顺序挑一种）。一个进程只连一家供应商，每家各起一个进程，会话各走各的（同一个群里几个会话可以同时用不同家的模型）；本机地址（127.0.0.1 / localhost）的排最前；
//   会话走哪家记在 data/kuai-route.json 的 sessions（没记的按会话的模型认，认不出走默认那家）；provider 是新会话默认走的（最近选的那家）
// - 能力档（kuai-profiles.mjs）：L1 程序代填参数跑技能，到 L2 的模型自己用技能和命令，到 L3 的再多读文件、搜内容、取网页（只读，一轮里能连着查几步）；L4 动手（改文件、经 shell 跑清单外的命令，每一次都要用户点确认；不自动给，要手动设）；模型库里每个模型可以手动设（tier），随 KUAI_MODEL_INFO 传给 agent；
//   没设的按上岗小测验的结果（本机的模型 agent 自己在后台测，云上的在模型管理里点「测一下」→ kuQuizStart），都没有才按参数量估
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：把会话文件挪进回收站
// 网页里 kuAi 会话的 id = 'ku:' + 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgent, AcpRunner, localNames, clipTarget } from './acp.mjs';
import { tilde, oneLine, readJson, writeJsonAtomic, hash16 } from '../util.mjs';
import { DATA } from '../auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels, hostOf } from '../modelpick.mjs';

const KU_PREFIX = 'ku:';
export const isKu = id => typeof id === 'string' && id.startsWith(KU_PREFIX);
const sidOf = id => id.slice(KU_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const AGENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kuai-agent.mjs');
const SESSIONS = path.join(DATA, 'kuai-sessions');
const ROUTE_FILE = path.join(DATA, 'kuai-route.json');
const LEARN_FILE = path.join(DATA, 'kuai-models.json');   // agent 按模型记下试出来的特性（关不掉思考、不收调参、实际窗口）和小测验的结果
const FMTS = ['openai', 'anthropic', 'gemini'];   // 一家有几种接口时按这个顺序挑
const epOf = x => x.p.endpoints[x.fmt];
const LOCAL = /^(127\.|localhost$|\[?::1\]?$)/;

export const kuInstalled = () => !!route();   // 模型库里有能用的模型就算装好了（agent 随 claclaw 自带）

// ---------- 会话列表 ----------
const fileCache = new Map();   // 文件路径 → { key（大小:修改时间）, row }
function parseFile(f, st) {
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  const sid = String(o.sessionId || path.basename(f, '.json'));
  if (!validSid(sid)) return null;
  return { id: sid, title: oneLine(o.title || '').slice(0, 100), cwd: String(o.cwd || ''), model: String(o.model || ''), updated: Date.parse(o.updatedAt) || st.mtimeMs, file: f };
}
function listRows() {
  const rows = [], seen = new Set();
  let names = [];
  try { names = fs.readdirSync(SESSIONS); } catch {}
  for (const n of names) {
    if (!n.endsWith('.json')) continue;
    const f = path.join(SESSIONS, n);
    let st; try { st = fs.statSync(f); } catch { continue; }
    if (!st.isFile() || !st.size) continue;
    seen.add(f);
    const key = st.size + ':' + st.mtimeMs;
    let c = fileCache.get(f);
    if (c?.key !== key) { let row = null; try { row = parseFile(f, st); } catch {} c = { key, row }; fileCache.set(f, c); }
    if (c.row) rows.push({ ...c.row, title: localNames.get(KU_PREFIX + c.row.id) || c.row.title });
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  return rows.sort((a, b) => b.updated - a.updated);
}
export function kuSessionList({ busy = () => false } = {}) {
  return listRows().map(s => ({
    id: KU_PREFIX + s.id,
    title: s.title || 'kuAi 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'kuai', busy: busy(KU_PREFIX + s.id),
  }));
}
export const kuInfo = id => isKu(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const kuExists = id => !!kuInfo(id);

// ---------- 走哪家 ----------
// 记过的那家还在就用它；没记过：本机地址的排最前，再按模型库顺序
export function pickRoute(rec, store, lib = libModels(store, FMTS)) {
  const hit = rec?.provider && lib.find(x => x.p.id === rec.provider);
  if (hit) return hit;
  return lib.find(x => LOCAL.test(hostOf(epOf(x)))) || lib[0] || null;
}
const route = (store = storeNow()) => pickRoute(readJson(ROUTE_FILE, {}), store);   // 新会话默认走的那家
const libOf = store => libModels(store, FMTS);
// 某个会话走哪家（供应商 id）：记过的那家还在就用它；没记过（旧会话）按会话存的模型在模型库里找，默认那家有这个模型就用默认那家
export function sessionPid(rec, store, sid, model, lib = libModels(store, FMTS)) {
  const p = rec?.sessions?.[sid];
  if (p && lib.some(x => x.p.id === p)) return p;
  const def = pickRoute(rec, store, lib);
  if (model && !(def && def.p.models.some(m => m.id === model))) { const hit = lib.find(x => x.m.id === model); if (hit) return hit.p.id; }
  return def?.p.id || '';
}
const pidOf = (sid, store = storeNow()) => sessionPid(readJson(ROUTE_FILE, {}), store, sid, kuInfo(KU_PREFIX + sid)?.model);
// 记下会话走哪家（provider：顺便改新会话默认走的）；删掉的会话（null）去掉
function saveRoute(sid, pid, provider) {
  const rec = readJson(ROUTE_FILE, {}), sessions = { ...(rec.sessions || {}) };
  if (sid) { if (pid == null) delete sessions[sid]; else sessions[sid] = pid; }
  writeJsonAtomic(ROUTE_FILE, { ...rec, ...(provider ? { provider } : {}), sessions });
}
// agent 按格式拼路径：openai → <base>/chat/completions（base 写到 /v1）；anthropic → <base>/v1/messages；gemini → <base>/models/<id>:streamGenerateContent（base 写到 /v1beta）
export function baseOf(fmt, url) {
  const u = String(url).replace(/\/+$/, '');
  if (fmt === 'anthropic') return u.replace(/\/v1$/, '');
  if (fmt === 'gemini') return /\/v1(beta)?$/.test(u) ? u : u + '/v1beta';
  return u.replace(/\/v1$/, '') + '/v1';
}
// agent 进程里的 fetch 按 HTTP(S)_PROXY 走代理（国外的接口直连会卡到超时）；本机、局域网地址照旧直连
function proxyEnv() {
  if (!process.env.HTTPS_PROXY && !process.env.https_proxy && !process.env.HTTP_PROXY && !process.env.http_proxy) return {};
  const no = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const h of ['localhost', '127.0.0.1', '::1']) if (!no.includes(h)) no.push(h);
  return { NODE_USE_ENV_PROXY: '1', NO_PROXY: no.join(','), no_proxy: no.join(',') };
}
function routeEnv(pid) {
  const store = storeNow(), hit = libOf(store).find(x => x.p.id === pid) || route(store), env = { KUAI_DIR: SESSIONS, ...proxyEnv() };
  // key 不放环境变量：同一个用户的任何进程都读得到别的进程启动时的环境变量（kuAi 动手档跑的命令也是）。在 initialize 里给（init）
  const key = hit?.p.key || 'none';
  if (hit) {
    env.KUAI_FORMAT = hit.fmt;
    env.KUAI_BASE_URL = baseOf(hit.fmt, epOf(hit));
    env.KUAI_MODELS = hit.p.models.map(m => m.id).join(',');
    env.KUAI_MODEL = hit.m.id;
    // 模型库里填的窗口、手动设的能力档（没设的不带）
    const info = {};
    for (const m of hit.p.models) { const x = { ...(m.context ? { ctx: m.context } : {}), ...(Number.isInteger(m.tier) ? { tier: m.tier } : {}) }; if (Object.keys(x).length) info[m.id] = x; }
    if (Object.keys(info).length) env.KUAI_MODEL_INFO = JSON.stringify(info);
  }
  env.KUAI_LEARN = LEARN_FILE;
  env.KUAI_TRASH = path.join(path.dirname(SESSIONS), 'trash');   // 改文件前原来的那份放 claclaw 的回收站（30 天后清）
  if (process.env.CLACLAW_KUAI_BUDGET) env.KUAI_BUDGET = process.env.CLACLAW_KUAI_BUDGET;
  return { env, sig: hash16(JSON.stringify(env) + '\n' + key), init: { kuai: { key } } };
}

// ---------- ACP 进程（底座见 acp.mjs）：每家供应商一个，用到才起、空闲 10 分钟自己关 ----------
const agents = new Map();   // 供应商 id（模型库里没有能用的模型时是 ''）→ AcpAgent
function agentFor(pid) {
  let ag = agents.get(pid);
  if (!ag) {
    ag = new AcpAgent({ name: 'kuAi', bin: () => process.execPath, missing: '没找到 node', command: bin => [bin, [AGENT_JS]], prepare: () => routeEnv(pid) });
    const notify = ag.onNotify.bind(ag);
    ag.onNotify = m => m.method === '_kuai/quiz' ? onQuiz(pid, m.params || {}) : notify(m);   // 小测验的进度
    agents.set(pid, ag);
  }
  return ag;
}
export const kuShutdown = () => Promise.all([...agents.values()].map(ag => ag.stop()));
export function kuModelsChanged(log) { for (const [pid, ag] of agents) ag.modelsChanged(routeEnv(pid).sig, log); }
export const kuAcpRunning = () => [...agents.values()].some(ag => ag.running);

// ---------- 上岗小测验 ----------
// 测的是 agent（它有 key、知道怎么发请求）；这边只管发起、记进度，结果由 agent 写进 LEARN_FILE。
const quizState = new Map();   // '供应商 id|模型' → { state: running | stopped | error, done, of, name, error }；测完的不留（结果在 LEARN_FILE 里）
function onQuiz(pid, p) {
  const key = pid + '|' + String(p.model || '');
  if (p.state === 'done') quizState.delete(key);
  else quizState.set(key, { state: p.state, ...(p.state === 'running' ? { done: Number(p.done) || 0, of: Number(p.of) || 0, name: String(p.name || '') } : {}), ...(p.error ? { error: String(p.error).slice(0, 300) } : {}) });
}
// 模型管理里点「测一下」：起好那家的进程，开始测就返回（本机小模型要测几分钟，网页自己轮询进度）
export async function kuQuizStart(pid, model, log) {
  const hit = libOf(storeNow()).find(x => x.p.id === pid && x.m.id === model);
  if (!hit) throw Object.assign(new Error('kuAi 用不了这个模型（模型库里没有，或者它的接口格式 kuAi 不支持）'), { user: true });
  const key = pid + '|' + model;
  if (quizState.get(key)?.state === 'running') return;
  const ag = agentFor(pid);
  await ag.use(log);
  quizState.set(key, { state: 'running', done: 0, of: 0, name: '' });
  log?.('kuai quiz start', pid, model);
  ag.rpc('_kuai/quiz', { model }).then(q => log?.('kuai quiz done', pid, model, 'L' + q?.tier), e => {
    log?.('kuai quiz failed', pid, model, e.message);
    if (quizState.get(key)?.state === 'running') quizState.set(key, { state: 'error', error: String(e.message).slice(0, 300) });   // 进程没了之类：agent 来不及报
  }).finally(() => ag.idleCheck());
}
// 模型库里每个模型在 kuAi 这边的情况（给模型管理页）：{ 供应商 id: { 模型: { quiz: { tier, pass, of, at, each（每题过没过）, slow（因为太慢没过的题） }, run: { state, done, of, name, error } } } }
export function kuModelNotes(store = storeNow()) {
  const learned = readJson(LEARN_FILE, {}), out = {};
  for (const x of libOf(store)) {
    const host = hostOf(baseOf(x.fmt, epOf(x))), q = learned?.[host + '|' + x.m.id]?.quiz, run = quizState.get(x.p.id + '|' + x.m.id);
    const each = q?.at && q.pass && typeof q.pass === 'object' ? q.pass : null;
    if (run?.state === 'running' && !agents.get(x.p.id)?.running) quizState.delete(x.p.id + '|' + x.m.id);   // 测到一半进程没了（空闲关掉、claclaw 重启）
    const note = { ...(each ? { quiz: { tier: q.tier, pass: Object.values(each).filter(v => v === true).length, of: Object.keys(each).length, at: q.at, each, ...(Array.isArray(q.slow) && q.slow.length ? { slow: q.slow } : {}) } } : {}), ...(quizState.has(x.p.id + '|' + x.m.id) ? { run } : {}) };
    if (Object.keys(note).length) (out[x.p.id] ||= {})[x.m.id] = note;
  }
  return out;
}

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
];

// ---------- 打开的 kuAi 会话 ----------
export const kuRunners = new Map();

export class KuRunner extends AcpRunner {
  static get agent() { return agentFor(route()?.p.id || ''); }   // 新建会话用默认那家；已有的会话在构造时换成它自己那家的
  static onCreated(sid) { saveRoute(sid, route()?.p.id || ''); }
  static prefix = KU_PREFIX; static runners = kuRunners;
  static label = 'kuAi'; static group = 'kuAi'; static permPrefix = 'ku-'; static commands = COMMANDS;
  // 确认条的问法：agent 在 toolCall._meta.title 里给了就用它的（装软件、打开网址——光看一条命令用户不知道在问什么）
  // agent 自己给的问法（title）、确认条上显示什么（target：改文件时是改动的对比）、「不再问」那个选项上的字（always）
  permInfo(tc, known) {
    const i = super.permInfo(tc, known), m = tc?._meta || {}, str = v => typeof v === 'string' && v.trim() ? v.trim() : '';
    return { ...i, ...(str(m.title) ? { title: str(m.title).slice(0, 80) } : {}), ...(str(m.target) ? { target: clipTarget(str(m.target)) } : {}), ...(str(m.always) ? { alwaysLabel: str(m.always).slice(0, 40), alwaysNote: '这个会话里这条命令不再询问' } : {}) };
  }
  static cfgIds = { model: 'model' };
  static cfgNames = { model: '模型' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; this.opts = opts; this.pid = pidOf(this.sid); this.agent = agentFor(this.pid); }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = kuInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; this.model = this.model || s.model; }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'kuAi 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }
  // 用户用的设备：kuAi 按它给对应系统的命令；协同 / 群里别人转来的那一轮：kuAi 的简单命令每条都要确认
  promptMeta(dev, peer) { return dev || peer ? { ...(dev ? { device: dev } : {}), ...(peer ? { peer: true } : {}) } : null; }
  get imageError() { return 'kuAi 进程是旧版本，还不收图片：重启 claclaw 后再试'; }
  // 每轮结束 agent 在 usage_update._meta.kuai 里带上速度：显示成一行小字（不进历史）
  handle(u) {
    super.handle(u);
    const st = u?.sessionUpdate === 'usage_update' && u._meta?.kuai;
    if (!st || this.replaying || this.closed) return;
    this.closeText();
    if (st.note) this.emit({ t: 'sys', text: '⚠️ ' + st.note });   // 没写完 / 被拦下：写明原因
    for (const t of Array.isArray(st.info) ? st.info : []) this.emit({ t: 'sys', text: 'ℹ️ ' + String(t) });   // 小测验测完了、这个会话降了档
    this.emit({ t: 'sys', text: statsLine(st) });
  }

  // 这个会话走的那家（不在了就默认那家）
  hit(store) { return libOf(store).find(x => x.p.id === this.pid) || route(store); }
  // 进程里的模型清单就是这个会话走的那家供应商的模型：base 填它的地址，splitGroups 会对回模型库
  ownModel(o, store) {
    const v = String(o.value), hit = this.hit(store);
    return { value: v, label: String(o.name || v), id: v, base: hit ? epOf(hit) : '' };
  }
  // 模型选择：模型库里所有 kuAi 能用的（换供应商只换这一个会话的进程，别的会话不受影响）
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libOf(store), hit = this.hit(store);
    if (!hit || !lib.length) return base;
    const curId = this.config ? String(this.config.find(o => o.id === 'model')?.currentValue || '') : '';
    const cur = (lib.find(x => x.p.id === hit.p.id && x.m.id === (curId || this.model)) || hit).value;
    const items = lib.map(x => ({ value: x.value, label: x.m.name || x.m.id, sub: x.p.name + ' · ' + x.m.id }));
    return { ...base, current: cur, label: lib.find(x => x.value === cur)?.m.name || curId || hit.m.id, groups: [{ name: STORE_GROUP, items }] };
  }
  // 同一家里换模型：进程里直接换；换供应商：在原来那家的进程里关掉这个会话，记下走哪家，接到那家的进程上再换模型。
  // 刚新建、还没发过消息的会话文件已经在了（agent 新建时就存盘），可以直接接上。最近选的那家也是新会话默认走的
  async pickModel(value) {
    const store = storeNow();
    const next = value.startsWith(LIB) ? libOf(store).find(x => x.value === value) : null;
    if (!next) return super.pickModel(value);
    if (next.p.id !== this.pid) {
      if (this.busy) throw new Error('这一轮结束后再换模型');
      await this.moveTo(next.p.id);
    }
    saveRoute(this.sid, next.p.id, next.p.id);
    return super.pickModel(next.m.id);
  }
  async moveTo(pid) {
    const old = this.agent;
    if (this.attaching) await this.attaching.catch(() => {});
    if (this.attached) {   // 原来那家的进程把会话从内存里放掉（会话文件两边共用，不放掉以后会拿旧内容覆盖）
      this.attached = false;
      await old.rpc('session/close', { sessionId: this.sid }, old.closeMs).catch(() => {});
      old.closedAt.set(this.sid, Date.now());
    }
    old.release(this.sid, this);
    saveRoute(this.sid, pid);
    this.pid = pid; this.agent = agentFor(pid); this.config = null;
    this.log?.('kuai route', this.sid.slice(0, 8), '→', pid);
    await this.attach();
  }
}

const num = (x, d) => Number(x).toFixed(d);
export function statsLine(st) {
  const parts = [st.model || 'kuAi'];
  if (st.fill) parts.push('程序代跑 ' + st.fill);   // L1：模型只填了参数（或者参数由程序定，没问模型），结果是技能直接给的
  else if (st.ttft == null) parts.push('没有输出');
  else parts.push('首字 ' + num(st.ttft, st.ttft < 10 ? 2 : 1) + ' 秒');
  if (st.tps) parts.push(num(st.tps, st.tps < 10 ? 1 : 0) + ' tok/s');
  if (st.outTokens) parts.push('输出 ' + st.outTokens + ' tok');
  if (st.parts > 1) parts.push('分 ' + st.parts + ' 段');
  if (st.total != null) parts.push('共 ' + num(st.total, 1) + ' 秒');
  return parts.join(' · ');
}

export const kuNewSession = (cwd, opts) => KuRunner.create(cwd, opts);

// 删除：会话文件挪进回收站（agent 没有删除接口）
export function kuDelete(id, trashDir) {
  const s = kuInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_kuai_' + s.id + '.json');
  fs.renameSync(s.file, dest);
  const files = s.file.replace(/\.json$/, '.files');   // 会话里的图片（agent 存在会话文件旁边）一起挪走
  try { if (fs.existsSync(files)) fs.renameSync(files, dest.replace(/\.json$/, '.files')); } catch {}
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  fileCache.delete(s.file); localNames.set(id, '');
  try { saveRoute(s.id, null); } catch {}
  return dest;
}
// 改名：记在 claclaw 这边（列表、标题都用它；agent 自己起的标题不再覆盖）
export function kuRename(id, title) {
  if (!kuInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = kuRunners.get(id); if (r) r.title = title;
  return title;
}
