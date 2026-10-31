// ACP（Agent Client Protocol）共用底座：DeepSeek（dsh）、OpenCode、Kimi 都走它。
// - AcpAgent：一个 agent 程序的 ACP 进程（单例，多个会话共用；挂了下次用时再起；没会话接着 10 分钟后关）
//   stdin/stdout 一行一条 JSON-RPC。收到的 session/update、权限请求按 sessionId 交给对应的 runner。
// - AcpRunner：网页里打开的一个会话（接口和 Claude 的 Runner 对齐：send / interrupt / replyPermission / subscribe …）。
//   各家只写差异：怎么接上会话、历史从哪读、模型名怎么显示、上下文大小从哪来、确认条怎么显示。
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { storeNow, splitGroups } from './modelpick.mjs';

export const HOME = os.homedir();
export const tilde = p => p === HOME ? '~' : String(p || '').startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : String(p || '');
export const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();
export const binEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') });
export const flatOptions = opt => (opt?.options || []).flatMap(o => o.options ? o.options : [o]);
export const optName = (cfg, id) => {
  const o = cfg?.find(x => x.id === id);
  if (!o) return '';
  return flatOptions(o).find(x => x.value === o.currentValue)?.name || String(o.currentValue || '');
};

// 工具卡片上的一句话：命令 / 文件 / 搜索词 / 网址 …
export const toolTarget = a => {
  if (typeof a === 'string') { try { a = JSON.parse(a); } catch { return a.slice(0, 160); } }
  if (!a || typeof a !== 'object') return '';
  const v = a.command ?? a.cmd ?? a.filePath ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '';
  return String(v).replace(/\s+/g, ' ').slice(0, 160);
};
// 「正在做什么」（会话列表 / 通知里的状态）
export function toolLabel(name = '', kind = '') {
  if (kind === 'execute' || /bash|pwsh|shell/i.test(name)) return '运行命令';
  if (kind === 'read' || /^read/i.test(name)) return '读文件';
  if (kind === 'edit' || /edit|write|patch|replace/i.test(name)) return '改文件';
  if (kind === 'search' || /grep|glob|list|search|find/i.test(name)) return '查找中';
  if (kind === 'fetch' || /web|fetch/i.test(name)) return '查网页';
  if (/task|agent/i.test(name)) return '派子任务';
  if (/todo/i.test(name)) return '列计划';
  return '用工具';
}
// 工具结束时的输出：文本内容；改文件给「改了 路径」；都没有时看 rawOutput
export const toolOutput = u => {
  let out = (u.content || []).map(c => c.type === 'content' && c.content?.type === 'text' ? c.content.text : c.type === 'diff' ? '改了 ' + (c.path || '') : '').filter(Boolean).join('\n');
  if (!out && u.rawOutput) out = typeof u.rawOutput === 'string' ? u.rawOutput : String(u.rawOutput.output ?? u.rawOutput.error ?? u.rawOutput.stdout ?? '');
  return out.slice(0, 4000);
};

// ---------- ACP 进程 ----------
export class AcpAgent {
  // name：日志和报错里的名字（dsh / opencode / kimi）
  // bin()：找程序，找不到返回 null；missing：找不到时的提示
  // command(bin)：[可执行文件, 参数]；prepare(log)：起进程前调，返回 { env, sig }（模型库注入的环境变量和签名）
  // rpcError(err)：把 JSON-RPC 的 error 转成给人看的话；hardKill：空闲关进程时除了关 stdin 还 kill
  constructor({ name, bin, missing, command, prepare, rpcError, hardKill = true }) {
    Object.assign(this, { name, findBin: bin, missing, command, prepare, rpcErrorOf: rpcError, hardKill });
    this.proc = null; this.ready = null; this.rid = 0; this.idleTimer = null; this.caps = {};
    this.sig = ''; this.stale = false;
    this.pending = new Map();
    this.owners = new Map();    // 会话 id → runner（收 session/update 和权限请求）
    // 正在关闭的会话：sid → 关闭用的 Promise。旧 runner 的关闭还没结束，同一个会话又被打开时，
    // 新 runner 刚登记的 owners 会被旧 runner 的 finally 删掉（回复不显示），所以要等它关完再接上
    this.closing = new Map();
    this.closedAt = new Map();  // sid → 我们最后一次关掉它的时间（刚关掉又打开时，锁可能还没放开）
  }
  get running() { return !!this.proc; }

