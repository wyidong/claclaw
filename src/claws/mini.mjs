// Mini：claclaw 自带的纯问答 agent，不调工具、不碰电脑上的文件和命令；接模型库里的模型（尤其本地 Ollama）答疑、看模型快不快。
// agent 本体在 mini-agent.mjs（ACP，stdin/stdout）。每轮结束显示一行：模型 · 首字耗时 · 生成速度。
// - 会话：agent 把每个会话存成 data/mini-sessions/<id>.json（title / cwd / model / messages…）；历史靠 session/load 重放
// - 模型：模型库里的都能选（OpenAI 兼容 / Anthropic / Gemini 三种接口，一家有几种时按这个顺序挑一种）。一个进程只连一家供应商，每家各起一个进程，会话各走各的（同一个群里几个会话可以同时用不同家的模型）；本机地址（127.0.0.1 / localhost）的排最前；
//   会话走哪家记在 data/mini-route.json 的 sessions（没记的按会话的模型认，认不出走默认那家）；provider 是新会话默认走的（最近选的那家）
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：把会话文件挪进回收站
// 网页里 Mini 会话的 id = 'mi:' + 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpAgent, AcpRunner, localNames } from './acp.mjs';
import { tilde, oneLine, readJson, writeJsonAtomic, hash16 } from '../util.mjs';
import { DATA } from '../auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels, hostOf } from '../modelpick.mjs';

const MI_PREFIX = 'mi:';
export const isMi = id => typeof id === 'string' && id.startsWith(MI_PREFIX);
const sidOf = id => id.slice(MI_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const AGENT_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mini-agent.mjs');
const SESSIONS = path.join(DATA, 'mini-sessions');
const ROUTE_FILE = path.join(DATA, 'mini-route.json');
const FMTS = ['openai', 'anthropic', 'gemini'];   // 一家有几种接口时按这个顺序挑
const epOf = x => x.p.endpoints[x.fmt];
const LOCAL = /^(127\.|localhost$|\[?::1\]?$)/;

export const miInstalled = () => !!route();   // 模型库里有能用的模型就算装好了（agent 随 claclaw 自带）

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
    if (c.row) rows.push({ ...c.row, title: localNames.get(MI_PREFIX + c.row.id) || c.row.title });
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  return rows.sort((a, b) => b.updated - a.updated);
}
export function miSessionList({ busy = () => false } = {}) {
  return listRows().map(s => ({
    id: MI_PREFIX + s.id,
    title: s.title || 'Mini 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'mini', busy: busy(MI_PREFIX + s.id),
  }));
}
export const miInfo = id => isMi(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const miExists = id => !!miInfo(id);

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
const pidOf = (sid, store = storeNow()) => sessionPid(readJson(ROUTE_FILE, {}), store, sid, miInfo(MI_PREFIX + sid)?.model);
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
  const store = storeNow(), hit = libOf(store).find(x => x.p.id === pid) || route(store), env = { MINI_DIR: SESSIONS, ...proxyEnv() };
  if (hit) {
    env.MINI_FORMAT = hit.fmt;
    env.MINI_BASE_URL = baseOf(hit.fmt, epOf(hit));
    env.MINI_API_KEY = hit.p.key || 'none';
    env.MINI_MODELS = hit.p.models.map(m => m.id).join(',');
    env.MINI_MODEL = hit.m.id;
  }
  if (process.env.CLACLAW_MINI_BUDGET) env.MINI_BUDGET = process.env.CLACLAW_MINI_BUDGET;
  return { env, sig: hash16(JSON.stringify(env)) };
}

// ---------- ACP 进程（底座见 acp.mjs）：每家供应商一个，用到才起、空闲 10 分钟自己关 ----------
const agents = new Map();   // 供应商 id（模型库里没有能用的模型时是 ''）→ AcpAgent
function agentFor(pid) {
  let ag = agents.get(pid);
  if (!ag) {
    ag = new AcpAgent({ name: 'mini', bin: () => process.execPath, missing: '没找到 node', command: bin => [bin, [AGENT_JS]], prepare: () => routeEnv(pid) });
    agents.set(pid, ag);
  }
  return ag;
}
export const miShutdown = () => Promise.all([...agents.values()].map(ag => ag.stop()));
export function miModelsChanged(log) { for (const [pid, ag] of agents) ag.modelsChanged(routeEnv(pid).sig, log); }
export const miAcpRunning = () => [...agents.values()].some(ag => ag.running);

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
];

