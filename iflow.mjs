// iFlow CLI 适配（心流的 `iflow`，npm 包 @iflow-ai/iflow-cli，Qwen Code 的分支）。
// 全部走 ACP：claclaw 起一个 `iflow --experimental-acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表 / 历史：读 ~/.iflow/acp/sessions/<id>.json（ACP 开的会话都记在这里：cwd、chatHistory，Gemini 格式的 parts）。
//   session/load 不重放历史，历史从文件里转；没有 session/list、session/close
// - 模型 / 模式：不在 configOptions 里（session/new 的 _meta.models、modes），claclaw 合成成选项，走 session/set_model / set_mode。
//   iFlow 新会话默认 yolo（什么都不问）：接上 / 新建后一律先切到 default（跑命令、改文件前先问）
// - 模型库：iFlow 一次只认一个 OpenAI 兼容模型（IFLOW_apiKey / IFLOW_baseUrl / IFLOW_modelName 环境变量），一个进程一个模型：
//   选模型库的模型 = 记在 data/iflow-route.json、重启进程（所有 iFlow 会话一起换）；iFlow 自带的模型要先在终端登录过心流账号
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：把会话文件挪进回收站
// 网页里 iFlow 会话的 id = 'if:' + 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AcpAgent, AcpRunner, localNames, stripTags, toolTarget } from './acp.mjs';
import { HOME, tilde, oneLine, findBin, readJson } from './util.mjs';
import { DATA, writeJsonAtomic } from './auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels, routeNow } from './modelpick.mjs';

