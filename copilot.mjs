// GitHub Copilot CLI 适配（GitHub 的 `copilot`，npm 包 @github/copilot）。
// 全部走 ACP：claclaw 起一个 `copilot --acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读 ~/.copilot/session-state/<id>/workspace.yaml（id、cwd、name、updated_at；终端里开的会话也在这里）
// - 历史：ACP session/load 会把整段历史重放一遍（和 GLM、Kimi 一样）；接上的会话按它存下的模型继续，所以接上后 set_model 到进程现在的模型
// - 模式：configOptions 里的 mode（值是 ACP 规范里的网址：…#agent / #plan / #autopilot），这里换成中文名
// - 模型库：Copilot 的 BYOK（自带模型）走环境变量 COPILOT_PROVIDER_BASE_URL / TYPE / API_KEY / COPILOT_MODEL，一个进程一个模型：
//   选模型库的模型 = 记在 data/copilot-route.json、重启进程（所有 Copilot 会话一起换）；设了 BYOK 就不需要 GitHub 登录。
//   用 Copilot 自带的模型要先登录 GitHub（copilot login，手机上也能登，见 login.mjs）
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：把会话目录挪进回收站
// 网页里 Copilot 会话的 id = 'cp:' + 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AcpAgent, AcpRunner, localNames } from './acp.mjs';
import { HOME, tilde, oneLine, findBin, readJson } from './util.mjs';
import { DATA, writeJsonAtomic } from './auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels, routeNow } from './modelpick.mjs';

