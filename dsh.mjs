// DeepSeek Harness（dsh）适配。
// - 会话列表和历史：直接读 ~/.dsh/sessions/<目录>/<id>/session.v3.jsonl.zstd（追加写的多段 zstd + JSONL），和读 Claude 会话文件一个思路。
// - 发消息：claclaw 自己起一个 `dsh --profile acp`（ACP 标准协议，stdin/stdout 一行一条 JSON-RPC），
//   用 session/resume 接上已有会话、session/prompt 发消息；不依赖 dsh 网页版（3080）开着。
// 网页里 DeepSeek 会话的 id = 'ds:' + dsh 会话 id，和 Claude 的 UUID、OpenClaw 的 oc: 区分开。
// 注意：同一个会话同时只能有一个写入方。dsh 网页版开着这个会话时这里接不上（反过来也一样），所以空闲就关掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';

const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const ROOT = path.join(DSH_HOME, 'sessions');
const ATTACH = path.join(DSH_HOME, 'attachments', 'v1', 'objects');
const LOG_NAME = 'session.v3.jsonl.zstd';
export const DS_PREFIX = 'ds:';
export const isDs = id => typeof id === 'string' && id.startsWith(DS_PREFIX);
const sidOf = id => id.slice(DS_PREFIX.length);
const tilde = p => p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p;

// ---------- 读会话文件 ----------
// 文件是一段段独立的 zstd 帧接在一起；Node 的 zstd 只解第一帧，所以按帧头（魔数）切开逐帧解。
// 魔数也可能碰巧出现在压缩数据里：切出来解不开就往后找下一个魔数再试。
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
function unzstdAll(b) {
  const out = [];
  let pos = 0;
  while (pos < b.length && b.indexOf(MAGIC, pos) === pos) {
    let from = pos + 4, done = false;
    for (;;) {
      const nx = b.indexOf(MAGIC, from), stop = nx < 0 ? b.length : nx;
      try { out.push(zlib.zstdDecompressSync(b.subarray(pos, stop))); pos = stop; done = true; break; }
      catch { if (nx < 0) break; from = nx + 1; }
    }
    if (!done) break;   // 末尾正在写的半帧：先不要
  }
  return Buffer.concat(out).toString('utf8');
}

const recCache = new Map();   // file → { key, recs }
function readRecords(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  const key = st.mtimeMs + ':' + st.size;
  const c = recCache.get(file);
  if (c && c.key === key) return c.recs;
  const recs = [];
  for (const line of unzstdAll(fs.readFileSync(file)).split('\n')) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch {}
  }
  recCache.set(file, { key, recs, mtime: st.mtimeMs });
  return recs;
}

// 所有会话文件：id → 文件路径
function scan() {
  const map = new Map();
  let groups = [];
  try { groups = fs.readdirSync(ROOT); } catch { return map; }
  for (const g of groups) {
    let ds = [];
    try { ds = fs.readdirSync(path.join(ROOT, g)); } catch { continue; }
    for (const d of ds) {
      const f = path.join(ROOT, g, d, LOG_NAME);
      if (fs.existsSync(f)) map.set(d, f);
    }
  }
  return map;
}
function fileOf(sid) {
  if (sid.includes('/') || sid.includes('..')) return null;
  return scan().get(sid) || null;
}

const userText = m => (m.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n').trim();

function summarize(recs) {
  const head = recs[0]?.type === 'session' ? recs[0] : {};
  let title = '', model = '', firstPrompt = '', hasUser = false;
  for (const r of recs) {
    if (r.type === 'session/title' && r.data?.title) title = r.data.title;
    else if (r.type === 'request/header' && r.data?.header?.config?.model) model = r.data.header.config.model;
    else if (r.type === 'user/message' && r.data?.source?.kind === 'user') { hasUser = true; if (!firstPrompt) firstPrompt = userText(r.data); }
  }
  return { id: head.id, cwd: head.cwd || '', createdAt: head.createdAt || 0, sub: head.origin === 'subagent' || !!head.parentSession, title, model, firstPrompt, hasUser };
}

export function dsSessionList({ busy = () => false } = {}) {
  const out = [];
  for (const [sid, f] of scan()) {
    const recs = readRecords(f);
    if (!recs) continue;
    const s = summarize(recs);
    if (s.sub) continue;   // 子代理会话不列；刚新建、还没发过消息的也要列（不然新建完离开就找不到了）
    out.push({
      id: DS_PREFIX + sid,
      title: s.title || s.firstPrompt.slice(0, 60) || (s.hasUser ? '(无标题)' : '新会话'),
      cwd: s.cwd, cwdShort: tilde(s.cwd), branch: s.model,
      lastModified: recCache.get(f)?.mtime || s.createdAt,
      openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
      claw: 'deepseek', busy: busy(DS_PREFIX + sid),
    });
  }
  return out.sort((a, b) => b.lastModified - a.lastModified);
}

// ---------- 记录 → 网页条目（和 Claude 历史同一套格式；图片给 {media_type, data}，由 server 的分页按预算转成 data URL） ----------
const toolTarget = a => {
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return a.slice(0, 160); } }
  if (!a || typeof a !== 'object') return '';
  const v = a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
};
const resultText = content => (content || []).map(c => c.type === 'tool-result'
  ? (c.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')
  : c.type === 'text' ? c.text : '').join('\n');

function readImage(att) {
  const hex = String(att?.attachmentId || '').replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) return null;
  try { return { media_type: att.mediaType || 'image/png', data: fs.readFileSync(path.join(ATTACH, hex.slice(0, 2), hex)).toString('base64') }; }
  catch { return null; }
}