export const IF_PREFIX = 'if:';
export const isIf = id => typeof id === 'string' && id.startsWith(IF_PREFIX);
const sidOf = id => id.slice(IF_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const IHOME = process.env.IFLOW_HOME || path.join(HOME, '.iflow');
const SESSIONS = path.join(IHOME, 'acp', 'sessions');
const SETTINGS = path.join(IHOME, 'settings.json');

export const ifBin = () => findBin('iflow');
export const ifInstalled = () => !!ifBin();

// ---------- 会话列表 ----------
const fileCache = new Map();
const partsText = m => (m?.parts || []).map(p => typeof p?.text === 'string' && !p.thought ? p.text : '').join('');
function parseFile(f, st) {
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  const sid = String(o.sessionId || path.basename(f, '.json'));
  if (!validSid(sid)) return null;
  const first = (o.chatHistory || []).find(m => m?.role === 'user');
  return { id: sid, title: oneLine(stripTags(partsText(first))).slice(0, 100), cwd: String(o.cwd || ''), updated: Date.parse(o.lastActivity || o.createdAt) || st.mtimeMs, file: f };
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
    if (c.row) rows.push({ ...c.row, title: localNames.get(IF_PREFIX + c.row.id) || c.row.title });
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  return rows.sort((a, b) => b.updated - a.updated);
}
export function ifSessionList({ busy = () => false } = {}) {
  const hit = route();
  return listRows().map(s => ({
    id: IF_PREFIX + s.id,
    title: s.title || 'iFlow 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: hit ? hit.m.id : '',
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'iflow', busy: busy(IF_PREFIX + s.id),
  }));
}
export const ifInfo = id => isIf(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const ifExists = id => !!ifInfo(id);

// 历史：chatHistory 的 Gemini 格式 → 网页条目。user 的 text 是用户的话（去掉 iFlow 塞的提示块）、functionResponse 是工具结果；
// model 的 text 是回复（thought 不要）、functionCall 是工具调用
function historyOf(f) {
  let o; try { o = JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return []; }
  const items = [], tools = new Map();
  for (const m of o.chatHistory || []) {
    const parts = Array.isArray(m?.parts) ? m.parts : [];
    if (m.role === 'user') {
      for (const p of parts) if (p?.functionResponse) { const t = tools.get(p.functionResponse.id || p.functionResponse.name); if (t) { const r = p.functionResponse.response || {}; t.output = String(r.output ?? r.error ?? r.content ?? (typeof r === 'string' ? r : JSON.stringify(r))).slice(0, 4000); if (r.error) t.status = 'no'; } }
      const images = parts.filter(p => p?.inlineData?.data).map(p => ({ media_type: p.inlineData.mimeType || 'image/png', data: p.inlineData.data }));
      const text = stripTags(partsText(m));
      if (text || images.length) items.push({ kind: 'user', text, images: images.length ? images : undefined });
    } else if (m.role === 'model') {
      let open = false;
      for (const p of parts) {
        if (typeof p?.text === 'string' && !p.thought && p.text) { const last = items[items.length - 1]; if (open && last?.kind === 'ai') last.text += p.text; else { items.push({ kind: 'ai', text: p.text }); open = true; } }
        else if (p?.functionCall) { open = false; const fc = p.functionCall, it = { kind: 'tool', id: fc.id || fc.name, name: fc.name || 'tool', target: toolTarget(fc.args || {}), status: 'ok', output: '' }; tools.set(it.id, it); items.push(it); }
      }
    }
  }
  return items;
}

// ---------- 模型走法（见文件开头） ----------
const ROUTE_FILE = path.join(DATA, 'iflow-route.json');
const FMTS = ['openai'];
// iFlow 自己能不能用：settings.json 里选过认证方式（心流登录 / 自己配的 key）
const ownUsable = () => { const s = readJson(SETTINGS, {}); return !!(s.selectedAuthType || s.apiKey); };
const OWN_LOGIN = 'iFlow 自带的模型要先登录：在电脑终端运行 iflow 登录心流账号（或配好 ~/.iflow/settings.json）';
const route = (store = storeNow()) => routeNow(readJson(ROUTE_FILE, {}), store, FMTS, ownUsable);
const v1 = u => String(u).replace(/\/+$/, '').replace(/\/v1$/, '') + '/v1';
function routeEnv() {
  const hit = route(), env = {};
  if (hit) { env.IFLOW_selectedAuthType = 'openai-compatible'; env.IFLOW_apiKey = hit.p.key || 'none'; env.IFLOW_baseUrl = v1(hit.p.endpoints.openai); env.IFLOW_modelName = hit.m.id; }
  const sig = crypto.createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 16);
  return { env, sig };
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'iflow', bin: ifBin, missing: '没找到 iflow 命令，先装好 iFlow CLI（npm i -g @iflow-ai/iflow-cli）',
  command: bin => [bin, ['--experimental-acp']],
  prepare: () => routeEnv(),
  rpcError: e => /authenticat|login|api key/i.test(e.message || '') ? OWN_LOGIN : '',
});
export const ifShutdown = () => agent.stop();
export function ifModelsChanged(log) { if (ifInstalled()) agent.modelsChanged(routeEnv().sig, log); }
export const ifAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '权限模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// ---------- 打开的 iFlow 会话 ----------
export const ifRunners = new Map();

export class IfRunner extends AcpRunner {
  static agent = agent; static prefix = IF_PREFIX; static runners = ifRunners;
  static label = 'iFlow'; static group = 'iFlow'; static permPrefix = 'if-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = false;

