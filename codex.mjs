// Codex 适配（OpenAI 的 Codex CLI）。Codex 本身不说 ACP，走官方的转接程序 codex-acp
// （npm 包 @agentclientprotocol/codex-acp，自带一份兼容的 Codex，读的还是 ~/.codex 的配置和会话）。
// claclaw 起一个 `codex-acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读 ~/.codex/sessions/年/月/日/rollout-*.jsonl（和 Codex 自己的列表一样，只列终端 / IDE / 桌面版里
//   用户开的会话，不列 codex exec 和子代理的）；名字看 ~/.codex/session_index.jsonl（改过名的记在这里，后写的算）。
//   每个文件按大小 + 修改时间缓存，没变不重读
// - 历史：ACP session/load 会把整段历史用 session/update 重放一遍，收下来转成网页条目（和 Kimi、Qwen 一样）
// - 删除：ACP session/delete，Codex 是归档（挪到 ~/.codex/archived_sessions，能找回）
// - 改名：往 session_index.jsonl 追加一行（Codex 自己改名也是这么记的）
// - 模型：两种走法，在会话设置的模型选择里切换（所有 Codex 会话一起换，codex-acp 一个进程只能用一个服务商）：
//   · Codex 自带：这台电脑上 Codex 自己的配置（~/.codex/config.toml 的服务商、登录状态），选 Codex 的模型清单
//   · 模型库：claclaw 起 codex-acp 时用 CODEX_CONFIG 临时加一个 claclaw-<供应商> 服务商（Responses 接口，key 走环境变量），
//     MODEL_PROVIDER 指过去；不改 ~/.codex/config.toml。选哪个记在 data/codex-route.json，换了要重启 codex-acp
//   · 没选过、Codex 自己也没登录没配服务商：默认用模型库第一个（像 Qwen、Kimi 一样不用先登录）；
//     明确选了 Codex 自带记成 { own: true }
// 网页里 Codex 会话的 id = 'cx:' + Codex 会话 id。
// 没做「终端里正开着」的检测：同一个会话别在终端和网页里同时发消息。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AcpAgent, AcpRunner } from './acp.mjs';
import { HOME, tilde, oneLine, findBin, readJson } from './util.mjs';
import { DATA, writeJsonAtomic } from './auth.mjs';
import { storeNow, STORE_GROUP } from './modelpick.mjs';

export const CX_PREFIX = 'cx:';
export const isCx = id => typeof id === 'string' && id.startsWith(CX_PREFIX);
const sidOf = id => id.slice(CX_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const CHOME = process.env.CODEX_HOME || path.join(HOME, '.codex');
const SESSIONS = path.join(CHOME, 'sessions');
const INDEX = path.join(CHOME, 'session_index.jsonl');

export const cxBin = () => findBin('codex-acp');
export const cxInstalled = () => !!(cxBin() || findBin('codex') || fs.existsSync(SESSIONS));
export const cxSupported = () => !!cxBin();
// 宿主页显示的版本：转接程序自带的 Codex 版本（会话实际跑的是它），再带上转接程序自己的
export function cxVersion() {
  const bin = cxBin();
  if (!bin) return '';
  const ver = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).version || ''; } catch { return ''; } };
  const root = path.resolve(path.dirname(bin), '..');
  const codex = ver(path.join(root, 'node_modules', '@openai', 'codex', 'package.json')), acp = ver(path.join(root, 'package.json'));
  return codex ? codex + (acp ? '（codex-acp ' + acp + '）' : '') : acp;
}
export const cxUnsupportedReason = () => '还没装 Codex 的 ACP 转接程序：在电脑终端运行 npm i -g @agentclientprotocol/codex-acp';

