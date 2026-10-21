// OpenCode 适配。
// - 会话列表和历史：只读打开 ~/.local/share/opencode/opencode.db（SQLite，用 Node 自带的 node:sqlite），不用起 opencode。
// - 发消息：claclaw 自己起一个 `opencode acp`（ACP 标准协议，stdin/stdout 一行一条 JSON-RPC），
//   session/resume 接上已有会话、session/prompt 发消息。和 dsh 的适配是一个路子。
// 网页里 OpenCode 会话的 id = 'op:' + opencode 会话 id（ses_…），和 Claude 的 UUID、oc:、ds: 区分开。
// 接管：opencode 不登记「哪个进程开着哪个会话」，也没有写入锁，只能按目录推断——终端里有 opencode 开在某个目录，
// 这个目录里在它启动之后有过改动的会话中最新的那个（claclaw 自己写的不算），就当作正在终端里用着。
// 和 Claude 会话一样：原处闲置满「接管等待」的分钟数才能接管，接管会结束终端里的那个 opencode。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile, execFileSync } from 'node:child_process';

const HOME = os.homedir();
const DATA_DIR = path.join(process.env.XDG_DATA_HOME || path.join(HOME, '.local', 'share'), 'opencode');
const DB = path.join(DATA_DIR, 'opencode.db');
export const OP_PREFIX = 'op:';
export const isOp = id => typeof id === 'string' && id.startsWith(OP_PREFIX);
const sidOf = id => id.slice(OP_PREFIX.length);
const validSid = sid => /^ses_[A-Za-z0-9]+$/.test(sid);
const tilde = p => p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;
// opencode 还没起好标题时的默认标题
const DEFAULT_TITLE = /^(New session|Child session) - \d{4}-\d\d-\d\dT/;

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}

export const opInstalled = () => fs.existsSync(DB) || !!opBin();

// 每次查询单独开一个只读连接，用完就关：不占着库，也不怕 opencode 升级时换了库文件
function query(fn) {
  if (!sqlite) throw new Error('当前 Node 没有 node:sqlite（需要 Node 22.13 以上），读不了 OpenCode 会话');
  if (!fs.existsSync(DB)) return null;
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  try { return fn(db); } finally { try { db.close(); } catch {} }
}
const parse = s => { try { return JSON.parse(s); } catch { return null; } };
const modelOf = m => { const o = typeof m === 'string' ? parse(m) : m; return o?.id || o?.modelID || ''; };
const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();

// ---------- 会话列表 ----------
const LIST_SQL = `select id, directory, title, time_created, time_updated, model from session
  where parent_id is null and time_archived is null order by time_updated desc limit 300`;
// 第一条用户消息（还没起标题的会话拿它当标题）
const FIRST_SQL = `select p.data from part p join message m on m.id = p.message_id
  where m.session_id = ? and json_extract(m.data, '$.role') = 'user' and json_extract(p.data, '$.type') = 'text'
    and coalesce(json_extract(p.data, '$.synthetic'), 0) = 0
  order by p.time_created, p.id limit 1`;

function listRows() {
  return query(db => {
    const first = db.prepare(FIRST_SQL);
    return db.prepare(LIST_SQL).all().map(s => ({
      ...s, first: !s.title || DEFAULT_TITLE.test(s.title) ? oneLine(parse(first.get(s.id)?.data)?.text) : '',
    }));
  }) || [];
}
const titleOf = s => (s.title && !DEFAULT_TITLE.test(s.title) ? s.title : s.first.slice(0, 60)) || '新会话';

export function opSessionList({ busy = () => false, takeoverMin = 30 } = {}) {
  const rows = listRows();
  const held = heldSessions(rows, takeoverMin);
  return rows.map(s => ({
    id: OP_PREFIX + s.id,
    title: titleOf(s),
    cwd: s.directory, cwdShort: tilde(s.directory || ''), branch: modelOf(s.model),
    lastModified: s.time_updated,
    openInWeb: false, busyElsewhere: held.get(s.id) || null, unread: 0, webActive: 0,
    claw: 'opencode', busy: busy(OP_PREFIX + s.id),
  }));
}
export const opExists = id => isOp(id) && validSid(sidOf(id)) && !!query(db => db.prepare('select 1 from session where id = ?').get(sidOf(id)));