  start(log) {
    if (this.ready) return this.ready;
    const bin = this.findBin();
    if (!bin) return Promise.reject(new Error(this.missing));
    const prep = this.prepare?.(log) || {};
    this.sig = prep.sig || ''; this.stale = false;
    const [cmd, args] = this.command(bin);
    const p = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], cwd: HOME, env: { ...binEnv(), ...(prep.env || {}) } });
    this.proc = p;
    let buf = '', errTail = '';
    const lastErr = () => errTail.trim().split('\n').pop() || '';
    p.stdout.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.method && m.id != null) this.onAgentRequest(m);
        else if (m.method) this.onNotify(m);
        else if (m.id != null && this.pending.has(m.id)) {
          const q = this.pending.get(m.id); this.pending.delete(m.id);
          m.error ? q.rej(new Error(this.rpcErrorOf?.(m.error) || m.error.data?.details || m.error.data?.message || m.error.message || this.name + ' 请求失败')) : q.res(m.result);
        }
      }
    });
    p.stderr.on('data', d => { errTail = (errTail + d).slice(-2000); });
    const dead = why => {
      if (this.proc !== p) return;
      this.proc = null; this.ready = null;
      const e = new Error(why);
      for (const q of this.pending.values()) q.rej(e);
      this.pending.clear();
      for (const r of this.owners.values()) r.onAcpDead(why);
      this.owners.clear();
    };
    p.on('error', e => dead(this.name + ' 启动失败：' + e.message));
    p.on('exit', code => { log?.(this.name + ' acp exited', code, lastErr()); dead(this.name + ' 进程退出了（' + code + '）'); });
    log?.(this.name + ' acp starting', bin);
    // initialize 最多等 45 秒（老电脑上几个会话同时启动时会超过 15 秒）。失败或挂住就杀掉子进程、
    // proc/ready 置空，下次用时自动重新拉起；不然整个后端就永久不可用了
    let initTimer = null;
    const init = this.rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claclaw', version: '0.1' } });
    const timeout = new Promise((_, rej) => { initTimer = setTimeout(() => rej(new Error('initialize 45 秒没有应答')), 45000); initTimer.unref?.(); });
    this.ready = Promise.race([init, timeout])
      .then(r => { clearTimeout(initTimer); this.caps = r?.agentCapabilities || {}; log?.(this.name + ' acp ready'); return p; })
      .catch(e => {
        clearTimeout(initTimer);
        const last = lastErr();
        const why = this.name + ' 初始化失败：' + (e?.message || e) + (last ? '（' + last + '）' : '');
        try { p.kill(); } catch {}
        dead(why);
        throw new Error(why);
      });
    this.ready.catch(() => {});
    return this.ready;
  }
  rpc(method, params) {
    if (!this.proc) return Promise.reject(new Error(this.name + ' 没在运行'));
    return new Promise((res, rej) => {
      const id = ++this.rid;
      this.pending.set(id, { res, rej });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  notify(method, params) { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n'); }
  answer(id, result, error) { this.proc?.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }) + '\n'); }
  onNotify(m) {
    if (m.method !== 'session/update') return;
    this.owners.get(m.params?.sessionId)?.handle(m.params.update || {});
  }
  onAgentRequest(m) {
    const r = this.owners.get(m.params?.sessionId);
    if (m.method === 'session/request_permission' && r) return r.askPermission(m.id, m.params);
    if (m.method === 'session/request_permission') return this.answer(m.id, { outcome: { outcome: 'cancelled' } });
    this.answer(m.id, null, { code: -32601, message: 'method not supported: ' + m.method });
  }

  // 要用了：起好进程，取消空闲关闭
  async use(log) { await this.start(log); clearTimeout(this.idleTimer); }
  stop() { try { this.proc?.stdin.end(); if (this.hardKill) this.proc?.kill(); } catch {} }
  // 没有会话接着时，过 10 分钟把进程关掉；模型库改过（stale）就马上关，下次用时带上新的
  idleCheck() {
    clearTimeout(this.idleTimer);
    if (this.owners.size || !this.proc) return;
    if (this.stale) return this.stop();
    this.idleTimer = setTimeout(() => { if (!this.owners.size && this.proc) this.stop(); }, 10 * 60 * 1000);
  }
  // 模型库改了（sig 变了）：进程要重启才看得到。没有会话接着就马上关，有就等它们都关掉
  modelsChanged(sig, log) {
    if (!this.proc || sig === this.sig) return;
    this.stale = true;
    if (!this.owners.size) { log?.(this.name + ' acp restart: models changed'); this.idleCheck(); }
  }
  async waitClosing(sid) { const p = this.closing.get(sid); if (p) { try { await p; } catch {} } }
  // runner 不再接着这个会话：只在「现在登记的还是它」时才删，免得删掉新 runner 的登记
  release(sid, runner) { if (this.owners.get(sid) === runner) this.owners.delete(sid); this.idleCheck(); }
}