// ---------- 会话列表 ----------
// 记录一行一条 JSON：第一行 session_meta（id、cwd、source：cli / vscode / exec / {subagent}）；
// event_msg 里 item_completed 的 UserMessage 是用户打的字，token_count 是用量；turn_context 带当时的模型。
// 文件不大就整个读，大的读头尾各 512KB（第一句在头部，最后的模型、用量在尾部）
const fileCache = new Map();   // 文件路径 → { key（大小:修改时间）, row }
const READ_ALL = 4 << 20, PART = 512 << 10;
function readLines(f, size) {
  if (size <= READ_ALL) return fs.readFileSync(f, 'utf8').split('\n');
  const fd = fs.openSync(f, 'r');
  try {
    const head = Buffer.alloc(PART), tail = Buffer.alloc(PART);
    fs.readSync(fd, head, 0, PART, 0); fs.readSync(fd, tail, 0, PART, size - PART);
    return [...head.toString('utf8').split('\n').slice(0, -1), ...tail.toString('utf8').split('\n').slice(1)];
  } finally { fs.closeSync(fd); }
}
// 用户在终端 / IDE / 桌面版 / claclaw 里开的会话；codex exec（脚本跑的）和子代理不算
const userSession = m => typeof m.source === 'string' && m.source !== 'exec' && m.thread_source !== 'subagent';
function parseFile(f, st) {
  let meta = null, first = '', model = '', ctx;
  for (const l of readLines(f, st.size)) {
    if (!l || l[0] !== '{') continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const p = o.payload || {};
    if (o.type === 'session_meta') meta ||= p;
    else if (o.type === 'turn_context' && p.model) model = p.model;
    else if (o.type === 'event_msg' && p.type === 'item_completed' && p.item?.type === 'UserMessage' && !first)
      first = (p.item.content || []).map(c => c?.type === 'text' ? c.text : '').join('');
    else if (o.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage?.input_tokens > 0) ctx = p.info.last_token_usage.input_tokens;
  }
  if (!meta || !userSession(meta)) return null;
  const sid = String(meta.id || meta.session_id || '');
  if (!validSid(sid)) return null;
  return { id: sid, first: oneLine(first).slice(0, 100), cwd: String(meta.cwd || ''), model, ctx, updated: st.mtimeMs, file: f };
}
// 改过的名字：session_index.jsonl 一行一条 {id, thread_name}，同一个 id 后写的算
let indexCache = { key: '', names: new Map() };
function names() {
  let st; try { st = fs.statSync(INDEX); } catch { return new Map(); }
  const key = st.size + ':' + st.mtimeMs;
  if (indexCache.key === key) return indexCache.names;
  const m = new Map();
  for (const l of fs.readFileSync(INDEX, 'utf8').split('\n')) {
    if (!l) continue;
    try { const o = JSON.parse(l); if (o.id && o.thread_name) m.set(o.id, String(o.thread_name)); } catch {}
  }
  indexCache = { key, names: m };
  return m;
}
// 年 / 月 / 日三层目录：按名字倒着走，新的在前
const subdirs = d => { try { return fs.readdirSync(d, { withFileTypes: true }).filter(e => e.isDirectory() && /^\d+$/.test(e.name)).map(e => path.join(d, e.name)); } catch { return []; } };
function listRows() {
  const rows = [], seen = new Set(), nm = names();
  for (const y of subdirs(SESSIONS)) for (const mo of subdirs(y)) for (const d of subdirs(mo)) {
    let files = [];
    try { files = fs.readdirSync(d); } catch { continue; }
    for (const n of files) {
      if (!/^rollout-.*\.jsonl$/.test(n)) continue;
      const f = path.join(d, n);
      let st; try { st = fs.statSync(f); } catch { continue; }
      if (!st.isFile() || !st.size) continue;
      seen.add(f);
      const key = st.size + ':' + st.mtimeMs;
      let c = fileCache.get(f);
      if (c?.key !== key) { let row = null; try { row = parseFile(f, st); } catch {} c = { key, row }; fileCache.set(f, c); }
      if (c.row) rows.push({ ...c.row, title: nm.get(c.row.id) || c.row.first });
    }
  }
  for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
  return rows.sort((a, b) => b.updated - a.updated);
}
export function cxSessionList({ busy = () => false } = {}) {
  return listRows().map(s => ({
    id: CX_PREFIX + s.id,
    title: s.title || 'Codex 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'codex', busy: busy(CX_PREFIX + s.id),
  }));
}
export const cxInfo = id => isCx(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const cxExists = id => !!cxInfo(id);

// ---------- 模型走法（见文件开头） ----------
// 模型库里能给 Codex 用的：有 OpenAI 兼容地址的（Codex 只说 Responses 接口；DeepSeek 等已经支持）
const ROUTE_FILE = path.join(DATA, 'codex-route.json');
const LIB = 'lib:';   // 模型选择里模型库那组的 value：lib:<供应商 id>/<模型 id>
const libModels = store => store.providers.filter(p => p.endpoints?.openai && p.models.length).flatMap(p => p.models.map(m => ({ p, m, value: LIB + p.id + '/' + m.id })));
// Codex 自己能不能用：登录过（auth.json）、config.toml 指了服务商、或环境里有 key
function ownUsable() {
  if (process.env.OPENAI_API_KEY || process.env.CODEX_API_KEY || fs.existsSync(path.join(CHOME, 'auth.json'))) return true;
  try { return /^\s*model_provider\s*=/m.test(fs.readFileSync(path.join(CHOME, 'config.toml'), 'utf8')); } catch { return false; }
}
function routeNow(store = storeNow()) {   // 模型库那条还在才算；没选过且 Codex 自己用不了 → 模型库第一个；不然 Codex 自带
  const r = readJson(ROUTE_FILE, {}), lib = libModels(store);
  const hit = r.provider && lib.find(x => x.p.id === r.provider && x.m.id === r.model);
  if (hit) return hit;
  return !r.own && lib.length && !ownUsable() ? lib[0] : null;
}
// codex-acp 自带的 Codex（codex-acp 不给 CODEX_PATH 时用的就是它）
function codexJs() {
  const bin = cxBin();
  const f = bin && path.resolve(path.dirname(bin), '..', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  return f && fs.existsSync(f) ? f : '';
}
const WRAPPER = path.join(DATA, 'codex-app-server.sh');
function appServerWrapper() {
  const body = '#!/bin/sh\n# claclaw 生成：起 Codex 时带上模型库的服务商（值在环境变量里，见 codex.mjs）\nexec "$CLACLAW_CODEX_NODE" "$CLACLAW_CODEX_JS" "$@" -c "$CLACLAW_CODEX_C1" -c "$CLACLAW_CODEX_C2" -c "$CLACLAW_CODEX_C3"\n';
  let cur = ''; try { cur = fs.readFileSync(WRAPPER, 'utf8'); } catch {}
  if (cur !== body) fs.writeFileSync(WRAPPER, body);
  fs.chmodSync(WRAPPER, 0o755);
  return WRAPPER;
}
function routeEnv() {
  const hit = routeNow();
  const env = { NO_BROWSER: '1' };
  if (hit) {
    const pid = 'claclaw-' + hit.p.id, ek = 'CLACLAW_KEY_' + String(hit.p.id).toUpperCase().replace(/[^A-Z0-9]/g, '_');
    if (hit.p.key) env[ek] = hit.p.key;
    env.MODEL_PROVIDER = pid;
    const prov = { name: hit.p.name, base_url: hit.p.endpoints.openai, env_key: ek, wire_api: 'responses' };
    env.CODEX_CONFIG = JSON.stringify({ model_providers: { [pid]: prov }, model: hit.m.id });
    // CODEX_CONFIG 只管会话；codex-acp 建会话前按 Codex 全局配置查「要不要登录」（没登录过、config.toml 也没服务商就拒绝）。
    // 所以换一个启动脚本，起 codex app-server 时用 -c 把服务商也带上（不写 ~/.codex/config.toml）
    const js = codexJs();
    if (js) {
      env.CODEX_PATH = appServerWrapper();
      env.CLACLAW_CODEX_NODE = process.execPath; env.CLACLAW_CODEX_JS = js;
      env.CLACLAW_CODEX_C1 = 'model_provider=' + JSON.stringify(pid);
      env.CLACLAW_CODEX_C2 = 'model_providers.' + pid + '={ ' + Object.entries(prov).map(([k, v]) => k + ' = ' + JSON.stringify(v)).join(', ') + ' }';
      env.CLACLAW_CODEX_C3 = 'model=' + JSON.stringify(hit.m.id);
    }
  }
  const sig = crypto.createHash('sha256').update(JSON.stringify(env)).digest('hex').slice(0, 16);
  return { env, sig };
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
// NO_BROWSER：不提供「浏览器里登录 ChatGPT」（手机上点不了电脑的浏览器）
const agent = new AcpAgent({
  name: 'codex', bin: cxBin, missing: cxUnsupportedReason(),
  command: bin => [bin, []],
  prepare: () => routeEnv(),
  rpcError: e => /auth/i.test(e.message || '') && /requir|login|sign/i.test(e.message || '') ? 'Codex 还没登录：在电脑终端运行 codex 登录（或在 ~/.codex/config.toml 配好服务商）' : '',
});
export const cxShutdown = () => agent.stop();
// 模型库改了：用着的那条变了（地址、key）要重启 codex-acp；没有会话接着就马上关，有就等它们都关掉
export function cxModelsChanged(log) { if (cxSupported()) agent.modelsChanged(routeEnv().sig, log); }
export const cxAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '权限模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// ---------- 打开的 Codex 会话 ----------
// 历史靠 session/load 重放：收下来记在 items 里，之后的新消息也记进去
export const cxRunners = new Map();

export class CxRunner extends AcpRunner {
  static agent = agent; static prefix = CX_PREFIX; static runners = cxRunners;
  static label = 'Codex'; static group = 'Codex'; static permPrefix = 'cx-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; this.opts = opts; }
  get openMethod() { return 'session/load'; }
  ctxNow() { return this.ctx ?? cxInfo(this.id)?.ctx; }   // 刚打开还没新一轮：用会话记录里最后一次的输入量

  async prepareAttach() {
    if (!this.cwd) { const s = cxInfo(this.id); if (s) { this.cwd = s.cwd; this.info.cwd = s.cwd; this.title = this.title || s.title; this.model = this.model || s.model; } }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Codex 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }

  // Codex 对不认识的模型（模型库的）、换过模型的旧会话会先吐一句英文警告当回复，不显示
  handle(u) {
    if (u.sessionUpdate === 'agent_message_chunk' && /^\s*Warning: (Model metadata for|This session was recorded with model)/.test(u.content?.text || '')) return;
    return super.handle(u);
  }

  // 模型选择：模型库一组（能给 Codex 用的）+ Codex 自带一组（Codex 的模型清单）；用着模型库时勾模型库那条
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libModels(store), hit = routeNow(store);
    const libGroup = lib.length ? [{ name: STORE_GROUP, items: lib.map(x => ({ value: x.value, label: x.m.name || x.m.id, sub: x.p.name + ' · ' + x.m.id + (hit ? '' : '（所有 Codex 会话一起换）') })) }] : [];
    const own = (base.groups || []).filter(g => g.name !== STORE_GROUP).map(g => ({ ...g, items: g.items.map(it => hit ? { ...it, sub: (it.sub ? it.sub + ' · ' : '') + '用 Codex 自己的配置' } : it) }));
    if (!base.groups && !libGroup.length) return base;
    return { ...base, current: hit ? hit.value : base.current, label: hit ? (hit.m.name || hit.m.id) : base.label, groups: [...libGroup, ...own] };
  }
  // 换到模型库的模型 / 从模型库换回 Codex 自带：记下走法，重启 codex-acp（所有 Codex 会话一起换），再接上。
  // 刚新建、还没发过消息的会话 Codex 还没存下来，新进程里接不上：在同一个目录重建一个，返回 { runner, label } 让网页换过去
  async pickModel(value) {
    const hit = routeNow(), toLib = value.startsWith(LIB);
    if (!toLib && !hit) return super.pickModel(value);
    if (this.busy) throw new Error('这一轮结束后再换模型');
    if (toLib && hit?.value === value) return hit.m.name || hit.m.id;
    const next = toLib ? libModels(storeNow()).find(x => x.value === value) : null;
    if (toLib && !next) throw new Error('没有这个模型');
    if ([...cxRunners.values()].some(r => r !== this && r.busy)) throw new Error('有别的 Codex 会话正在回复，等它结束再换（所有 Codex 会话共用一个模型服务商）');
    const empty = !cxInfo(this.id);
    writeJsonAtomic(ROUTE_FILE, next ? { provider: next.p.id, model: next.m.id } : { own: true });
    this.log?.('codex route →', next ? next.p.id + '/' + next.m.id : 'codex 自带');
    agent.stop();
    for (let i = 0; i < 50 && agent.running; i++) await new Promise(r => setTimeout(r, 100));   // 等旧进程退干净，再按新走法起
    if (empty) {
      const r = await CxRunner.create(this.cwd || HOME, this.opts);
      return { runner: r, label: next ? next.m.name || next.m.id : await r.pickModel(value) };
    }
    await this.attach();
    if (next) { this.model = next.m.name || next.m.id; return this.model; }
    return super.pickModel(value);   // 换回 Codex 自带：接上以后再选它的模型
  }
}

// 新建：在某个目录里开一个新的 Codex 会话
export const cxNewSession = (cwd, opts) => CxRunner.create(cwd, opts);

// 删除：ACP session/delete（Codex 归档到 ~/.codex/archived_sessions，能找回）
export async function cxDelete(id, log) {
  const s = cxInfo(id);
  if (!s) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  await agent.use(log);
  try { await agent.rpc('session/delete', { sessionId: s.id }); } finally { agent.idleCheck(); }
  fileCache.delete(s.file);
}

// 改名：往 session_index.jsonl 追加一行（Codex 列表、终端里的 codex resume 都认它）
export async function cxRename(id, title, log) {
  const s = cxInfo(id);
  if (!s) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  const r = cxRunners.get(id);
  if (r?.busy) throw Object.assign(new Error('这个会话还在回复，等它结束再改名'), { code: 409 });
  fs.appendFileSync(INDEX, JSON.stringify({ id: s.id, thread_name: title, updated_at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  log?.('codex renamed', s.id.slice(0, 13));
  return title;
}
