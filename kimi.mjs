// Kimi Code CLI 适配（Moonshot 的 `kimi`，装在 ~/.kimi-code/bin/kimi）。
// 全部走 ACP：claclaw 起一个 `kimi acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：`kimi session list --all --json`（kimi 自己的逻辑，不读它的内部文件）
// - 历史：ACP session/load 会把整段历史用 session/update 重放一遍，收下来转成网页条目；接上之后的新消息也记进去
// - 发消息 session/prompt、中断 session/cancel、删除 session/delete（删前 kimi export 存一份 zip 到回收站）
// - 改名：ACP 里没有改名（/title 只在终端界面里有），按 kimi 自己 /title 的做法改会话目录里的 state.json：
//   title + titleKind 'custom'（isCustomTitle: true），之后自动起的标题不会盖掉它。kimi 进程会拿内存里的元数据整个写回，
//   所以 claclaw 自己的 kimi 接着这个会话时先 session/close，下次发消息再接上
// - 模型：claclaw「模型管理」里的模型写进 ~/.kimi-code/config.toml（claclaw- 开头的供应商，key 只走环境变量），
//   不登录 Kimi 账号也能用；登录过的 Kimi 自带模型照样在

// 网页里 Kimi 会话的 id = 'km:' + kimi 会话 id。
// 没做「终端里正开着」的检测：同一个会话别在终端和网页里同时发消息。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { storeNow, kimiInject, kimiConfigMerge, splitGroups } from './modelpick.mjs';

const HOME = os.homedir();
export const KM_PREFIX = 'km:';
export const isKm = id => typeof id === 'string' && id.startsWith(KM_PREFIX);
const sidOf = id => id.slice(KM_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);
const tilde = p => p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();
const tms = v => { const n = typeof v === 'string' ? (/^\d+$/.test(v) ? +v : Date.parse(v)) : +v; return n > 0 ? (n < 1e12 ? n * 1000 : n) : 0; };

export function kmBin() {
  const dirs = new Set([process.env.KIMI_CODE_HOME && path.join(process.env.KIMI_CODE_HOME, 'bin'), path.join(HOME, '.kimi-code', 'bin'), ...(process.env.PATH || '').split(':'), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin')]);
  for (const d of dirs) {
    const p = d && path.join(d, 'kimi');
    if (p && fs.existsSync(p)) { try { return fs.realpathSync(p); } catch { return p; } }
  }
  return null;
}
export const kmInstalled = () => !!kmBin();
const binEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') });
const runBin = (args, ms) => new Promise((ok, fail) => {
  const bin = kmBin();
  if (!bin) return fail(new Error('没找到 kimi 命令，先装好 Kimi Code CLI'));
  execFile(bin, args, { cwd: HOME, env: binEnv(), timeout: ms, maxBuffer: 64 * 1024 * 1024 }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out));
});

// ---------- 会话列表 ----------
let listCache = { at: 0, rows: null, p: null };
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };
function normRow(s) {
  const id = String(pick(s, 'id', 'sessionId', 'session_id') || '');
  if (!validSid(id)) return null;
  return {
    id,
    title: oneLine(pick(s, 'title', 'name', 'summary', 'lastPrompt') || '').slice(0, 100),
    cwd: String(pick(s, 'cwd', 'workDir', 'work_dir', 'workspace', 'directory') || ''),
    updated: tms(pick(s, 'updatedAt', 'updated_at', 'lastUpdated', 'mtime', 'createdAt', 'created_at')),
    model: String(pick(s, 'model', 'modelAlias') || ''),
    dir: String(s.sessionDir || ''),
  };
}
async function listRows() {
  if (listCache.rows && Date.now() - listCache.at < 3000) return listCache.rows;
  if (listCache.p) return listCache.p;
  listCache.p = runBin(['session', 'list', '--all', '--json'], 20000).then(out => {
    let arr = [];
    try { const j = JSON.parse(out.slice(Math.max(0, out.indexOf('[')))); arr = Array.isArray(j) ? j : j?.sessions || []; } catch {}
    const rows = arr.map(normRow).filter(Boolean).sort((a, b) => b.updated - a.updated);
    listCache = { at: Date.now(), rows, p: null };
    return rows;
  }).catch(e => { listCache.p = null; throw e; });
  return listCache.p;
}
const dropListCache = () => { listCache.at = 0; };