// ---------- 打开的会话 ----------
// 子类的静态字段：agent（AcpAgent）、prefix（'ds:' …）、runners（id → runner 的 Map）、label（'DeepSeek' …，模型分组名用 group）
// 子类可以覆盖的：history()、modelNameOf(cfg)、ownModel(o, store)、cleanName(name)、ctxNow()、beforePrompt()、afterPrompt()、
// prepareAttach()、attachError(e)、permInfo(tc, known)、imageError
export class AcpRunner {
  constructor(id, { log, onActivity, onTurnDone, onAsk, info } = {}) {
    const C = this.constructor;
    this.id = id; this.sid = id.slice(C.prefix.length);
    this.agent = C.agent;
    this.log = log; this.onActivity = onActivity; this.onTurnDone = onTurnDone; this.onAsk = onAsk;
    this.cwd = info?.cwd || '';
    this.info = { sessionId: id, cwd: this.cwd };
    this.title = info?.title || '';
    this.model = info?.model || '';
    this.mode = 'default'; this.allowedModes = ['default'];
    this.busy = false; this.busySince = 0;
    this.subs = new Set(); this.pending = new Map();
    this.suggestion = null; this.commands = C.commands;
    this.closed = false; this.attached = false; this.attaching = null; this.config = null;
    this.textOpen = false; this.msgId = null; this.lastText = '';
    this.queue = [];            // 回复中又发来的消息：这一轮结束（或被中断）后合成一条发出
    this.tools = new Map();     // toolCallId → { name, kind, started, finished, args, item }
    this.items = null;          // 历史靠 ACP 重放的（Kimi）：网页条目记在这里
    this.replaying = false;
    this.ctx = null; this.ctxSent = undefined; this.compactAsked = false;
  }

  // ---- 子类按需覆盖 ----
  history() { return this.items ? { items: this.items, total: this.items.length } : { items: [], total: 0 }; }
  modelNameOf(cfg) { return optName(cfg, 'model'); }
  cleanName(name) { return String(name || ''); }
  ownModel(o) { const v = String(o.value); return { value: v, label: String(o.name || v), id: v, base: '' }; }
  ctxNow() { return this.ctx; }
  beforePrompt() {}
  afterPrompt() {}
  async prepareAttach() {}
  attachDone() {}
  attachError(e) { return e; }
  get imageError() { return this.constructor.label + ' 当前模型没有声明图片输入'; }
  get openMethod() { return 'session/resume'; }

  metaLine() { return tilde(this.cwd || '') + (this.model ? ' · ' + this.model : ''); }

  // 接上 agent（打开会话设置、发消息前都调；接上过就直接返回；同时来的几次共用一次）
  attach() {
    if (this.attached) return Promise.resolve();
    if (this.attaching) return this.attaching;
    this.attaching = (async () => {
      let ok = false;
      try {
        await this.prepareAttach();
        await this.agent.use(this.log);
        await this.agent.waitClosing(this.sid);   // 上一次关闭还没关完就先等它，否则会互相踩 owners
        this.agent.owners.set(this.sid, this);
        try {
          const open = () => this.agent.rpc(this.openMethod, { sessionId: this.sid, cwd: this.cwd || HOME, mcpServers: [] });
          // 刚关掉的会话马上又打开：有的 agent（kimi）关完还要过一两秒才放开会话锁，这期间报「被占用」就等一下再试
          let r;
          for (let i = 0; ; i++) {
            try { r = await open(); break; } catch (e) {
              const recent = Date.now() - (this.agent.closedAt.get(this.sid) || 0) < 20000;
              if (!recent || i >= 12 || !this.constructor.lockedRe?.test(e.message || '')) throw e;
              await new Promise(res => setTimeout(res, 500));
            }
          }
          this.setConfig(r?.configOptions);
          this.attached = true; ok = true;
        } catch (e) {
          this.agent.release(this.sid, this);
          throw this.attachError(e);
        }
      } finally { this.attachDone(ok); }
    })().finally(() => { this.attaching = null; });
    return this.attaching;
  }
  setConfig(cfg) {
    if (!Array.isArray(cfg)) return;
    this.config = cfg;
    const name = this.modelNameOf(cfg);
    if (name && name !== this.model) { this.model = name; this.emit({ t: 'session.meta', cwdShort: this.metaLine() }); }
    this.emit({ t: 'xmodels', ...this.xmodels() });
  }

