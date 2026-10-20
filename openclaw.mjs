// OpenClaw 适配：通过本机 OpenClaw Gateway（WebSocket，默认 127.0.0.1:18789）读会话、看历史、发消息。
// 以本机后端身份（gateway-client / backend）用共享令牌连接；令牌只在服务端从 ~/.openclaw/openclaw.json 读，不发给网页。
// 网页里 OpenClaw 会话的 id = 'oc:' + sessionKey（例如 oc:agent:main:main），和 Claude 会话的 UUID 区分开。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const CFG = path.join(os.homedir(), '.openclaw', 'openclaw.json');
export const OC_PREFIX = 'oc:';
export const isOc = id => typeof id === 'string' && id.startsWith(OC_PREFIX);
const keyOf = id => id.slice(OC_PREFIX.length);

function config() {
  try {
    const c = JSON.parse(fs.readFileSync(CFG, 'utf8'));
    return { port: c.gateway?.port || 18789, token: c.gateway?.auth?.token || '' };
  } catch { return null; }
}

// ---------- Gateway 连接（单例，断了下次用时再连） ----------
let ws = null, ready = null, n = 0;
const pending = new Map();
const listeners = new Set();   // (event, payload) => void

function connect(log) {
  if (ready) return ready;
  const cfg = config();
  if (!cfg) return Promise.reject(new Error('没找到 OpenClaw 配置'));
  ready = new Promise((resolve, reject) => {
    const sock = new WebSocket('ws://127.0.0.1:' + cfg.port);
    const fail = e => { if (ws === sock) { ws = null; ready = null; } for (const p of pending.values()) p.rej(e); pending.clear(); reject(e); };
    const timer = setTimeout(() => { fail(new Error('连接 OpenClaw Gateway 超时')); try { sock.terminate(); } catch {} }, 8000);
    ws = sock;
    sock.on('error', e => { clearTimeout(timer); fail(new Error('连不上 OpenClaw Gateway（' + (e.code || e.message) + '），先在电脑上启动 OpenClaw')); });
    sock.on('close', () => { clearTimeout(timer); fail(new Error('OpenClaw Gateway 连接已断开')); });
    sock.on('message', raw => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.type === 'res') {
        const p = pending.get(m.id); if (!p) return;
        pending.delete(m.id);
        m.ok ? p.res(m.payload) : p.rej(new Error(m.error?.message || m.error?.code || 'OpenClaw 请求失败'));
      } else if (m.type === 'event') {
        if (m.event === 'connect.challenge') {
          rawCall(sock, 'connect', {
            minProtocol: 4, maxProtocol: 4,
            client: { id: 'gateway-client', version: '0.1', platform: process.platform === 'darwin' ? 'macos' : process.platform, mode: 'backend' },
            role: 'operator', scopes: ['operator.read', 'operator.write'], caps: [], commands: [], permissions: {},
            auth: { token: cfg.token }, locale: 'zh-CN', userAgent: 'claclaw/0.1',
          }).then(() => { clearTimeout(timer); log?.('openclaw connected'); resolve(sock); },
                  e => { clearTimeout(timer); fail(new Error('OpenClaw 认证失败：' + e.message)); try { sock.close(); } catch {} });
          return;
        }
        for (const f of listeners) { try { f(m.event, m.payload || {}); } catch {} }
      }
    });
  });
  return ready;
}

function rawCall(sock, method, params) {
  return new Promise((res, rej) => {
    const id = 'c' + (++n);
    pending.set(id, { res, rej });
    sock.send(JSON.stringify({ type: 'req', id, method, params }));
  });
}
export async function call(method, params, log) { return rawCall(await connect(log), method, params); }

// ---------- 会话列表 ----------
export async function ocSessionList(log) {
  const r = await call('sessions.list', { limit: 200 }, log);
  return (r.sessions || []).filter(s => !s.archived).map(s => ({
    id: OC_PREFIX + s.key,
    title: s.displayName || s.label || s.derivedTitle || (s.isMain ? '主会话' : s.key),
    cwd: 'OpenClaw · ' + (s.agentId || 'main'),
    cwdShort: 'OpenClaw · ' + (s.agentId || 'main'),
    branch: [s.modelProvider, s.model].filter(Boolean).join('/'),
    lastModified: s.updatedAt || s.lastInteractionAt || 0,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'openclaw', busy: !!s.hasActiveRun,
  })).sort((a, b) => b.lastModified - a.lastModified);
}

let cmdCache = null;
async function ocCommands(log) {
  if (cmdCache) return cmdCache;
  try {
    const r = await call('commands.list', { scope: 'text', includeArgs: false }, log);
    const seen = new Set();
    cmdCache = (r.commands || []).filter(c => c.name && !seen.has(c.name) && seen.add(c.name))
      .map(c => ({ name: c.name, description: c.description || '', hint: '', builtin: c.source === 'native' }));
  } catch (e) { log?.('openclaw commands.list failed', e.message); return []; }
  return cmdCache;
}