function toItems(recs) {
  const items = [], toolIdx = new Map();
  for (const r of recs) {
    const d = r.data || {};
    if (r.type === 'user/message' && d.source?.kind === 'user') {
      const imgs = (d.content || []).filter(c => c.type === 'image').map(c => readImage(c.attachment)).filter(Boolean);
      const t = userText(d);
      if (t || imgs.length) items.push({ kind: 'user', text: t, images: imgs.length ? imgs : undefined });
    } else if (r.type === 'assistant/message') {
      for (const b of d.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'ai', text: b.text.trim() });
        else if (b.type === 'tool-call') {
          toolIdx.set(b.id, items.length);
          items.push({ kind: 'tool', id: b.id, name: b.name, target: toolTarget(b.arguments), status: 'ok' });
        }
      }
    } else if (r.type === 'tool/result') {
      for (const c of d.message?.content || []) {
        if (c.type !== 'tool-result' || !toolIdx.has(c.toolCallId)) continue;
        const it = items[toolIdx.get(c.toolCallId)];
        it.status = c.isError ? 'no' : 'ok';
        it.output = resultText([c]).slice(0, 4000);
      }
    } else if (r.type === 'command/run' && d.source?.kind === 'user') {
      items.push({ kind: 'user', text: '/' + d.name + (d.args ? ' ' + d.args.trim() : '') });
    } else if (r.type === 'command/done' && d.text) {
      items.push({ kind: 'ai', text: d.text });
    }
  }
  return items;
}

// ---------- ACP 进程（单例，多个会话共用；挂了下次用时再起） ----------
function dshBin() {
  const dirs = new Set([...(process.env.PATH || '').split(':'), '/usr/local/bin', '/opt/homebrew/bin', path.join(HOME, '.local', 'bin')]);
  for (const d of dirs) {
    const p = d && path.join(d, 'dsh');
    if (p && fs.existsSync(p)) { try { return fs.realpathSync(p); } catch { return p; } }
  }
  return null;
}

let proc = null, ready = null, rid = 0, idleTimer = null, caps = {};
const pending = new Map();
const owners = new Map();   // dsh 会话 id → DsRunner（收 session/update 和权限请求）