  // 会话设置里的模型选择：模型库注入的（claclaw-*）一组，agent 自带的一组。还没接上时只有当前模型名
  xmodels() {
    const opt = this.config?.find(o => o.id === 'model');
    if (!opt) return { current: null, label: this.model || '', groups: null };
    const store = storeNow(), list = flatOptions(opt);
    const own = list.map(o => this.ownModel(o, store));
    const cur = list.find(o => o.value === opt.currentValue);
    return { current: opt.currentValue, label: cur ? this.cleanName(cur.name) : this.model, groups: splitGroups(store, this.constructor.group, own) };
  }
  // 打开会话设置时：还没接上就先接上（拿到模型清单）
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
    const r = await this.agent.rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value });
    this.setConfig(r?.configOptions);
    const name = this.cleanName(hit.name || value);
    this.log?.(this.agent.name + ' model', this.sid.slice(0, 16), '→', name);
    return name;
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
  activity(label) { if (!this.replaying) this.onActivity?.(this.id, label); }

  // agent 推来的 session/update。重放历史（replaying）时只记条目、不推给网页
  handle(u) {
    if (this.closed) return;
    const items = this.items, last = items?.[items.length - 1];
    switch (u.sessionUpdate) {
      case 'user_message_chunk': {   // 只有重放历史时要（网页发的消息 beforePrompt 里已经记了）
        if (!this.replaying || !items) return;
        const t = u.content?.type === 'text' ? u.content.text : '';
        const img = u.content?.type === 'image' && u.content.data ? { media_type: u.content.mimeType || 'image/png', data: u.content.data } : null;
        if (!t && !img) return;
        if (last?.kind === 'user' && this.replayOpen === 'user') { if (t) last.text += t; if (img) (last.images ||= []).push(img); }
        else { items.push({ kind: 'user', text: t || '', images: img ? [img] : undefined }); this.replayOpen = 'user'; }
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
          items?.push({ kind: 'ai', text: t, at: this.replaying ? undefined : Date.now() });
        } else if (items && last?.kind === 'ai') last.text += t;
        if (!this.replaying) { this.lastText += t; this.emit({ t: 'ai.delta', text: t }); this.activity('回复中'); }   // lastText：推送通知里显示开头
        return;
      }
      case 'agent_thought_chunk':
        this.activity('思考中');
        return;
      case 'tool_call':
      case 'tool_call_update': {
        // 有的 agent 先发一条只有工具名的 tool_call，参数在后面的 update 里：有了参数（或者已经结束）才显示卡片
        this.replayOpen = 'tool';
        let t = this.tools.get(u.toolCallId);
        if (!t) { t = { name: u.title || 'tool', kind: u.kind || '', started: false }; this.tools.set(u.toolCallId, t); }
        if (u.title && !t.started && !/^Running: /.test(u.title)) t.name = u.title;
        if (u.rawInput && typeof u.rawInput === 'object' && Object.keys(u.rawInput).length) t.args = u.rawInput;
        else if (typeof u.rawInput === 'string' && u.rawInput) t.args = u.rawInput;
        else if (!t.args && u.status === 'in_progress') t.args = this.streamedArgs(u);
        const target = toolTarget(t.args);
        const done = u.status === 'completed' || u.status === 'failed';
        if (!t.started && (target || done || (u.sessionUpdate === 'tool_call' && !this.constructor.waitArgs))) this.toolStart(u.toolCallId, t, target, u.kind);
        if (done && !t.finished && t.item) {
          t.finished = true;
          const out = toolOutput(u);
          t.item.output = out; t.item.status = u.status === 'failed' ? 'no' : 'ok';
          this.emit({ t: 'tool.result', id: u.toolCallId, output: out, isError: u.status === 'failed' });
        }
        return;
      }
      case 'usage_update':   // 当前上下文大小。在 session/prompt 应答之后才到：这一轮已经结束了就直接发
        if (!this.constructor.ctxFromUsage || !(Number(u.used) > 0)) return;
        this.ctx = Number(u.used);
        if (!this.busy && !this.replaying && this.ctx !== this.ctxSent) { this.ctxSent = this.ctx; this.emit({ t: 'ctx', tokens: this.ctx }); }
        return;
      case 'session_info_update':   // agent 自己起的标题
        if (!this.constructor.titleFromAgent || !u.title || this.replaying) return;
        { const t = oneLine(u.title).slice(0, 100); if (t && t !== this.title) { this.title = t; this.emit({ t: 'session.renamed', title: t }); } }
        return;
      case 'config_option_update':
        this.setConfig(u.configOptions);
        return;
    }
  }
  streamedArgs() { return null; }
  toolStart(id, t, target, kind) {
    t.started = true;
    this.closeText();
    t.item = { kind: 'tool', id, name: t.name, target, status: 'ok', output: '' };
    this.items?.push(t.item);
    this.emit({ t: 'tool.start', id, name: t.name, target });
    this.activity(toolLabel(t.name, kind || t.kind));
  }

  // agent 要确认的操作：转成网页的确认条（和 Claude 的 perm.request 同一种）
  // 命令按 Claude 会话的样子：标题「允许运行这条命令？」，命令全文放在下面（网页那块能滚动）
  permInfo(tc, known) {
    const tool = known?.name || '';
    const raw = tc.rawInput && typeof tc.rawInput === 'object' ? tc.rawInput : (known?.args && typeof known.args === 'object' ? known.args : {});
    const isCmd = tc.kind === 'execute' || /^(bash|shell)$/i.test(tool) || typeof raw.command === 'string';
    const isEdit = !isCmd && (tc.kind === 'edit' || /^(edit|write|patch|multiedit)$/i.test(tool));
    const name = isCmd ? 'Bash' : isEdit ? 'Edit' : (tool || '操作');
    const target = (isCmd && raw.command ? String(raw.command) : toolTarget(raw) || String(tc.title || '')).slice(0, 4000);
    return { name, target, reason: '', ask: isCmd ? '运行命令' : isEdit ? '修改文件' : name, raw };
  }
  askPermission(rpcId, p) {
    const requestId = this.constructor.permPrefix + rpcId;
    const opts = p.options || [];
    const tc = p.toolCall || {};
    const known = this.tools.get(tc.toolCallId);
    const info = this.permInfo(tc, known);
    // 卡片还没出来（参数没拼完就来要确认）：先把卡片显示出来，确认条才有地方挂
    if (known && !known.started) this.toolStart(tc.toolCallId, known, toolTarget(info.raw) || info.target.slice(0, 160), tc.kind);
    const req = {
      t: 'perm.request', requestId, toolUseID: tc.toolCallId, name: info.name,
      title: null, displayName: info.name, description: '', target: info.target,
      reason: info.reason || '', canAlways: opts.some(o => o.kind === 'allow_always'), defaultToNo: false,
    };
    this.pending.set(requestId, { rpcId, opts, req });
    this.emit(req);
    this.onAsk?.(this, '等你确认：' + info.ask);
  }
  replyPermission(requestId, decision) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    const kind = decision === 'allow' ? 'allow_once' : decision === 'allow_session' ? 'allow_always' : 'reject_once';
    const opt = p.opts.find(o => o.kind === kind) || (kind === 'reject_once' && p.opts.find(o => o.kind === 'reject_always'));
    this.agent.answer(p.rpcId, opt ? { outcome: { outcome: 'selected', optionId: opt.optionId } } : { outcome: { outcome: 'cancelled' } });
    this.emit({ t: 'perm.done', requestId, toolUseID: p.req.toolUseID, decision });
  }

  // 发消息。/model 这类可调选项的命令走 session/set_config_option
  send(text, images = []) {
    const names = Object.keys(this.constructor.cfgIds).join('|');
    const cmdRe = new RegExp('^\\/(' + names + ')(?:\\s+(.*))?$');
    if (!this.busy && /^\/compact\s*$/.test(String(text))) this.compactAsked = true;
    if (this.busy) {
      // ACP 不支持插话：先排队。命令不排队（等这一轮结束再发），最多排 10 条
      if (new RegExp('^\\/(' + names + ')\\b').test(text) || this.queue.length >= 10) return false;
      this.queue.push({ text, images });
      return 'queued';
    }
    const cmd = text.match(cmdRe);
    this.lastText = '';
    this.setBusy(true);
    (async () => {
      try {
        await this.attach();
        if (cmd) return this.finish(await this.command(cmd[1], (cmd[2] || '').trim()));
        if (images.length && !this.agent.caps.promptCapabilities?.image) throw new Error(this.imageError);
        this.beforePrompt(text, images);
        const prompt = [
          ...images.map(i => ({ type: 'image', mimeType: i.media_type, data: i.data })),
          ...(text ? [{ type: 'text', text }] : []),
        ];
        const r = await this.agent.rpc('session/prompt', { sessionId: this.sid, prompt });
        this.afterPrompt();
        this.finish({ reason: r?.stopReason || 'end_turn' });
      } catch (e) {
        this.finish({ error: e.message });
      }
    })();
    return true;
  }
  onFinish() {}
  finish({ reason, error, text } = {}) {
    if (this.closed) return;
    this.closeText();
    for (const [id, t] of this.tools) if (t.finished || !t.started) this.tools.delete(id);
    if (text) this.emit({ t: 'ai.full', text });
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    const ok = !error && (reason === 'end_turn' || reason === 'command');
    const subtype = error ? 'error' : reason === 'cancelled' ? 'aborted' : ok ? 'success' : reason;
    if (error) this.emit({ t: 'error', message: error });
    this.onFinish({ reason, error });
    {   // 上下文大小（标题栏的压缩提示）：每轮结束看一次；compacted = 这一轮是压缩
      const c = this.ctxNow(), compacted = this.compactAsked && !error;
      this.compactAsked = false;
      if (c !== undefined && (c !== this.ctxSent || compacted)) { this.ctx = c; this.ctxSent = c; this.emit({ t: 'ctx', tokens: c, ...(compacted ? { compacted: true } : {}) }); }
    }
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

  // /model 这类：不带参数列出可选项；带参数按值 / 名字匹配（先全等，再包含、取最短的）
  async command(name, arg) {
    const C = this.constructor;
    const opt = this.config?.find(o => o.id === C.cfgIds[name]);
    if (!opt) return { reason: 'command', text: '当前会话没有可调的' + C.cfgNames[name] };
    const list = flatOptions(opt);
    const cur = list.find(o => o.value === opt.currentValue);
    if (!arg) {
      // 值是简单的词就列值（后面跟显示名）；值是 JSON 之类的就列名字
      const line = o => { const v = String(o.value), n = String(o.name ?? v), plain = /^[\w.:/@+-]+$/.test(v); return '- `' + (plain ? v : n) + '`' + (plain && n !== v ? ' ' + n : '') + (o.description ? ' ' + o.description : ''); };
      return { reason: 'command', text: '当前：' + (cur?.name || opt.currentValue) + '\n\n可选：\n' + list.map(line).join('\n') };
    }
    const a = arg.toLowerCase();
    const hit = list.find(o => String(o.value).toLowerCase() === a || String(o.name).toLowerCase() === a)
      || list.filter(o => (o.name + ' ' + o.value).toLowerCase().includes(a)).sort((x, y) => String(x.name).length - String(y.name).length)[0];
    if (!hit) return { reason: 'command', text: '没有匹配「' + arg + '」的选项' };
    const r = await this.agent.rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value: hit.value });
    this.setConfig(r?.configOptions);
    return { reason: 'command', text: '已切换为 ' + hit.name + '（下一条消息生效）' };
  }

  async interrupt() {
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    if (this.attached) this.agent.notify('session/cancel', { sessionId: this.sid });
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
    this.constructor.runners.delete(this.id);
    const ag = this.agent;
    if (this.attached) {
      this.attached = false;
      // 记下这次关闭：等它关完，同一个会话才能再接上
      const p = ag.rpc('session/close', { sessionId: this.sid }).catch(() => {}).finally(() => {
        ag.closedAt.set(this.sid, Date.now());
        if (ag.owners.get(this.sid) === this) ag.owners.delete(this.sid);
        ag.closing.delete(this.sid);
        ag.idleCheck();
      });
      ag.closing.set(this.sid, p);
    } else if (ag.owners.get(this.sid) === this) ag.release(this.sid, this);
  }

  // 新建：在某个目录里开一个新会话（Cls = 子类）
  static async create(cwd, opts) {
    const ag = this.agent;
    await ag.use(opts.log);
    const r = await ag.rpc('session/new', { cwd, mcpServers: [] });
    this.onCreated?.(r.sessionId);
    await ag.waitClosing(r.sessionId);
    const id = this.prefix + r.sessionId;
    const runner = new this(id, { ...opts, info: { cwd, title: '新会话' } });
    ag.owners.set(r.sessionId, runner);
    runner.attached = true;
    runner.setConfig(r.configOptions);
    this.runners.set(id, runner);
    return runner;
  }
}