  constructor(id, opts) { super(id, opts); this.items = []; this.opts = opts; }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = ifInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; this.items = historyOf(s.file); }
    else this.items = [];
    this.tools.clear();
  }
  attachDone(ok) { if (ok && !this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'iFlow 会话'; }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }
  // 发完一轮：文件里才有这一轮的记录，下次打开从文件读
  metaLine() { const hit = route(); return tilde(this.cwd || '') + ((this.model || hit?.m.id) ? ' · ' + (this.model || hit.m.id) : ''); }

  // 模型 / 模式合成成选项：session/new 给 _meta.models 和 modes；session/load 什么都不给，用上次记下的清单
  // 接上后一律切到 default（iFlow 默认 yolo，什么都不问）
  cfgOf(r) {
    const models = r?._meta?.models, modes = r?.modes;
    const cfg = [];
    if (models?.availableModels?.length) cfg.push({ id: 'model', name: '模型', category: 'model', _set: 'model', currentValue: models.currentModelId, options: models.availableModels.map(m => ({ value: m.id, name: m.name || m.id, description: m.description || '' })) });
    else { const c = this.agent.cachedModels(); if (c) cfg.push({ ...c, _set: 'model', currentValue: route()?.m.id || null }); }
    if (modes?.availableModes?.length) cfg.push({ id: 'mode', name: '模式', category: 'mode', _set: 'mode', currentValue: modes.currentModeId, options: modes.availableModes.map(m => ({ value: m.id, name: m.name, description: m.description || '' })) });
    else { const c = this.agent.cachedOpt('mode'); if (c) cfg.push({ ...c, _set: 'mode', currentValue: 'default' }); }
    const mode = cfg.find(o => o.id === 'mode');
    if (mode && mode.currentValue !== 'default') { mode.currentValue = 'default'; this.agent.rpc('session/set_mode', { sessionId: this.sid, modeId: 'default' }).catch(() => {}); }
    return cfg;
  }
  // 走模型库时，进程里的「当前模型」就是模型库那条
  ownModel(o, store) {
    const v = String(o.value), hit = route(store);
    return { value: v, label: String(o.name || v), id: v, base: hit && hit.m.id === v ? hit.p.endpoints.openai : '' };
  }
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libModels(store, FMTS), hit = route(store);
    const libGroup = lib.length ? [{ name: STORE_GROUP, items: lib.map(x => ({ value: x.value, label: x.m.name || x.m.id, sub: x.p.name + ' · ' + x.m.id + (hit?.value === x.value ? '' : '（会重启 iFlow，所有 iFlow 会话一起换）') })) }] : [];
    const usable = ownUsable();
    const own = (base.groups || []).filter(g => g.name !== STORE_GROUP).map(g => ({ ...g, items: g.items.filter(it => !hit || it.value !== hit.m.id).map(it => !usable ? { ...it, disabled: true, sub: '要先在电脑上登录 iFlow' } : hit ? { ...it, sub: (it.sub ? it.sub + ' · ' : '') + '用 iFlow 自己的登录（会重启 iFlow）' } : it) })).filter(g => g.items.length);
    if (!base.groups && !libGroup.length) return base;
    return { ...base, current: hit ? hit.value : base.current, label: hit ? (hit.m.name || hit.m.id) : base.label, groups: [...libGroup, ...own] };
  }
  async pickModel(value) {
    const store = storeNow(), hit = route(store), toLib = value.startsWith(LIB);
    if (!toLib && !ownUsable()) throw new Error(OWN_LOGIN);
    if (!toLib && !hit) return super.pickModel(value);
    if (this.busy) throw new Error('这一轮结束后再换模型');
    if (toLib && hit?.value === value) return hit.m.name || hit.m.id;
    const next = toLib ? libModels(store, FMTS).find(x => x.value === value) : null;
    if (toLib && !next) throw new Error('没有这个模型');
    if ([...ifRunners.values()].some(r => r !== this && r.busy)) throw new Error('有别的 iFlow 会话正在回复，等它结束再换（所有 iFlow 会话共用一个模型）');
    const empty = !ifInfo(this.id);
    writeJsonAtomic(ROUTE_FILE, next ? { provider: next.p.id, model: next.m.id } : { own: true });
    this.log?.('iflow route →', next ? next.p.id + '/' + next.m.id : 'iFlow 自带');
    agent.stop();
    for (let i = 0; i < 50 && agent.running; i++) await new Promise(r => setTimeout(r, 100));
    if (empty) {
      const r = await IfRunner.create(this.cwd || HOME, this.opts);
      return { runner: r, label: next ? next.m.name || next.m.id : await r.pickModel(value) };
    }
    await this.attach();
    if (next) { this.model = next.m.name || next.m.id; return this.model; }
    return super.pickModel(value);
  }
}

export const ifNewSession = (cwd, opts) => IfRunner.create(cwd, opts);

export function ifDelete(id, trashDir) {
  const s = ifInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_iflow_' + s.id + '.json');
  fs.renameSync(s.file, dest);
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export function ifRename(id, title) {
  if (!ifInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = ifRunners.get(id); if (r) r.title = title;
  return title;
}