// ---------- 终端里开着的 opencode → 推断它占着的会话 ----------
const ourWrites = new Map();   // opencode 会话 id → claclaw 最后一次往里写的时间（这些改动不算终端的）
const touch = sid => ourWrites.set(sid, Date.now());

function etimeMs(s) {   // ps 的 etime：[[dd-]hh:]mm:ss
  const [d, rest] = s.includes('-') ? s.split('-') : ['0', s];
  const p = rest.split(':').map(Number);
  while (p.length < 3) p.unshift(0);
  return (((Number(d) * 24 + p[0]) * 60 + p[1]) * 60 + p[2]) * 1000;
}
let procCache = { at: 0, list: [] };
function foreignProcs() {
  if (Date.now() - procCache.at < 3000) return procCache.list;
  const list = [];
  let out = '';
  try { out = execFileSync('ps', ['-axo', 'pid=,ppid=,etime=,comm='], { encoding: 'utf8' }); } catch {}
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!m || !/(^|\/)opencode(\.exe)?$/.test(m[4].trim())) continue;
    const pid = Number(m[1]);
    if (pid === proc?.pid || Number(m[2]) === process.pid) continue;   // claclaw 自己起的
    list.push({ pid, start: Date.now() - etimeMs(m[3]) });
  }
  if (list.length) {
    let o = '';
    try { o = execFileSync('lsof', ['-a', '-d', 'cwd', '-Fpn', '-p', list.map(p => p.pid).join(',')], { encoding: 'utf8' }); }
    catch (e) { o = String(e.stdout || ''); }   // 有进程刚退出时 lsof 返回非 0，但别的照样输出
    let cur = null;
    for (const l of o.split('\n')) {
      if (l[0] === 'p') cur = list.find(p => p.pid === Number(l.slice(1)));
      else if (l[0] === 'n' && cur) cur.cwd = l.slice(1);
    }
  }
  procCache = { at: Date.now(), list: list.filter(p => p.cwd) };
  return procCache.list;
}
const realCache = new Map();
const real = d => { if (!realCache.has(d)) { let r = d; try { r = fs.realpathSync(d); } catch {} realCache.set(d, r); } return realCache.get(d); };

// 会话 id → 和 Claude 会话的 busyElsewhere 同一种格式
function heldSessions(rows, takeoverMin) {
  const held = new Map();
  const procs = foreignProcs();
  if (!procs.length) return held;
  for (const p of procs) {
    const s = rows.find(r => r.directory && (r.directory === p.cwd || real(r.directory) === p.cwd)
      && r.time_updated >= p.start - 2000 && !(ourWrites.get(r.id) >= r.time_updated - 5000));
    if (!s) continue;
    const h = held.get(s.id);
    if (h) { h.pids.push(p.pid); continue; }
    const idleMin = Math.floor((Date.now() - s.time_updated) / 60000);
    const status = idleMin < 15 && lastTurnOpen(s.id) ? 'busy' : 'idle';
    held.set(s.id, {
      pids: [p.pid], entrypoint: 'cli', name: titleOf(s), status,
      idleMin, canTakeover: status === 'idle' && idleMin >= takeoverMin, needMin: takeoverMin,
    });
  }
  return held;
}
// 最后一条是用户消息、或者回复还没结束：终端那边正在干活
function lastTurnOpen(sid) {
  const m = query(db => db.prepare('select data from message where session_id = ? order by time_created desc, id desc limit 1').get(sid));
  const d = parse(m?.data);
  return !!d && (d.role === 'user' || !d.time?.completed);
}

export function opTakeoverInfo(id, takeoverMin) {
  if (!isOp(id) || !foreignProcs().length) return null;
  return heldSessions(listRows(), takeoverMin).get(sidOf(id)) || null;
}
export async function opEndHolders(info) {
  const pids = info?.pids || [];
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
  for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  for (let i = 0; i < 50 && pids.some(alive); i++) await new Promise(r => setTimeout(r, 100));
  for (const pid of pids) if (alive(pid)) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  procCache.at = 0;
  return !pids.some(alive);
}

// ---------- 记录 → 网页条目（和 Claude 历史同一套格式；图片给 {media_type, data}，由 server 的分页按预算转成 data URL） ----------
const toolTarget = a => {
  if (typeof a === 'string') { const o = parse(a); if (!o) return a.slice(0, 160); a = o; }
  if (!a || typeof a !== 'object') return '';
  const v = a.command ?? a.filePath ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
};
function dataImage(p) {
  const m = String(p.url || '').match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  return m ? { media_type: m[1], data: m[2] } : null;
}
const errText = e => e?.name === 'MessageAbortedError' ? '已中断' : '出错：' + (e?.data?.message || e?.message || e?.name || '未知错误');