function startAcp(log) {
  if (ready) return ready;
  const bin = dshBin();
  if (!bin) return Promise.reject(new Error('没找到 dsh 命令，先装好 DeepSeek Harness'));
  // bin.js 是 node 脚本：直接用当前 node 跑，不依赖 launchd 环境里的 PATH
  const p = spawn(/\.m?js$/.test(bin) ? process.execPath : bin, /\.m?js$/.test(bin) ? [bin, '--profile', 'acp'] : ['--profile', 'acp'],
    { stdio: ['pipe', 'pipe', 'pipe'], cwd: HOME, env: { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') } });
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
        m.error ? q.rej(new Error(m.error.data?.details || m.error.message || 'dsh 请求失败')) : q.res(m.result);
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
  p.on('error', e => dead('dsh 启动失败：' + e.message));
  p.on('exit', code => { log?.('dsh acp exited', code, errTail.trim().split('\n').pop() || ''); dead('dsh 进程退出了（' + code + '）'); });
  log?.('dsh acp starting', bin);
  ready = rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claclaw', version: '0.1' } })
    .then(r => { caps = r?.agentCapabilities || {}; log?.('dsh acp ready'); return p; });
  ready.catch(() => {});
  return ready;
}

function rpc(method, params) {
  if (!proc) return Promise.reject(new Error('dsh 没在运行'));
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
// 没有会话接着时，过 10 分钟把 dsh 进程关掉
function idleCheck() {
  clearTimeout(idleTimer);
  if (owners.size || !proc) return;
  idleTimer = setTimeout(() => { if (!owners.size && proc) { try { proc.stdin.end(); } catch {} } }, 10 * 60 * 1000);
}
export function dsShutdown() { try { proc?.stdin.end(); } catch {} }

// 模型选项：value 是 JSON 字符串 ["provider","model"]
const flatOptions = opt => (opt?.options || []).flatMap(o => o.options ? o.options : [o]);
const modelName = (cfg) => {
  const m = cfg?.find(o => o.id === 'model');
  if (!m) return '';
  const hit = flatOptions(m).find(o => o.value === m.currentValue);
  if (hit) return hit.name;
  try { return JSON.parse(m.currentValue)[1]; } catch { return m.currentValue || ''; }
};

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'effort', description: '思考强度：off / low / high / max', hint: '<强度>', builtin: true },
];

// ---------- 打开的 DeepSeek 会话：接口和 Claude 的 Runner 对齐 ----------
export const dsRunners = new Map();

export class DsRunner {
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
  }

  // 读文件拿历史（{items, total}，和 Claude 的 loadHistory 一样，server 用同一套分页）
  history() {
    const f = fileOf(this.sid);
    if (!f) return { items: [], total: 0 };
    const recs = readRecords(f) || [];
    const s = summarize(recs);
    this.cwd = this.cwd || s.cwd; this.info.cwd = this.cwd;
    this.title = s.title || s.firstPrompt.slice(0, 60) || this.title || 'DeepSeek 会话';
    if (!this.model && s.model) this.model = s.model;
    const items = toItems(recs);
    return { items, total: items.length };
  }
  metaLine() { return tilde(this.cwd || '') + (this.model ? ' · ' + this.model : ''); }

  // 第一次发消息时才接上 dsh（接上就占了写入权，dsh 网页版那边就打不开这个会话了）
  async attach() {
    if (this.attached) return;
    await startAcp(this.log);
    clearTimeout(idleTimer);
    owners.set(this.sid, this);
    try {
      const r = await rpc('session/resume', { sessionId: this.sid, cwd: this.cwd, mcpServers: [] });
      this.setConfig(r?.configOptions);
      this.attached = true;
    } catch (e) {
      owners.delete(this.sid); idleCheck();
      if (/already owned|write handle/i.test(e.message)) throw new Error('这个会话正在 DeepSeek Harness 别处打开着（比如 dsh 网页版），先在那边关掉再试');
      throw e;
    }
  }
  setConfig(cfg) {
    if (!Array.isArray(cfg)) return;
    this.config = cfg;
    const name = modelName(cfg);
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
        if (!this.textOpen || u.messageId !== this.msgId) { this.closeText(); this.textOpen = true; this.msgId = u.messageId; this.lastText = ''; this.emit({ t: 'ai.start' }); }
        this.lastText += t;   // 这一轮最后一段回复：推送通知里显示开头
        this.emit({ t: 'ai.delta', text: t });
        this.onActivity?.(this.id, '回复中');
        return;
      }
      case 'agent_thought_chunk':
        this.onActivity?.(this.id, '思考中');
        return;
      case 'tool_call':
        this.closeText();
        this.emit({ t: 'tool.start', id: u.toolCallId, name: u.title || 'tool', target: toolTarget(u.rawInput) });
        this.onActivity?.(this.id, toolLabel(u.title));
        if (u.status === 'completed' || u.status === 'failed') this.toolDone(u);
        return;
      case 'tool_call_update':
        if (u.status === 'completed' || u.status === 'failed') this.toolDone(u);
        return;
      case 'config_option_update':
        this.setConfig(u.configOptions);
        return;
    }
  }
  toolDone(u) {
    const out = (u.content || []).map(c => c.type === 'content' && c.content?.type === 'text' ? c.content.text : '').join('\n');
    this.emit({ t: 'tool.result', id: u.toolCallId, output: out.slice(0, 4000), isError: u.status === 'failed' });
  }

  // dsh 要确认的操作：转成网页的确认条（和 Claude 的 perm.request 同一种）
  askPermission(rpcId, p) {
    const requestId = 'ds-' + rpcId;
    const opts = p.options || [];
    const tc = p.toolCall || {};
    const req = {
      t: 'perm.request', requestId, toolUseID: tc.toolCallId, name: tc.title || '操作',
      title: null, displayName: tc.title || '操作', description: '', target: toolTarget(tc.rawInput),
      reason: '', canAlways: opts.some(o => o.kind === 'allow_always'), defaultToNo: false,
    };
    this.pending.set(requestId, { rpcId, opts, req });
    this.emit(req);
    this.onAsk?.(this, '等你确认：' + req.displayName);
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
    if (this.busy) return false;
    const cmd = text.match(/^\/(model|effort)(?:\s+(.*))?$/);
    this.lastText = '';
    this.setBusy(true);
    (async () => {
      try {
        await this.attach();
        if (cmd) return this.finish(await this.command(cmd[1], (cmd[2] || '').trim()));
        if (images.length && !caps.promptCapabilities?.image) throw new Error('当前 DeepSeek 模型不支持图片，只发文字吧');
        const prompt = [
          ...images.map(i => ({ type: 'image', mimeType: i.media_type, data: i.data })),
          ...(text ? [{ type: 'text', text }] : []),
        ];
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
    this.closeText();
    if (text) this.emit({ t: 'ai.full', text });
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    const ok = !error && (reason === 'end_turn' || reason === 'command');
    const subtype = error ? 'error' : reason === 'cancelled' ? 'aborted' : ok ? 'success' : reason;
    if (error) this.emit({ t: 'error', message: error });
    this.busy = false;
    this.emit({ t: 'turn.done', subtype, error: error || (reason === 'cancelled' ? '已中断' : reason === 'max_tokens' ? '回复超出长度上限' : reason === 'refusal' ? '模型拒绝回答' : undefined) });
    this.onActivity?.(this.id, null);
    if (reason !== 'command') this.onTurnDone?.(this, ok, this.lastText);
    if (!this.subs.size) this.dispose();
  }

  // /model、/effort：用 ACP 的 session/set_config_option
  async command(name, arg) {
    const id = name === 'model' ? 'model' : 'reasoning_effort';
    const opt = this.config?.find(o => o.id === id);
    if (!opt) return { reason: 'command', text: '当前会话没有可调的' + (name === 'model' ? '模型' : '思考强度') };
    const list = flatOptions(opt);
    const cur = list.find(o => o.value === opt.currentValue);
    if (!arg) return { reason: 'command', text: '当前：' + (cur?.name || opt.currentValue) + '\n\n可选：\n' + list.map(o => '- `' + (name === 'model' ? o.name : o.value) + '`' + (o.description ? ' ' + o.description : '')).join('\n') };
    const a = arg.toLowerCase();
    const hit = list.find(o => o.value.toLowerCase() === a || o.name.toLowerCase() === a)
      || list.filter(o => (o.name + ' ' + o.value).toLowerCase().includes(a)).sort((x, y) => x.name.length - y.name.length)[0];
    if (!hit) return { reason: 'command', text: '没有匹配「' + arg + '」的选项' };
    const r = await rpc('session/set_config_option', { sessionId: this.sid, configId: id, value: hit.value });
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
    dsRunners.delete(this.id);
    if (this.attached) {
      this.attached = false;
      rpc('session/close', { sessionId: this.sid }).catch(() => {}).finally(() => { owners.delete(this.sid); idleCheck(); });
    }
  }
}

// 新建：在某个目录里开一个新的 dsh 会话
export async function dsNewSession(cwd, opts) {
  await startAcp(opts.log);
  clearTimeout(idleTimer);
  const r = await rpc('session/new', { cwd, mcpServers: [] });
  const id = DS_PREFIX + r.sessionId;
  const runner = new DsRunner(id, { ...opts, info: { cwd, title: '新会话' } });
  owners.set(r.sessionId, runner);
  runner.attached = true;
  runner.setConfig(r.configOptions);
  dsRunners.set(id, runner);
  return runner;
}

function toolLabel(name = '') {
  if (/bash|pwsh|shell/i.test(name)) return '运行命令';
  if (/^read/i.test(name)) return '读文件';
  if (/edit|write|replace/i.test(name)) return '改文件';
  if (/grep|glob|search|find/i.test(name)) return '查找中';
  if (/web|fetch/i.test(name)) return '查网页';
  if (/subagent/i.test(name)) return '派子任务';
  if (/todo/i.test(name)) return '列计划';
  return '用工具';
}

// 会话目录（删除时整个挪走）
export const dsExists = id => isDs(id) && !!fileOf(sidOf(id));
export function dsSessionDir(id) {
  const f = isDs(id) ? fileOf(sidOf(id)) : null;
  return f ? path.dirname(f) : null;
}

// dsh 的 ACP 进程在不在跑（宿主页用）
export const dsAcpRunning = () => !!proc;