// ---------- 打开的 Mini 会话 ----------
export const miRunners = new Map();

export class MiRunner extends AcpRunner {
  static get agent() { return agentFor(route()?.p.id || ''); }   // 新建会话用默认那家；已有的会话在构造时换成它自己那家的
  static onCreated(sid) { saveRoute(sid, route()?.p.id || ''); }
  static prefix = MI_PREFIX; static runners = miRunners;
  static label = 'Mini'; static group = 'Mini'; static permPrefix = 'mi-'; static commands = COMMANDS;
  static cfgIds = { model: 'model' };
  static cfgNames = { model: '模型' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; this.opts = opts; this.pid = pidOf(this.sid); this.agent = agentFor(this.pid); }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = miInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; this.model = this.model || s.model; }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Mini 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }
  promptMeta(dev) { return { device: dev }; }   // 用户用的设备：Mini 按它给对应系统的命令
  get imageError() { return 'Mini 进程是旧版本，还不收图片：重启 claclaw 后再试'; }
  // 每轮结束 agent 在 usage_update._meta.mini 里带上速度：显示成一行小字（不进历史）
  handle(u) {
    super.handle(u);
    const st = u?.sessionUpdate === 'usage_update' && u._meta?.mini;
    if (!st || this.replaying || this.closed) return;
    this.closeText();
    if (st.note) this.emit({ t: 'sys', text: '⚠️ ' + st.note });   // 没写完 / 被拦下：写明原因
    this.emit({ t: 'sys', text: statsLine(st) });
  }

  // 这个会话走的那家（不在了就默认那家）
  hit(store) { return libOf(store).find(x => x.p.id === this.pid) || route(store); }
  // 进程里的模型清单就是这个会话走的那家供应商的模型：base 填它的地址，splitGroups 会对回模型库
  ownModel(o, store) {
    const v = String(o.value), hit = this.hit(store);
    return { value: v, label: String(o.name || v), id: v, base: hit ? epOf(hit) : '' };
  }
  // 模型选择：模型库里所有 Mini 能用的（换供应商只换这一个会话的进程，别的会话不受影响）
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
    this.log?.('mini route', this.sid.slice(0, 8), '→', pid);
    await this.attach();
  }
}

const num = (x, d) => Number(x).toFixed(d);
export function statsLine(st) {
  const parts = [st.model || 'Mini'];
  if (st.ttft == null) parts.push('没有输出');
  else parts.push('首字 ' + num(st.ttft, st.ttft < 10 ? 2 : 1) + ' 秒');
  if (st.tps) parts.push(num(st.tps, st.tps < 10 ? 1 : 0) + ' tok/s');
  if (st.outTokens) parts.push('输出 ' + st.outTokens + ' tok');
  if (st.parts > 1) parts.push('分 ' + st.parts + ' 段');
  if (st.total != null) parts.push('共 ' + num(st.total, 1) + ' 秒');
  return parts.join(' · ');
}

export const miNewSession = (cwd, opts) => MiRunner.create(cwd, opts);

// 删除：会话文件挪进回收站（agent 没有删除接口）
export function miDelete(id, trashDir) {
  const s = miInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_mini_' + s.id + '.json');
  fs.renameSync(s.file, dest);
  const files = s.file.replace(/\.json$/, '.files');   // 会话里的图片（agent 存在会话文件旁边）一起挪走
  try { if (fs.existsSync(files)) fs.renameSync(files, dest.replace(/\.json$/, '.files')); } catch {}
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  fileCache.delete(s.file); localNames.set(id, '');
  try { saveRoute(s.id, null); } catch {}
  return dest;
}
// 改名：记在 claclaw 这边（列表、标题都用它；agent 自己起的标题不再覆盖）
export function miRename(id, title) {
  if (!miInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = miRunners.get(id); if (r) r.title = title;
  return title;
}