export async function kmSessionList({ busy = () => false } = {}) {
  const rows = await listRows();
  return rows.map(s => ({
    id: KM_PREFIX + s.id,
    title: s.title || 'Kimi 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'kimi', busy: busy(KM_PREFIX + s.id),
  }));
}
export async function kmInfo(id) {
  if (!isKm(id)) return null;
  return (await listRows()).find(s => s.id === sidOf(id)) || null;
}

// ---------- 模型库 → config.toml ----------
const CONFIG = path.join(process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code'), 'config.toml');
let acpSig = '', acpStale = false;
// 把模型库同步进 config.toml（内容没变就不写）；返回要给 kimi 进程的环境变量（key）
function syncConfig(log) {
  const inj = kimiInject(storeNow());
  let cur = '';
  try { cur = fs.readFileSync(CONFIG, 'utf8'); } catch {}
  const next = kimiConfigMerge(cur, inj);
  if (next !== cur && (cur || inj.tables)) {
    try { fs.mkdirSync(path.dirname(CONFIG), { recursive: true }); fs.writeFileSync(CONFIG, next, { mode: 0o600 }); log?.('kimi config synced', inj.aliases.length, 'models'); }
    catch (e) { log?.('kimi config write failed', e.message); }
  }
  return inj;
}
// 模型库改了：写好 config.toml；kimi 进程要重启才看得到，没有会话接着就马上关，有就等它们都关掉
export function kmModelsChanged(log) {
  if (!kmInstalled()) return;
  const inj = syncConfig(log);
  if (!proc || inj.sig === acpSig) return;
  acpStale = true;
  if (!owners.size) { log?.('kimi acp restart: models changed'); idleCheck(); }
}

// ---------- ACP 进程（单例，多个会话共用；挂了下次用时再起） ----------
let proc = null, ready = null, rid = 0, idleTimer = null, caps = {};
const pending = new Map();
const owners = new Map();   // kimi 会话 id → KmRunner
const closing = new Map();  // 正在关的会话：等它关完再接上，免得旧 runner 删掉新 runner 的登记

function startAcp(log) {
  if (ready) return ready;
  const bin = kmBin();
  if (!bin) return Promise.reject(new Error('没找到 kimi 命令，先装好 Kimi Code CLI'));
  const inj = syncConfig(log);
  acpSig = inj.sig; acpStale = false;
  const p = spawn(bin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: HOME, env: { ...binEnv(), ...inj.env } });
  proc = p;
  let buf = '', errTail = '';
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.method && m.id != null) onAgentRequest(m);
      else if (m.method) onNotify(m);
      else if (m.id != null && pending.has(m.id)) {
        const q = pending.get(m.id); pending.delete(m.id);
        if (m.error) q.rej(new Error(m.error.code === -32000 ? 'Kimi 没有可用的模型：在 claclaw 的「模型管理」里加一个模型，或在电脑终端运行 kimi login 登录 Kimi 账号' : (m.error.data?.details || m.error.data?.message || m.error.message || 'kimi 请求失败')));
        else q.res(m.result);
      }
    }
  });
  p.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
  const dead = why => {
    if (proc !== p) return;
    proc = null; ready = null;
    const e = new Error(why);
    for (const q of pending.values()) q.rej(e);
    pending.clear();
    for (const r of owners.values()) r.onAcpDead(why);
    owners.clear();
  };
  p.on('error', e => dead('kimi 启动失败：' + e.message));
  p.on('exit', code => { log?.('kimi acp exited', code); dead('kimi 进程退出了（' + code + '）'); });
  log?.('kimi acp starting', bin);
  let initTimer = null;
  const init = rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claclaw', version: '0.1' } });
  const timeout = new Promise((_, rej) => { initTimer = setTimeout(() => rej(new Error('initialize 45 秒没有应答')), 45000); initTimer.unref?.(); });
  ready = Promise.race([init, timeout])
    .then(r => { clearTimeout(initTimer); caps = r?.agentCapabilities || {}; log?.('kimi acp ready'); return p; })
    .catch(e => {
      clearTimeout(initTimer);
      const why = 'kimi 初始化失败：' + (e?.message || e);
      try { p.kill(); } catch {}
      dead(why);
      throw new Error(why);
    });
  ready.catch(() => {});
  return ready;
}
function rpc(method, params) {
  if (!proc) return Promise.reject(new Error('kimi 没在运行'));
  return new Promise((res, rej) => {
    const id = ++rid;
    pending.set(id, { res, rej });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}
function notifyAgent(method, params) { proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
function answer(id, result, error) { proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
function onNotify(m) {
  if (m.method !== 'session/update') return;
  owners.get(m.params?.sessionId)?.handle(m.params.update || {});
}
function onAgentRequest(m) {
  const r = owners.get(m.params?.sessionId);
  if (m.method === 'session/request_permission' && r) return r.askPermission(m.id, m.params);
  if (m.method === 'session/request_permission') return answer(m.id, { outcome: { outcome: 'cancelled' } });
  answer(m.id, null, { code: -32601, message: 'method not supported: ' + m.method });
}
// 没有会话接着时，过 10 分钟把 kimi 进程关掉
function idleCheck() {
  clearTimeout(idleTimer);
  if (owners.size || !proc) return;
  if (acpStale) { try { proc.stdin.end(); proc.kill(); } catch {} return; }   // 模型库改过：现在没人用，马上重启（下次用时带上新的）
  idleTimer = setTimeout(() => { if (!owners.size && proc) { try { proc.stdin.end(); proc.kill(); } catch {} } }, 10 * 60 * 1000);
}
export function kmShutdown() { try { proc?.stdin.end(); proc?.kill(); } catch {} }
export const kmAcpRunning = () => !!proc;
async function waitClosing(sid) { const p = closing.get(sid); if (p) { try { await p; } catch {} } }

// ---------- 可调选项（ACP configOptions）：model / thinking / mode ----------
const flatOptions = opt => (opt?.options || []).flatMap(o => o.options ? o.options : [o]);
const optName = (cfg, id) => {
  const o = cfg?.find(x => x.id === id);
  if (!o) return '';
  return flatOptions(o).find(x => x.value === o.currentValue)?.name || String(o.currentValue || '');
};
const CFG_NAMES = { model: '模型', thinking: '思考', mode: '模式' };
export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'thinking', description: '思考开关 / 强度（不带参数：列出可选项）', hint: '<选项>', builtin: true },
  { name: 'mode', description: '审批模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

const toolTarget = a => {
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return a.slice(0, 160); } }
  if (!a || typeof a !== 'object') return '';
  const v = a.command ?? a.cmd ?? a.filePath ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
};
function toolLabel(name = '', kind = '') {
  if (kind === 'execute' || /bash|shell/i.test(name)) return '运行命令';
  if (kind === 'read' || /^read/i.test(name)) return '读文件';
  if (kind === 'edit' || /edit|write|patch/i.test(name)) return '改文件';
  if (kind === 'search' || /grep|glob|list|search/i.test(name)) return '查找中';
  if (kind === 'fetch' || /web|fetch/i.test(name)) return '查网页';
  if (/task|agent/i.test(name)) return '派子任务';
  if (/todo/i.test(name)) return '列计划';
  return '用工具';
}
// kimi 的工具参数是流式的：in_progress 的 content 里是正在拼的参数 JSON，拼完整了才解析得出来
const argsOf = u => { const t = u.content?.[0]?.content?.text; if (typeof t !== 'string' || t[0] !== '{') return null; try { return JSON.parse(t); } catch { return null; } };
const stripReminder = t => String(t || '')
  .replace(/^\s*Skill tool loaded instructions[^\n]*\n*/, '')   // Kimi 加载技能时插进来的「用户消息」，不是用户发的
  .replace(/\s*<skill-loaded[\s\S]*?<\/skill-loaded>\s*/g, '\n')
  .replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n').trim();
const toolOutput = u => {
  let out = (u.content || []).map(c => c.type === 'content' && c.content?.type === 'text' ? c.content.text : c.type === 'diff' ? '改了 ' + (c.path || '') : '').filter(Boolean).join('\n');
  if (!out && u.rawOutput) out = typeof u.rawOutput === 'string' ? u.rawOutput : String(u.rawOutput.output ?? u.rawOutput.error ?? u.rawOutput.stdout ?? '');
  return out.slice(0, 4000);
};

// ---------- 打开的 Kimi 会话：接口和 OpRunner 对齐 ----------
export const kmRunners = new Map();

export class KmRunner {
  constructor(id, { log, onActivity, onTurnDone, onAsk, info }) {
    this.id = id; this.sid = sidOf(id);
    this.log = log; this.onActivity = onActivity; this.onTurnDone = onTurnDone; this.onAsk = onAsk;
    this.cwd = info?.cwd || '';
    this.info = { sessionId: id, cwd: this.cwd };
    this.title = info?.title || '';
    this.model = info?.model || '';
    this.mode = 'default'; this.allowedModes = ['default'];
    this.busy = false; this.busySince = 0;
    this.subs = new Set(); this.pending = new Map();
    this.suggestion = null; this.commands = COMMANDS;
    this.closed = false; this.attached = false; this.config = null;
    this.textOpen = false; this.msgId = null;
    this.queue = [];
    this.tools = new Map();     // toolCallId → { name, kind, started, finished, item }
    this.items = [];            // 网页条目：载入时的重放 + 之后的新消息
    this.replaying = false;
    this.attaching = null;
  }

  history() { return { items: this.items, total: this.items.length }; }
  metaLine() { return tilde(this.cwd || '') + (this.model ? ' · ' + this.model : ''); }

  // 接上 kimi（session/load：历史顺带重放过来）。打开会话、发消息前都调；接上过就直接返回
  attach() {
    if (this.attached) return Promise.resolve();
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      if (!this.cwd) { const s = await kmInfo(this.id).catch(() => null); if (s) { this.cwd = s.cwd; this.info.cwd = s.cwd; this.title = this.title || s.title; this.model = this.model || s.model; } }
      await startAcp(this.log);
      clearTimeout(idleTimer);
      await waitClosing(this.sid);
      owners.set(this.sid, this);
      this.items = []; this.tools.clear(); this.replayOpen = null;
      this.replaying = true;
      try {
        const r = await rpc('session/load', { sessionId: this.sid, cwd: this.cwd || HOME, mcpServers: [] });
        this.setConfig(r?.configOptions);
        this.attached = true;
      } catch (e) {
        if (owners.get(this.sid) === this) owners.delete(this.sid);
        idleCheck();
        throw e;
      } finally { this.replaying = false; this.replayOpen = null; }
      for (const it of this.items) if (it.kind === 'user') it.text = stripReminder(it.text);
      this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
      if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Kimi 会话';
    })().finally(() => { this.attaching = null; });
    return this.attaching;
  }
  setConfig(cfg) {
    if (!Array.isArray(cfg)) return;
    this.config = cfg;
    const name = optName(cfg, 'model');
    if (name && name !== this.model) { this.model = name; this.emit({ t: 'session.meta', cwdShort: this.metaLine() }); }
    this.emit({ t: 'xmodels', ...this.xmodels() });
  }

  emit(ev) {
    if (this.replaying) return;
    const s = JSON.stringify({ ...ev, sessionId: this.id });
    for (const w of this.subs) if (w.readyState === 1) w.send(s);
  }
  setBusy(on) {
    if (this.busy === on) return;
    this.busy = on; if (on) this.busySince = Date.now();
    this.emit({ t: 'busy', on });
    this.onActivity?.(this.id, on ? '思考中' : null);
  }
  closeText() { if (this.textOpen) { this.textOpen = false; this.emit({ t: 'ai.end' }); } this.msgId = null; }

  handle(u) {
    if (this.closed) return;
    const last = this.items[this.items.length - 1];
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {
        if (!this.replaying) return;   // 网页发的消息 send() 里已经记了
        const t = u.content?.type === 'text' ? u.content.text : '';
        const img = u.content?.type === 'image' && u.content.data ? { media_type: u.content.mimeType || 'image/png', data: u.content.data } : null;
        if (!t && !img) return;
        if (last?.kind === 'user' && this.replayOpen === 'user') { if (t) last.text += t; if (img) (last.images ||= []).push(img); }
        else { this.items.push({ kind: 'user', text: t || '', images: img ? [img] : undefined }); this.replayOpen = 'user'; }
        return;
      }
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? u.content.text : '';
        if (!t) return;
        const fresh = this.replaying ? !(last?.kind === 'ai' && this.replayOpen === 'ai' && (!u.messageId || u.messageId === this.msgId))
          : (!this.textOpen || (u.messageId && u.messageId !== this.msgId));
        if (fresh) {
          if (!this.replaying) { this.closeText(); this.textOpen = true; this.lastText = ''; this.emit({ t: 'ai.start' }); }
          this.msgId = u.messageId; this.replayOpen = 'ai';
          this.items.push({ kind: 'ai', text: t, at: this.replaying ? undefined : Date.now() });
        } else last.text += t;
        if (!this.replaying) { this.lastText += t; this.emit({ t: 'ai.delta', text: t }); this.onActivity?.(this.id, '回复中'); }
        return;
      }
      case 'agent_thought_chunk':
        if (!this.replaying) this.onActivity?.(this.id, '思考中');
        return;
      case 'tool_call':
      case 'tool_call_update': {
        this.replayOpen = 'tool';
        let t = this.tools.get(u.toolCallId);
        if (!t) { t = { name: u.title || 'tool', kind: u.kind || '', started: false }; this.tools.set(u.toolCallId, t); }
        if (u.title && !t.started && !/^Running: /.test(u.title)) t.name = u.title;
        if (u.rawInput && typeof u.rawInput === 'object') t.args = u.rawInput;
        else if (!t.args && u.status === 'in_progress') t.args = argsOf(u);
        const target = toolTarget(t.args);
        const done = u.status === 'completed' || u.status === 'failed';
        if (!t.started && (target || done)) {
          t.started = true;
          this.closeText();
          t.item = { kind: 'tool', id: u.toolCallId, name: t.name, target, status: 'ok', output: '' };
          this.items.push(t.item);
          this.emit({ t: 'tool.start', id: u.toolCallId, name: t.name, target });
          if (!this.replaying) this.onActivity?.(this.id, toolLabel(t.name, u.kind || t.kind));
        }
        if (done && !t.finished && t.item) {
          t.finished = true;
          const out = toolOutput(u);
          t.item.output = out; t.item.status = u.status === 'failed' ? 'no' : 'ok';
          this.emit({ t: 'tool.result', id: u.toolCallId, output: out, isError: u.status === 'failed' });
        }
        return;
      }
      case 'usage_update':   // 在 session/prompt 应答之后才到：这一轮已经结束了就直接发
        if (Number(u.used) > 0) {
          this.ctx = Number(u.used);
          if (!this.busy && !this.replaying && this.ctx !== this.ctxSent) { this.ctxSent = this.ctx; this.emit({ t: 'ctx', tokens: this.ctx }); }
        }
        return;
      case 'session_info_update':
        if (u.title && !this.replaying) { const t = oneLine(u.title).slice(0, 100); if (t && t !== this.title) { this.title = t; this.emit({ t: 'session.renamed', title: t }); } }
        return;
      case 'config_option_update':
        this.setConfig(u.configOptions);
        return;
    }
  }

  // kimi 要确认的操作：转成网页的确认条（和 OpenCode 的同一种）
  askPermission(rpcId, p) {
    const requestId = 'km-' + rpcId;
    const opts = p.options || [];
    const tc = p.toolCall || {};
    const known = this.tools.get(tc.toolCallId);
    const tool = known?.name || tc.title || '';
    const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : known?.args || {};
    // 参数还没解析出来时，用 kimi 给的提示文字「Requesting approval to Running: echo hi」
    const hint = String(tc.content?.[0]?.content?.text || '').replace(/^Requesting approval to\s*/i, '').replace(/^Running:\s*/, '');
    if (known && !known.started) {   // 卡片还没出来（参数没拼完就来要确认）：先把卡片显示出来，确认条才有地方挂
      known.started = true;
      this.closeText();
      known.item = { kind: 'tool', id: tc.toolCallId, name: known.name, target: toolTarget(raw) || hint, status: 'ok', output: '' };
      this.items.push(known.item);
      this.emit({ t: 'tool.start', id: tc.toolCallId, name: known.name, target: known.item.target });
    }
    const isCmd = tc.kind === 'execute' || /bash|shell/i.test(tool) || typeof raw.command === 'string';
    const isEdit = !isCmd && (tc.kind === 'edit' || /edit|write|patch/i.test(tool));
    const name = isCmd ? 'Bash' : isEdit ? 'Edit' : (tool || '操作');
    const target = (isCmd && raw.command ? String(raw.command) : toolTarget(raw) || hint || String(tc.title || '')).slice(0, 4000);
    const req = {
      t: 'perm.request', requestId, toolUseID: tc.toolCallId, name,
      title: null, displayName: name, description: '', target,
      reason: '', canAlways: opts.some(o => o.kind === 'allow_always'), defaultToNo: false,
    };
    this.pending.set(requestId, { rpcId, opts, req });
    this.emit(req);
    this.onAsk?.(this, '等你确认：' + (isCmd ? '运行命令' : isEdit ? '修改文件' : name));
  }
  replyPermission(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    const kind = decision === 'allow' ? 'allow_once' : decision === 'allow_session' ? 'allow_always' : 'reject_once';
    const opt = p.opts.find(o => o.kind === kind) || (kind === 'reject_once' && p.opts.find(o => o.kind === 'reject_always'));
    answer(p.rpcId, opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
    this.emit({ t: 'perm.done', requestId, toolUseID: p.req.toolUseID, decision });
  }

  send(text, images = []) {
    if (!this.busy && /^\/compact\s*$/.test(String(text))) this.compactAsked = true;
    if (this.busy) {
      if (/^\/(model|thinking|mode)\b/.test(text) || this.queue.length >= 10) return false;
      this.queue.push({ text, images });
      return 'queued';
    }
    const cmd = text.match(/^\/(model|thinking|mode)(?:\s+(.*))?$/);
    this.lastText = '';
    this.setBusy(true);
    (async () => {
      try {
        await this.attach();
        if (cmd) return this.finish(await this.command(cmd[1], (cmd[2] || '').trim()));
        if (images.length && !caps.promptCapabilities?.image) throw new Error('kimi 没有声明图片输入');
        this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() });
        const prompt = [
          ...images.map(i => ({ type: 'image', mimeType: i.media_type, data: i.data })),
          ...(text ? [{ type: 'text', text }] : []),
        ];
        const r = await rpc('session/prompt', { sessionId: this.sid, prompt });
        dropListCache();
        this.finish({ reason: r?.stopReason || 'end_turn' });
      } catch (e) {
        this.finish({ error: e.message });
      }
    })();
    return true;
  }
  finish({ reason, error, text } = {}) {
    if (this.closed) return;
    this.closeText();
    for (const [id, t] of this.tools) if (t.finished || !t.started) this.tools.delete(id);
    if (text) { this.emit({ t: 'ai.full', text }); }
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    const ok = !error && (reason === 'end_turn' || reason === 'command');
    const subtype = error ? 'error' : reason === 'cancelled' ? 'aborted' : ok ? 'success' : reason;
    if (error) this.emit({ t: 'error', message: error });
    if (this.ctx != null && (this.ctx !== this.ctxSent || this.compactAsked)) {
      this.emit({ t: 'ctx', tokens: this.ctx, ...(this.compactAsked && !error ? { compacted: true } : {}) });
      this.ctxSent = this.ctx;
    }
    this.compactAsked = false;
    this.busy = false;
    this.emit({ t: 'turn.done', subtype, error: error || (reason === 'cancelled' ? '已中断' : reason === 'max_tokens' ? '回复超出长度上限' : reason === 'refusal' ? '模型拒绝回答' : undefined) });
    this.onActivity?.(this.id, null);
    if (reason !== 'command') this.onTurnDone?.(this, ok, this.lastText);
    if (this.queue.length && this.sendQueued()) return;
    if (!this.subs.size) this.dispose();
  }
  sendQueued() {
    const q = this.queue.splice(0);
    const text = q.map(x => x.text).filter(Boolean).join('\n\n');
    const images = q.flatMap(x => x.images || []);
    if (!text && !images.length) return false;
    if (!this.send(text, images)) return false;
    this.emit({ t: 'queue.sent' });
    return true;
  }

  // /model、/thinking、/mode：ACP 的 session/set_config_option
  async command(name, arg) {
    const opt = this.config?.find(o => o.id === name);
    if (!opt) return { reason: 'command', text: '当前会话没有可调的' + CFG_NAMES[name] };
    const list = flatOptions(opt);
    const cur = list.find(o => o.value === opt.currentValue);
    if (!arg) return { reason: 'command', text: '当前：' + (cur?.name || opt.currentValue) + '\n\n可选：\n' + list.map(o => '- `' + o.value + '`' + (o.name !== o.value ? ' ' + o.name : '') + (o.description ? ' ' + o.description : '')).join('\n') };
    const a = arg.toLowerCase();
    const hit = list.find(o => String(o.value).toLowerCase() === a || String(o.name).toLowerCase() === a)
      || list.filter(o => (o.name + ' ' + o.value).toLowerCase().includes(a)).sort((x, y) => String(x.value).length - String(y.value).length)[0];
    if (!hit) return { reason: 'command', text: '没有匹配「' + arg + '」的选项' };
    const r = await rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value: hit.value });
    this.setConfig(r?.configOptions);
    return { reason: 'command', text: '已切换为 ' + hit.name + '（下一条消息生效）' };
  }

  // 会话设置里的模型选择：模型库注入的（claclaw-*）一组，Kimi 自带的一组。还没接上 kimi 时只有当前模型名
  xmodels() {
    const opt = this.config?.find(o => o.id === 'model');
    if (!opt) return { current: null, label: this.model || '', groups: null };
    const store = storeNow(), list = flatOptions(opt);
    const own = list.map(o => {
      const v = String(o.value), m = v.match(/^claclaw-([^/]+)\/(.+)$/);
      const sp = m ? store.providers.find(p => p.id === m[1]) : null;
      return { value: v, label: String(o.name || v), id: m ? m[2] : v, base: sp ? Object.values(sp.endpoints)[0] : '' };
    });
    const cur = list.find(o => o.value === opt.currentValue);
    return { current: opt.currentValue, label: cur ? String(cur.name) : this.model, groups: splitGroups(store, 'Kimi', own) };
  }
  async loadXModels() {
    if (!this.attached) await this.attach();
    this.emit({ t: 'xmodels', ...this.xmodels() });
  }
  async pickModel(value) {
    if (this.busy) throw new Error('这一轮结束后再换模型');
    if (!this.attached) await this.attach();
    const opt = this.config?.find(o => o.id === 'model');
    const hit = flatOptions(opt).find(o => o.value === value);
    if (!opt || !hit) throw new Error('没有这个模型');
    const r = await rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value });
    this.setConfig(r?.configOptions);
    this.log?.('kimi model', this.sid.slice(0, 16), '→', value);
    return String(hit.name || value);
  }

  async interrupt() {
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    if (this.attached) notifyAgent('session/cancel', { sessionId: this.sid });
    this.emit({ t: 'sys', text: '已中断' });
  }
  async setMode() {}

  onAcpDead(why) {
    this.attached = false;
    if (this.busy) this.finish({ error: why });
  }

  subscribe(w) { this.subs.add(w); }
  unsubscribe(w) { this.subs.delete(w); if (!this.subs.size && !this.busy) this.dispose(); }
  watched() { return [...this.subs].some(w => w.visible !== false); }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    kmRunners.delete(this.id);
    if (this.attached) {
      this.attached = false;
      const p = rpc('session/close', { sessionId: this.sid }).catch(() => {}).finally(() => {
        if (owners.get(this.sid) === this) owners.delete(this.sid);
        closing.delete(this.sid);
        idleCheck();
      });
      closing.set(this.sid, p);
    } else if (owners.get(this.sid) === this) { owners.delete(this.sid); idleCheck(); }
  }
}