function toItems(msgs, parts) {
  const byMsg = new Map();
  for (const p of parts) {
    const d = parse(p.data);
    if (!d) continue;
    if (!byMsg.has(p.message_id)) byMsg.set(p.message_id, []);
    byMsg.get(p.message_id).push(d);
  }
  const items = [];
  for (const m of msgs) {
    const md = parse(m.data);
    if (!md) continue;
    const ps = byMsg.get(m.id) || [];
    if (md.role === 'user') {
      const text = ps.filter(p => p.type === 'text' && !p.synthetic && !p.ignored).map(p => p.text).join('\n').trim();
      const imgs = ps.filter(p => p.type === 'file' && /^image\//.test(p.mime || '')).map(dataImage).filter(Boolean);
      if (text || imgs.length) items.push({ kind: 'user', text, images: imgs.length ? imgs : undefined });
    } else if (md.role === 'assistant') {
      for (const p of ps) {
        if (p.type === 'text' && !p.synthetic && p.text?.trim()) items.push({ kind: 'ai', text: p.text.trim() });
        else if (p.type === 'tool') {
          const st = p.state || {};
          items.push({ kind: 'tool', id: p.callID || p.id, name: p.tool, target: toolTarget(st.input), status: st.status === 'error' ? 'no' : 'ok', output: String(st.output ?? st.error ?? '').slice(0, 4000) });
        }
      }
      if (md.error) items.push({ kind: 'ai', text: '（' + errText(md.error) + '）' });
    }
  }
  return items;
}

// ---------- ACP 进程（单例，多个会话共用；挂了下次用时再起） ----------
function opBin() {
  const dirs = new Set([path.dirname(process.execPath), ...(process.env.PATH || '').split(':'), path.join(HOME, '.opencode', 'bin'), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin')]);
  for (const d of dirs) {
    const p = d && path.join(d, 'opencode');
    if (p && fs.existsSync(p)) { try { return fs.realpathSync(p); } catch { return p; } }
  }
  return null;
}
const binEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') });

let proc = null, ready = null, rid = 0, idleTimer = null, caps = {};
const pending = new Map();
const owners = new Map();   // opencode 会话 id → OpRunner（收 session/update 和权限请求）
// 正在关闭的会话：sid → 关闭用的 Promise。旧 runner 的关闭还没结束，同一个会话又被打开时，
// 新 runner 刚登记的 owners 会被旧 runner 的 finally 删掉（回复不显示），所以要等它关完再 resume。
const closing = new Map();

function startAcp(log) {
  if (ready) return ready;
  const bin = opBin();
  if (!bin) return Promise.reject(new Error('没找到 opencode 命令，先装好 OpenCode'));
  const p = spawn(bin, ['acp'], { stdio: ['pipe', 'pipe', 'pipe'], cwd: HOME, env: binEnv() });
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
        m.error ? q.rej(new Error(m.error.data?.details || m.error.data?.message || m.error.message || 'opencode 请求失败')) : q.res(m.result);
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
  p.on('error', e => dead('opencode 启动失败：' + e.message));
  p.on('exit', code => { log?.('opencode acp exited', code, errTail.trim().split('\n').pop() || ''); dead('opencode 进程退出了（' + code + '）'); });
  log?.('opencode acp starting', bin);
  // initialize 最多等 15 秒：初始化失败或挂住时，ready 会永远停在 rejected/pending，
  // 整个 OpenCode 后端就永久不可用了。超时就杀掉子进程、把 proc/ready 置空，下次用时自动重新拉起。
  let initTimer = null;
  const init = rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claclaw', version: '0.1' } });
  const timeout = new Promise((_, rej) => {
    initTimer = setTimeout(() => rej(new Error('initialize 15 秒没有应答')), 15000);
    initTimer.unref?.();
  });
  ready = Promise.race([init, timeout])
    .then(r => { clearTimeout(initTimer); caps = r?.agentCapabilities || {}; log?.('opencode acp ready'); return p; })
    .catch(e => {
      clearTimeout(initTimer);
      const last = errTail.trim().split('\n').pop() || '';
      const why = 'opencode 初始化失败：' + (e?.message || e) + (last ? '（' + last + '）' : '');
      try { p.kill(); } catch {}
      // 和进程自己挂掉时一样：proc/ready 置空（下次用的时候自动重新拉起）、挂着的请求全部作废
      dead(why);
      throw new Error(why);
    });
  ready.catch(() => {});
  return ready;
}

function rpc(method, params) {
  if (!proc) return Promise.reject(new Error('opencode 没在运行'));
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
// 没有会话接着时，过 10 分钟把 opencode 进程关掉
function idleCheck() {
  clearTimeout(idleTimer);
  if (owners.size || !proc) return;
  idleTimer = setTimeout(() => { if (!owners.size && proc) { try { proc.stdin.end(); proc.kill(); } catch {} } }, 10 * 60 * 1000);
}
export function opShutdown() { try { proc?.stdin.end(); proc?.kill(); } catch {} }
export const opAcpRunning = () => !!proc;

// 可调选项（ACP configOptions）：model / effort / mode（build、plan）
const flatOptions = opt => (opt?.options || []).flatMap(o => o.options ? o.options : [o]);
const optName = (cfg, id) => {
  const o = cfg?.find(x => x.id === id);
  if (!o) return '';
  return flatOptions(o).find(x => x.value === o.currentValue)?.name || String(o.currentValue || '');
};
const CFG_IDS = { model: 'model', effort: 'effort', mode: 'mode' };
const CFG_NAMES = { model: '模型', effort: '思考强度', mode: '模式' };

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'effort', description: '思考强度（不带参数：列出可选项）', hint: '<强度>', builtin: true },
  { name: 'mode', description: 'build（直接动手）/ plan（只出方案，不改文件）', hint: '<模式>', builtin: true },
];

function toolLabel(name = '', kind = '') {
  if (kind === 'execute' || /bash|shell/i.test(name)) return '运行命令';
  if (kind === 'read' || /^read/i.test(name)) return '读文件';
  if (kind === 'edit' || /edit|write|patch/i.test(name)) return '改文件';
  if (kind === 'search' || /grep|glob|list|search/i.test(name)) return '查找中';
  if (kind === 'fetch' || /web|fetch/i.test(name)) return '查网页';
  if (/task/i.test(name)) return '派子任务';
  if (/todo/i.test(name)) return '列计划';
  return '用工具';
}

// ---------- 打开的 OpenCode 会话：接口和 Claude 的 Runner 对齐 ----------
export const opRunners = new Map();

// 等某个会话的关闭结束（没有在关就直接返回）
async function waitClosing(sid) {
  const p = closing.get(sid);
  if (!p) return;
  try { await p; } catch {}
}

export class OpRunner {
  constructor(id, { log, onActivity, onTurnDone, onAsk, info }) {
    this.id = id; this.sid = sidOf(id);
    this.log = log; this.onActivity = onActivity; this.onTurnDone = onTurnDone; this.onAsk = onAsk;
    this.info = { sessionId: id, cwd: info?.cwd || '' };
    this.cwd = info?.cwd || '';
    this.title = info?.title || '';
    this.model = '';
    this.mode = 'default'; this.allowedModes = ['default'];
    this.busy = false; this.busySince = 0;
    this.subs = new Set(); this.pending = new Map();
    this.suggestion = null; this.commands = COMMANDS;
    this.closed = false; this.attached = false; this.config = null;
    this.msgId = null; this.textOpen = false;
    this.queue = [];          // 回复中又发来的消息：这一轮结束（或被中断）后合成一条发出
    this.tools = new Map();   // toolCallId → { name, kind, started }
    this.cache = null;        // { key, items }：会话没改动就不重读
  }

  // 读库拿历史（{items, total}，和 Claude 的 loadHistory 一样，server 用同一套分页）
  history() {
    if (!validSid(this.sid)) return { items: [], total: 0 };
    const r = query(db => {
      const s = db.prepare('select directory, title, time_updated, model from session where id = ?').get(this.sid);
      if (!s) return null;
      if (this.cache?.key === s.time_updated) return { s, items: this.cache.items };
      const msgs = db.prepare('select id, data from message where session_id = ? order by time_created, id').all(this.sid);
      const parts = db.prepare('select message_id, data from part where session_id = ? order by time_created, id').all(this.sid);
      return { s, items: toItems(msgs, parts) };
    });
    if (!r) return { items: [], total: 0 };
    const { s, items } = r;
    this.cache = { key: s.time_updated, items };
    this.cwd = this.cwd || s.directory || ''; this.info.cwd = this.cwd;
    const firstUser = items.find(x => x.kind === 'user')?.text || '';
    this.title = (s.title && !DEFAULT_TITLE.test(s.title) ? s.title : oneLine(firstUser).slice(0, 60)) || this.title || 'OpenCode 会话';
    if (!this.model) this.model = modelOf(s.model);
    return { items, total: items.length };
  }
  metaLine() { return tilde(this.cwd || '') + (this.model ? ' · ' + this.model : ''); }

  // 第一次发消息时才接上 opencode
  async attach() {
    if (this.attached) return;
    await startAcp(this.log);
    clearTimeout(idleTimer);
    await waitClosing(this.sid);   // 上一次关闭还没关完就先等它，否则会互相踩 owners
    owners.set(this.sid, this);
    try {
      const r = await rpc('session/resume', { sessionId: this.sid, cwd: this.cwd || HOME, mcpServers: [] });
      this.setConfig(r?.configOptions);
      this.attached = true;
    } catch (e) {
      if (owners.get(this.sid) === this) owners.delete(this.sid);
      idleCheck();
      throw e;
    }
  }
  setConfig(cfg) {
    if (!Array.isArray(cfg)) return;
    this.config = cfg;
    const name = optName(cfg, 'model').replace(/^[^/]+\//, '');   // 「OpenCode/MiniMax …」只留模型名
    if (name && name !== this.model) { this.model = name; this.emit({ t: 'session.meta', cwdShort: this.metaLine() }); }
  }

  emit(ev) {
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
    switch (u.sessionUpdate) {
      case 'agent_message_chunk': {
        const t = u.content?.type === 'text' ? u.content.text : '';
        if (!t) return;
        if (!this.textOpen || (u.messageId && u.messageId !== this.msgId)) { this.closeText(); this.textOpen = true; this.msgId = u.messageId; this.lastText = ''; this.emit({ t: 'ai.start' }); }
        this.lastText += t;   // 这一轮最后一段回复：推送通知里显示开头
        this.emit({ t: 'ai.delta', text: t });
        this.onActivity?.(this.id, '回复中');
        return;
      }
      case 'agent_thought_chunk':
        this.onActivity?.(this.id, '思考中');
        return;
      case 'tool_call':
      case 'tool_call_update': {
        // opencode 先发一条只有工具名的 tool_call，参数在后面的 update 里：有了参数（或者已经结束）才显示卡片
        let t = this.tools.get(u.toolCallId);
        if (!t) { t = { name: u.title || 'tool', kind: u.kind || '', started: false }; this.tools.set(u.toolCallId, t); }
        const target = toolTarget(u.rawInput);
        const done = u.status === 'completed' || u.status === 'failed';
        if (!t.started && (target || done)) {
          t.started = true;
          this.closeText();
          this.emit({ t: 'tool.start', id: u.toolCallId, name: t.name, target });
          this.onActivity?.(this.id, toolLabel(t.name, u.kind || t.kind));
        }
        if (done && !t.finished) { t.finished = true; this.toolDone(u); }
        return;
      }
      case 'config_option_update':
        this.setConfig(u.configOptions);
        return;
    }
  }
  toolDone(u) {
    let out = (u.content || []).map(c => c.type === 'content' && c.content?.type === 'text' ? c.content.text : c.type === 'diff' ? '改了 ' + (c.path || '') : '').filter(Boolean).join('\n');
    if (!out && u.rawOutput) out = typeof u.rawOutput === 'string' ? u.rawOutput : String(u.rawOutput.output ?? u.rawOutput.error ?? '');
    this.emit({ t: 'tool.result', id: u.toolCallId, output: out.slice(0, 4000), isError: u.status === 'failed' });
  }

  // opencode 要确认的操作（权限设成 ask 的）：转成网页的确认条（和 Claude 的 perm.request 同一种）
  askPermission(rpcId, p) {
    const requestId = 'op-' + rpcId;
    const opts = p.options || [];
    const tc = p.toolCall || {};
    // opencode 的 title 往往就是整条命令：不能当标题用。按 Claude 会话的样子：标题「允许运行这条命令？」，命令全文放在下面（网页那块能滚动）
    const tool = this.tools.get(tc.toolCallId)?.name || '';
    const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : {};
    const isCmd = tc.kind === 'execute' || /^bash$/i.test(tool) || typeof raw.command === 'string';
    const isEdit = !isCmd && (tc.kind === 'edit' || /^(edit|write|patch|multiedit)$/i.test(tool));
    const name = isCmd ? 'Bash' : isEdit ? 'Edit' : (tool || '操作');
    const target = (isCmd && raw.command ? String(raw.command) : toolTarget(raw) || String(tc.title || '')).slice(0, 4000);
    // external_directory：要碰工作目录外的路径（opencode 默认对这个要确认）
    const cwd = this.cwd;
    const outside = [...(tc.locations || []).map(l => l?.path), raw.parentDir, raw.filepath, raw.filePath]
      .find(x => typeof x === 'string' && path.isAbsolute(x) && cwd && x !== cwd && !x.startsWith(cwd + '/'));
    const req = {
      t: 'perm.request', requestId, toolUseID: tc.toolCallId, name,
      title: null, displayName: name, description: '', target,
      reason: outside ? '涉及工作目录外：' + outside : '', canAlways: opts.some(o => o.kind === 'allow_always'), defaultToNo: false,
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
    if (this.busy) {
      // ACP 不支持插话：先排队。命令不排队（等这一轮结束再发），最多排 10 条
      if (/^\/(model|effort|mode)\b/.test(text) || this.queue.length >= 10) return false;
      this.queue.push({ text, images });
      return 'queued';
    }
    const cmd = text.match(/^\/(model|effort|mode)(?:\s+(.*))?$/);
    this.lastText = '';
    this.setBusy(true);
    (async () => {
      try {
        await this.attach();
        if (cmd) return this.finish(await this.command(cmd[1], (cmd[2] || '').trim()));
        if (images.length && !caps.promptCapabilities?.image) throw new Error('opencode 不支持发图片，只发文字吧');
        const prompt = [
          ...images.map(i => ({ type: 'image', mimeType: i.media_type, data: i.data })),
          ...(text ? [{ type: 'text', text }] : []),
        ];
        touch(this.sid);
        const r = await rpc('session/prompt', { sessionId: this.sid, prompt });
        this.finish({ reason: r?.stopReason || 'end_turn' });
      } catch (e) {
        this.finish({ error: e.message });
      }
    })();
    return true;
  }
  finish({ reason, error, text } = {}) {
    if (this.closed) return;
    touch(this.sid);
    this.closeText();
    this.tools.clear();
    if (text) this.emit({ t: 'ai.full', text });
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    const ok = !error && (reason === 'end_turn' || reason === 'command');
    const subtype = error ? 'error' : reason === 'cancelled' ? 'aborted' : ok ? 'success' : reason;
    if (error) this.emit({ t: 'error', message: error });
    this.busy = false;
    this.emit({ t: 'turn.done', subtype, error: error || (reason === 'cancelled' ? '已中断' : reason === 'max_tokens' ? '回复超出长度上限' : reason === 'refusal' ? '模型拒绝回答' : undefined) });
    this.onActivity?.(this.id, null);
    if (reason !== 'command') this.onTurnDone?.(this, ok, this.lastText);
    if (this.queue.length && this.sendQueued()) return;   // 中断后也照发：通常就是「停下，改做这个」
    if (!this.subs.size) this.dispose();
  }

  // 排队的消息：合成一条发出（中间空一行），图片按顺序带上
  sendQueued() {
    const q = this.queue.splice(0);
    const text = q.map(x => x.text).filter(Boolean).join('\n\n');
    const images = q.flatMap(x => x.images || []);
    if (!text && !images.length) return false;
    if (!this.send(text, images)) return false;
    this.emit({ t: 'queue.sent' });
    return true;
  }

  // /model、/effort、/mode：用 ACP 的 session/set_config_option
  async command(name, arg) {
    const opt = this.config?.find(o => o.id === CFG_IDS[name]);
    if (!opt) return { reason: 'command', text: '当前会话没有可调的' + CFG_NAMES[name] };
    const list = flatOptions(opt);
    const cur = list.find(o => o.value === opt.currentValue);
    if (!arg) return { reason: 'command', text: '当前：' + (cur?.name || opt.currentValue) + '\n\n可选：\n' + list.map(o => '- `' + (name === 'model' ? o.value : o.name) + '`' + (name === 'model' && o.name !== o.value ? ' ' + o.name : '') + (o.description ? ' ' + o.description : '')).join('\n') };
    const a = arg.toLowerCase();
    const hit = list.find(o => String(o.value).toLowerCase() === a || String(o.name).toLowerCase() === a)
      || list.filter(o => (o.name + ' ' + o.value).toLowerCase().includes(a)).sort((x, y) => String(x.value).length - String(y.value).length)[0];
    if (!hit) return { reason: 'command', text: '没有匹配「' + arg + '」的选项' };
    const r = await rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value: hit.value });
    this.setConfig(r?.configOptions);
    return { reason: 'command', text: '已切换为 ' + hit.name + '（下一条消息生效）' };
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
    opRunners.delete(this.id);
    if (this.attached) {
      this.attached = false;
      // 记下这次关闭：owners 只在「现在这个 owner 还是我」时才删，避免删掉新 runner 的登记
      const p = rpc('session/close', { sessionId: this.sid }).catch(() => {}).finally(() => {
        if (owners.get(this.sid) === this) owners.delete(this.sid);
        closing.delete(this.sid);
        idleCheck();
      });
      closing.set(this.sid, p);
    }
  }
}

// 新建：在某个目录里开一个新的 opencode 会话
export async function opNewSession(cwd, opts) {
  await startAcp(opts.log);
  clearTimeout(idleTimer);
  const r = await rpc('session/new', { cwd, mcpServers: [] });
  touch(r.sessionId);
  await waitClosing(r.sessionId);
  const id = OP_PREFIX + r.sessionId;
  const runner = new OpRunner(id, { ...opts, info: { cwd, title: '新会话' } });
  owners.set(r.sessionId, runner);
  runner.attached = true;
  runner.setConfig(r.configOptions);
  opRunners.set(id, runner);
  return runner;
}

// 删除：先 opencode export 存一份到 claclaw 回收站（能用 opencode import 找回），再 opencode session delete
const runBin = (args, ms) => new Promise((ok, fail) => {
  const bin = opBin();
  if (!bin) return fail(new Error('没找到 opencode 命令'));
  execFile(bin, args, { cwd: HOME, env: binEnv(), timeout: ms, maxBuffer: 256 * 1024 * 1024 }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out));
});
export async function opDelete(id, trashDir) {
  const sid = sidOf(id);
  if (!validSid(sid) || !opExists(id)) throw new Error('找不到这个会话');
  const json = await runBin(['export', sid], 60000);
  const start = json.indexOf('{');   // 前面可能有一行提示文字
  if (start < 0) throw new Error('导出失败，未删除');
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const file = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_opencode_' + sid + '.json');
  fs.writeFileSync(file, json.slice(start), { mode: 0o600 });
  await runBin(['session', 'delete', sid], 60000);
  return file;
}

// 改名：ACP 里没有改名，但 `opencode acp` 进程自己在 127.0.0.1 上开着 opencode 的 HTTP 接口，
// 用它的 PATCH /session/{id} 改标题（走 opencode 自己的逻辑，不直接写库）。端口默认 4096，被占了会换，所以按进程查。
let apiPort = { pid: 0, port: 0 };
async function acpApiPort() {
  if (proc && apiPort.pid === proc.pid) return apiPort.port;
  for (let i = 0; i < 20 && proc; i++) {
    let o = '';
    try { o = execFileSync('lsof', ['-a', '-p', String(proc.pid), '-iTCP', '-sTCP:LISTEN', '-n', '-P', '-Fn'], { encoding: 'utf8' }); } catch {}
    const m = o.match(/^n.*:(\d+)$/m);
    if (m) { apiPort = { pid: proc.pid, port: Number(m[1]) }; return apiPort.port; }
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('找不到 opencode 的本机接口');
}
export async function opRename(id, title, log) {
  const sid = sidOf(id);
  const dir = validSid(sid) && query(db => db.prepare('select directory from session where id = ?').get(sid))?.directory;
  if (!dir) throw new Error('找不到这个会话');
  await startAcp(log);
  const port = await acpApiPort();
  const headers = { 'content-type': 'application/json' };
  if (process.env.OPENCODE_SERVER_PASSWORD) headers.authorization = 'Basic ' + Buffer.from((process.env.OPENCODE_SERVER_USERNAME || 'opencode') + ':' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/session/${sid}?directory=${encodeURIComponent(dir)}`,
      { method: 'PATCH', headers, body: JSON.stringify({ title }), signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + (await r.text()).slice(0, 200));
  } finally { idleCheck(); }   // 只为改名起的进程：没会话接着就照常 10 分钟后关
}