export const CP_PREFIX = 'cp:';
export const isCp = id => typeof id === 'string' && id.startsWith(CP_PREFIX);
const sidOf = id => id.slice(CP_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const CHOME = process.env.COPILOT_HOME || path.join(HOME, '.copilot');
const STATE = path.join(CHOME, 'session-state');

export const cpBin = () => findBin('copilot');
export const cpInstalled = () => !!cpBin();

// ---------- 登录情况 ----------
// config.json 是带 // 注释的 JSON；登录过的账号记在 logged_in_users（令牌本身在系统钥匙串里）；环境变量里的令牌也算
export function cpLoggedIn() {
  if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  let o = {};
  try { o = JSON.parse(fs.readFileSync(path.join(CHOME, 'config.json'), 'utf8').split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n')); } catch { return false; }
  return !!((Array.isArray(o.logged_in_users) && o.logged_in_users.length) || o.last_logged_in_user);
}

// ---------- 会话列表 ----------
// workspace.yaml 是一层的「键: 值」；值可能带引号（JSON 风格的双引号、YAML 的单引号）
function yamlFlat(text) {
  const o = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^([A-Za-z_][\w-]*):\s?(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"')) { try { v = JSON.parse(v); } catch { v = v.slice(1, -1); } }
    else if (v.startsWith("'")) v = v.slice(1, -1).replace(/''/g, "'");
    o[m[1]] = v;
  }
  return o;
}
const fileCache = new Map();
function listRows() {
  const rows = [], seen = new Set();
  let names = [];
  try { names = fs.readdirSync(STATE); } catch {}
  for (const n of names) {
    if (!validSid(n)) continue;
    const dir = path.join(STATE, n), y = path.join(dir, 'workspace.yaml'), ev = path.join(dir, 'events.jsonl');
    let st, se; try { st = fs.statSync(y); se = fs.statSync(ev); } catch { continue; }   // 没有 events.jsonl：开了没说话
    if (!se.size) continue;
    seen.add(dir);
    const key = st.mtimeMs + ':' + se.size + ':' + se.mtimeMs;
    let c = fileCache.get(dir);
    if (c?.key !== key) {
      let row = null;
      try {
        const o = yamlFlat(fs.readFileSync(y, 'utf8'));
        if (String(o.id || n) === n) row = { id: n, title: oneLine(o.name || '').slice(0, 100), cwd: String(o.cwd || ''), updated: Math.max(Date.parse(o.updated_at || o.created_at) || 0, se.mtimeMs), dir };
      } catch {}
      c = { key, row }; fileCache.set(dir, c);
    }
    if (c.row) rows.push({ ...c.row, title: localNames.get(CP_PREFIX + c.row.id) || c.row.title });
  }
  for (const d of fileCache.keys()) if (!seen.has(d)) fileCache.delete(d);
  return rows.sort((a, b) => b.updated - a.updated);
}
export function cpSessionList({ busy = () => false } = {}) {
  const hit = route();
  return listRows().map(s => ({
    id: CP_PREFIX + s.id,
    title: s.title || 'Copilot 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: hit ? hit.m.id : '',
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'copilot', busy: busy(CP_PREFIX + s.id),
  }));
}
export const cpInfo = id => isCp(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const cpExists = id => !!cpInfo(id);

// ---------- 模型走法（见文件开头） ----------
const ROUTE_FILE = path.join(DATA, 'copilot-route.json');
const FMTS = ['openai', 'anthropic'];
const OWN_LOGIN = 'Copilot 自带的模型要先登录 GitHub：在 Claw 页 Copilot 卡片上点「登录」，或在电脑终端运行 copilot login';
const route = (store = storeNow()) => routeNow(readJson(ROUTE_FILE, {}), store, FMTS, cpLoggedIn);
const v1 = u => String(u).replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
function routeEnv() {
  const hit = route(), env = {};
  if (hit) {
    const openai = hit.p.endpoints.openai;
    env.COPILOT_PROVIDER_TYPE = openai ? 'openai' : 'anthropic';
    env.COPILOT_PROVIDER_BASE_URL = openai ? v1(openai) : String(hit.p.endpoints.anthropic).replace(/\/+$/, '');
    env.COPILOT_PROVIDER_API_KEY = hit.p.key || 'none';
    env.COPILOT_MODEL = hit.m.id;
    if (Number(hit.m.context) > 0) env.COPILOT_PROVIDER_MAX_PROMPT_TOKENS = String(hit.m.context);
  }
  const sig = crypto.createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 16);
  return { env, sig };
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'copilot', bin: cpBin, missing: '没找到 copilot 命令，先装好 GitHub Copilot CLI（npm i -g @github/copilot）',
  command: bin => [bin, ['--acp']],
  prepare: () => routeEnv(),
  rpcError: e => /authenticat|log ?in|not signed|unauthori[sz]ed|no auth/i.test(e.message || '') ? OWN_LOGIN : '',
});
export const cpShutdown = () => agent.stop();
export function cpModelsChanged(log) { if (cpInstalled()) agent.modelsChanged(routeEnv().sig, log); }
export const cpAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// 模式：值是 ACP 规范里的网址，按最后的 #xxx 换成中文
const MODE_CP = {
  agent: ['每次询问', '改文件、跑命令前先问你'],
  plan: ['只做计划', '先出多步计划，不直接动手'],
  autopilot: ['全自动', '自己一路做到完成，什么都不问（实验性）'],
};
const modeKey = v => String(v || '').split('#').pop().toLowerCase();

// ---------- 打开的 Copilot 会话 ----------
export const cpRunners = new Map();

export class CpRunner extends AcpRunner {
  static agent = agent; static prefix = CP_PREFIX; static runners = cpRunners;
  static label = 'Copilot'; static group = 'Copilot'; static permPrefix = 'cp-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; this.opts = opts; }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = cpInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Copilot 会话';
    // 接上的老会话按它存下的模型继续（BYOK 下就是当初那个模型库模型），换过模型库的模型后要跟着换：set_model 到进程现在的模型
    const hit = route();
    if (hit) agent.rpc('session/set_model', { sessionId: this.sid, modelId: hit.m.id }).catch(e => this.log?.('copilot set_model failed', e.message || e));
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }
  metaLine() { const hit = route(); return tilde(this.cwd || '') + ((this.model || hit?.m.id) ? ' · ' + (this.model || hit.m.id) : ''); }

  // 模式换成中文名；走模型库时没有模型选项（BYOK 一个进程一个模型），合成一个只有模型库那条的
  cfgOf(r) {
    const cfg = (r?.configOptions || []).map(o => o.category === 'mode' || o.id === 'mode'
      ? { ...o, options: (o.options || []).map(x => { const z = MODE_CP[modeKey(x.value)]; return z ? { ...x, name: z[0], description: z[1] } : x; }) }
      : o);
    const hit = route();
    if (hit && !cfg.some(o => o.category === 'model' || o.id === 'model')) cfg.unshift({ id: 'model', name: '模型', category: 'model', _set: 'model', currentValue: hit.m.id, options: [{ value: hit.m.id, name: hit.m.name || hit.m.id }] });
    return cfg;
  }
  ownModel(o, store) {
    const v = String(o.value), hit = route(store);
    return { value: v, label: String(o.name || v), id: v, base: hit && hit.m.id === v ? (hit.p.endpoints.openai || hit.p.endpoints.anthropic) : '' };
  }
  // 模型选择：模型库一组 + Copilot 自带一组（登录过 GitHub 才能用）
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libModels(store, FMTS), hit = route(store);
    const libGroup = lib.length ? [{ name: STORE_GROUP, items: lib.map(x => ({ value: x.value, label: x.m.name || x.m.id, sub: x.p.name + ' · ' + x.m.id + (hit?.value === x.value ? '' : '（会重启 Copilot，所有 Copilot 会话一起换）') })) }] : [];
    const usable = cpLoggedIn();
    const own = hit
      ? (usable ? [{ name: 'Copilot 自带', items: [{ value: 'own', label: 'Copilot 自带的模型', sub: '用 GitHub Copilot 的订阅（会重启 Copilot，所有 Copilot 会话一起换）' }] }] : [])
      : (base.groups || []).filter(g => g.name !== STORE_GROUP).map(g => ({ ...g, items: g.items.map(it => usable ? it : { ...it, disabled: true, sub: '要先登录 GitHub' }) })).filter(g => g.items.length);
    if (!base.groups && !libGroup.length) return base;
    return { ...base, current: hit ? hit.value : base.current, label: hit ? (hit.m.name || hit.m.id) : base.label, groups: [...libGroup, ...own] };
  }
  // 模型库里换 / 换回 Copilot 自带：记下走法、重启进程（所有 Copilot 会话一起换），再接上；
  // 刚新建、还没发过消息的会话新进程里接不上：在同一个目录重建一个，返回 { runner, label } 让网页换过去
  async pickModel(value) {
    const store = storeNow(), hit = route(store), toLib = value.startsWith(LIB);
    if (!toLib && !cpLoggedIn()) throw new Error(OWN_LOGIN);
    if (!toLib && !hit) return super.pickModel(value);
    if (this.busy) throw new Error('这一轮结束后再换模型');
    if (toLib && hit?.value === value) return hit.m.name || hit.m.id;
    const next = toLib ? libModels(store, FMTS).find(x => x.value === value) : null;
    if (toLib && !next) throw new Error('没有这个模型');
    if ([...cpRunners.values()].some(r => r !== this && r.busy)) throw new Error('有别的 Copilot 会话正在回复，等它结束再换（所有 Copilot 会话共用一个模型）');
    const empty = !cpInfo(this.id);
    writeJsonAtomic(ROUTE_FILE, next ? { provider: next.p.id, model: next.m.id } : { own: true });
    this.log?.('copilot route →', next ? next.p.id + '/' + next.m.id : 'Copilot 自带');
    agent.stop();
    for (let i = 0; i < 50 && agent.running; i++) await new Promise(r => setTimeout(r, 100));
    const label = next ? next.m.name || next.m.id : 'Copilot 自带的模型';
    if (empty) return { runner: await CpRunner.create(this.cwd || HOME, this.opts), label };
    await this.attach();
    this.model = next ? label : '';
    return label;
  }
}

export const cpNewSession = (cwd, opts) => CpRunner.create(cwd, opts);

export function cpDelete(id, trashDir) {
  const s = cpInfo(id);
  if (!s?.dir) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_copilot_' + s.id);
  fs.renameSync(s.dir, dest);
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.dir, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  fileCache.delete(s.dir); localNames.set(id, '');
  return dest;
}
export function cpRename(id, title) {
  if (!cpInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = cpRunners.get(id); if (r) r.title = title;
  return title;
}