// 新建：在某个目录里开一个新的 kimi 会话
export async function kmNewSession(cwd, opts) {
  await startAcp(opts.log);
  clearTimeout(idleTimer);
  const r = await rpc('session/new', { cwd, mcpServers: [] });
  await waitClosing(r.sessionId);
  dropListCache();
  const id = KM_PREFIX + r.sessionId;
  const runner = new KmRunner(id, { ...opts, info: { cwd, title: '新会话' } });
  owners.set(r.sessionId, runner);
  runner.attached = true;
  runner.setConfig(r.configOptions);
  kmRunners.set(id, runner);
  return runner;
}

// 删除：先 kimi export 存一份 zip 到 claclaw 回收站，再 ACP session/delete
export async function kmDelete(id, trashDir, log) {
  const sid = sidOf(id);
  if (!validSid(sid) || !(await kmInfo(id))) throw new Error('找不到这个会话');
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const file = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_kimi_' + sid + '.zip');
  await runBin(['export', sid, '-o', file, '-y', '--no-include-global-log'], 120000);
  if (!fs.existsSync(file)) throw new Error('导出失败，未删除');
  await startAcp(log);
  try { await rpc('session/delete', { sessionId: sid }); } finally { idleCheck(); }
  dropListCache();
  return file;
}

// 改名（见文件开头）。终端里正开着同一个会话的 kimi 之后写元数据时会把名字改回去，要在终端里重开
export async function kmRename(id, title, log) {
  const sid = sidOf(id);
  const s = validSid(sid) ? await kmInfo(id).catch(() => null) : null;
  if (!s?.dir) throw new Error('找不到这个会话');
  const file = path.join(s.dir, 'state.json');
  const root = path.join(process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code'), 'sessions');
  if (!fs.realpathSync(file).startsWith(fs.realpathSync(root) + path.sep)) throw new Error('会话目录不对');
  const r = kmRunners.get(id);
  if (r?.busy) throw Object.assign(new Error('这个会话还在回复，等它结束再改名'), { code: 409 });
  if (r?.attached || owners.has(sid)) {
    // 先让 kimi 放下这个会话，免得它拿内存里的旧标题写回去；runner 留着（网页里照常显示），下次发消息再 session/load 接上
    if (r) r.attached = false;
    try { await rpc('session/close', { sessionId: sid }); } catch {}
    if (owners.get(sid) === r || !r) owners.delete(sid);
    idleCheck();
  }
  await waitClosing(sid);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (meta?.id && meta.id !== sid) throw new Error('会话记录对不上');
  const next = { ...meta, title, titleKind: 'custom', isCustomTitle: true };
  const tmp = file + '.claclaw-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  dropListCache();
  log?.('kimi renamed', sid.slice(0, 16));
  return title;
}