// ---------- 消息 → 网页的条目（和 Claude 会话的历史同一套格式） ----------
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
const cleanAi = t => String(t || '').replace(/\[\[reply_to:[^\]]*\]\]/g, '').trim();
const toolTarget = (name, a) => {
  if (!a || typeof a !== 'object') return '';
  const v = a.command ?? a.path ?? a.file ?? a.url ?? a.query ?? a.action ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
};

function toItems(msgs) {
  const items = [], toolIdx = new Map();
  for (const m of msgs) {
    if (m.role === 'user') {
      const t = textOf(m.content).trim();
      if (t) items.push({ kind: 'user', text: t });
    } else if (m.role === 'assistant') {
      for (const b of Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }]) {
        if (b.type === 'text' && cleanAi(b.text) && !/^Audio reply$/.test(cleanAi(b.text))) items.push({ kind: 'ai', text: cleanAi(b.text) });
        else if (b.type === 'toolCall') {
          toolIdx.set(b.id, items.length);
          items.push({ kind: 'tool', id: b.id, name: b.name, target: toolTarget(b.name, b.arguments), status: 'ok' });
        }
      }
    } else if (m.role === 'toolResult' && toolIdx.has(m.toolCallId)) {
      const it = items[toolIdx.get(m.toolCallId)];
      it.status = m.isError ? 'no' : 'ok';
      it.output = textOf(m.content).slice(0, 4000);
    }
  }
  return items;
}

// ---------- 打开的 OpenClaw 会话：接口和 Claude 的 Runner 对齐，server.mjs 不用分两套写 ----------
export const ocRunners = new Map();

export class OcRunner {
  constructor(id, { log, onActivity, onTurnDone }) {
    this.id = id; this.key = keyOf(id);
    this.log = log; this.onActivity = onActivity; this.onTurnDone = onTurnDone;
    this.info = { sessionId: id, cwd: '' };
    this.mode = 'default'; this.allowedModes = ['default'];
    this.busy = false; this.busySince = 0;
    this.subs = new Set(); this.pending = new Map();
    this.suggestion = null; this.commands = null;
    this.closed = false; this.myRuns = new Set();
    this.textOpen = false; this.streamText = '';
    this.onEvent = (ev, p) => this.handle(ev, p);
    listeners.add(this.onEvent);
  }

  async open() {
    await call('sessions.messages.subscribe', { key: this.key }, this.log).catch(e => this.log?.('openclaw subscribe failed', e.message));
    const h = await call('chat.history', { sessionKey: this.key, limit: 60 }, this.log);
    this.total = h.totalMessages || 0;
    this.nextOffset = h.nextOffset;
    this.title = h.sessionInfo?.displayName || h.sessionInfo?.label || (h.sessionInfo?.isMain ? '主会话' : this.key);
    this.model = [h.sessionInfo?.modelProvider, h.sessionInfo?.model].filter(Boolean).join('/');
    // 斜杠命令（/model、/status……）：网关自己的命令清单，取一次缓存起来
    this.commands = await ocCommands(this.log);
    const run = !!h.sessionInfo?.hasActiveRun;
    if (run && !this.busy) { this.busy = true; this.busySince = Date.now(); }
    return { items: toItems(h.messages || []), more: !!h.hasMore };
  }

  async more() {
    if (this.nextOffset == null) return { items: [], more: false };
    const h = await call('chat.history', { sessionKey: this.key, limit: 60, offset: this.nextOffset }, this.log);
    this.nextOffset = h.hasMore ? h.nextOffset : null;
    return { items: toItems(h.messages || []), more: !!h.hasMore };
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

  handle(ev, p) {
    if (this.closed || p.sessionKey !== this.key) return;
    if (ev === 'chat') {
      if (p.state === 'status') { this.setBusy(true); return; }
      if (p.state === 'delta') {
        this.setBusy(true);
        if (!this.textOpen) { this.textOpen = true; this.streamText = ''; this.emit({ t: 'ai.start' }); this.onActivity?.(this.id, '回复中'); }
        if (p.replace) { this.emit({ t: 'ai.end' }); this.emit({ t: 'ai.start' }); this.streamText = ''; }
        const d = p.deltaText ?? '';
        if (d) { this.streamText += d; this.emit({ t: 'ai.delta', text: d }); }
        return;
      }
      if (p.state === 'final' || p.state === 'error' || p.state === 'aborted') {
        const finalText = cleanAi(textOf(p.message?.content ?? p.message));
        if (this.textOpen) { this.textOpen = false; this.emit({ t: 'ai.end' }); }
        else if (finalText) this.emit({ t: 'ai.full', text: finalText });
        const err = p.state === 'error' ? (p.errorMessage || '出错了') : p.state === 'aborted' ? '已中断' : undefined;
        this.busy = false;
        this.emit({ t: 'turn.done', subtype: p.state === 'final' ? 'success' : p.state, error: err });
        this.onActivity?.(this.id, null);
        this.onTurnDone?.(this, p.state === 'final');
        this.refreshMeta();
        if (!this.subs.size) this.dispose();
      }
    } else if (ev === 'agent' && p.stream === 'run_status' && p.data?.phase === 'retrying') {
      this.emit({ t: 'status', text: '模型暂不可用，重试 ' + (p.data.retryAttempt || '') + '/' + (p.data.maxRetries || '') });
    } else if (ev === 'agent' && p.stream === 'tool') {
      const d = p.data || {};
      if (d.phase === 'start') { this.emit({ t: 'tool.start', id: d.toolCallId, name: d.name, target: toolTarget(d.name, d.args) }); this.onActivity?.(this.id, '运行命令'); }
      else if (d.phase === 'result' || d.phase === 'end') this.emit({ t: 'tool.result', id: d.toolCallId, output: textOf(d.result?.content ?? d.result).slice(0, 4000), isError: !!d.isError });
    } else if (ev === 'session.message') {
      // 别处（Telegram、OpenClaw 自己的界面）发进来的用户消息也显示出来；我们自己发的已经显示过了
      const m = p.message || {};
      if (m.role !== 'user') return;
      const run = String(m.idempotencyKey || '').replace(/:user$/, '');
      if (this.myRuns.has(run)) return;
      const t = textOf(m.content).trim();
      if (t) this.emit({ t: 'user', text: t });
    }
  }

  // 一轮结束后看看模型有没有换（比如发了 /model），换了就更新标题栏
  async refreshMeta() {
    try {
      const h = await call('chat.history', { sessionKey: this.key, limit: 1 }, this.log);
      const model = [h.sessionInfo?.modelProvider, h.sessionInfo?.model].filter(Boolean).join('/');
      if (model && model !== this.model) { this.model = model; this.emit({ t: 'session.meta', cwdShort: 'OpenClaw · ' + model }); }
    } catch {}
  }

  send(text, images = []) {
    const idem = crypto.randomUUID();
    this.myRuns.add(idem);
    this.setBusy(true);
    const params = { sessionKey: this.key, message: text, deliver: false, idempotencyKey: idem };
    // OpenClaw 收 base64 附件；模型不支持看图时它会把图存成文件、在消息里留引用
    if (images.length) params.attachments = images.map((i, n) => ({
      type: 'image', mimeType: i.media_type, fileName: 'image-' + (n + 1) + '.' + (i.media_type.split('/')[1] || 'png').replace('jpeg', 'jpg'), content: i.data,
    }));
    call('chat.send', params, this.log)
      .catch(e => { this.busy = false; this.emit({ t: 'error', message: '发送到 OpenClaw 失败：' + e.message }); this.emit({ t: 'turn.done', subtype: 'error', error: e.message }); });
    return true;
  }

  async interrupt() {
    try { await call('chat.abort', { sessionKey: this.key }, this.log); } catch (e) { this.log?.('openclaw abort failed', e.message); }
    this.emit({ t: 'sys', text: '已中断' });
  }
  async setMode() {}
  replyPermission() {}

  subscribe(w) { this.subs.add(w); }
  unsubscribe(w) { this.subs.delete(w); if (!this.subs.size && !this.busy) this.dispose(); }
  watched() { return [...this.subs].some(w => w.visible !== false); }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    listeners.delete(this.onEvent);
    ocRunners.delete(this.id);
    call('sessions.messages.unsubscribe', { key: this.key }).catch(() => {});
  }
}

// ---------- 改名、删除 ----------
// 改名 = 设置会话的 label。删除：普通操作员权限只能删已归档的会话，所以先归档再删（和 OpenClaw 界面的「归档后删除」一样）
export async function ocRename(id, title, log) {
  await call('sessions.patch', { key: keyOf(id), label: title }, log);
}
export async function ocDelete(id, log) {
  const key = keyOf(id);
  // 归档要带上当前的 sessionId（防止删到刚被重置/替换的会话）
  const r = await call('sessions.list', { limit: 500 }, log);
  const row = (r.sessions || []).find(s => s.key === key);
  if (!row) throw new Error('找不到这个会话');
  if (!row.archived) await call('sessions.patch', { key, archived: true, expectedSessionId: row.sessionId }, log);
  await call('sessions.delete', { key, archivedOnly: true }, log);
}

// 网关连得上吗（宿主页用；最多等 2 秒）
export async function ocGatewayUp(log) {
  if (!config()) return false;
  try { await Promise.race([connect(log), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000))]); return true; }
  catch { return false; }
}

// 新建：在 main 这个 agent 下建一个会话；名字可以不填（OpenClaw 会按第一条消息起名）
export async function ocCreate(title, log) {
  const params = { agentId: 'main' };   // 不带 idempotencyKey：网关要求设备身份才收，我们是共享令牌连接
  if (title) params.label = title;
  const r = await call('sessions.create', params, log);
  if (!r?.key) throw new Error('OpenClaw 没有返回会话');
  return OC_PREFIX + r.key;
}
