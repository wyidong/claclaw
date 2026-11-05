// ACP（Agent Client Protocol）共用底座：DeepSeek（dsh）、OpenCode、Kimi 都走它。
// - AcpAgent：一个 agent 程序的 ACP 进程（单例，多个会话共用；挂了下次用时再起；没会话接着 10 分钟后关）
//   stdin/stdout 一行一条 JSON-RPC。收到的 session/update、权限请求按 sessionId 交给对应的 runner。
// - AcpRunner：网页里打开的一个会话（接口和 Claude 的 Runner 对齐：send / interrupt / replyPermission / subscribe …）。
//   各家只写差异：怎么接上会话、历史从哪读、模型名怎么显示、上下文大小从哪来、确认条怎么显示。
import { spawn } from 'node:child_process';
import path from 'node:path';
import { storeNow, splitGroups } from './modelpick.mjs';
import { HOME, tilde, oneLine, binEnv, binCall, readJson } from './util.mjs';
import { DATA, writeJsonAtomic } from './auth.mjs';
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

// 各家上次拿到的模型清单（agent 名 → model 配置项，不含当前值）：会话还没接上时，会话设置先拿它显示，不用等起进程
const MODELS_FILE = path.join(DATA, 'acp-models.json');
let modelCache = null;
const modelsCached = () => (modelCache ??= readJson(MODELS_FILE));

// ---------- ACP 进程 ----------
// 历史重放（session/load）不带时间：拿会话记录文件里的时间对回去。
// recs：按顺序的 { kind: 'user' | 'ai', text?, at }（用户那条带文字，用来对齐）。
// 用户消息按文字往后找；回复取这一轮（到下一条用户消息前）最后一条回复的时间（网页每轮只在最后一条回复上显示时间）
const normText = s => String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
export function stampTimes(items, recs) {
  if (!recs?.length) return items;
  let p = 0, lost = false;
  for (const it of items) {
    if (it.at) continue;
    if (it.kind === 'user') {
      const want = normText(it.text);
      let i = p;
      for (; i < recs.length; i++) if (recs[i].kind === 'user' && (!want || normText(recs[i].text).startsWith(want) || want.startsWith(normText(recs[i].text)))) break;
      if (i < recs.length) { it.at = recs[i].at; p = i + 1; lost = false; } else lost = true;
    } else if (it.kind === 'ai' && !lost) {
      let at = 0;
      for (let i = p; i < recs.length && recs[i].kind !== 'user'; i++) if (recs[i].kind === 'ai') at = recs[i].at;
      if (at) it.at = at;
    }
  }
  return items;
}

// 推理强度 / 权限：agent 在 configOptions 里用 category 标（thought_level / mode），没标的按 id 认。
// 有没有、有哪几档都看 agent 和当前模型（Codex 只给它认识的模型推理强度；OpenCode 看模型）
const CFG_KINDS = { effort: { cat: ['thought_level'], ids: ['reasoning_effort', 'effort', 'thinking'], name: '推理强度' }, mode: { cat: ['mode', '_permission'], ids: ['mode', 'permissionMode'], name: '权限' } };
export const cfgFind = (cfg, kind) => Array.isArray(cfg) ? cfg.find(o => CFG_KINDS[kind].cat.includes(o.category)) || cfg.find(o => !o.category && CFG_KINDS[kind].ids.includes(o.id)) || null : null;
export const cfgKindName = kind => CFG_KINDS[kind]?.name || kind;
const EFFORT_ZH = {
  off: ['不思考', '最快，适合简单问题'], none: ['不思考', '最快，适合简单问题'], on: ['思考', '先想再回答'],
  minimal: ['最低', '几乎不思考'], low: ['低', '快、省用量'], medium: ['中', '速度和质量均衡'], high: ['高', '想得更仔细'],
  xhigh: ['超高', '复杂编码、长任务'], max: ['最高', '最深入，也最耗用量'],
};
const MODE_ZH = {
  default: ['每次询问', '改文件、跑命令前先问你'],
  build: ['正常', '按 OpenCode 的权限设置执行'],
  plan: ['只做计划', '只分析、出方案，不改文件'],
  'auto-edit': ['自动改文件', '改文件不问，跑命令还会问'],
  auto: ['自动判断', '安全的操作自动通过，有风险的才问'],
  yolo: ['全部自动', '什么都不问'],
  'read-only': ['只读', '改文件、上网前先问你'],
  'workspace-write': ['工作区可写', '目录里随便改；写到外面或上网前先问'],
  agent: ['自动审核', '只有看起来不安全的操作才问'],
  'agent-full-access': ['完全访问', '任何文件、网络都不受限制，什么都不问'],
  accept_edits: ['自动改文件', '改文件不问，跑命令还会问'], acceptedits: ['自动改文件', '改文件不问，跑命令还会问'],
  bypass_permissions: ['全部自动', '什么都不问'], bypasspermissions: ['全部自动', '什么都不问'],
  smart: ['智能判断', '自动评估风险，有风险的才问'], dontask: ['不询问', '要确认的操作直接拒绝，不问你'],
};
// 网页用的选项：{ id, current, items: [{ value, label, sub }] }
export function cfgView(opt, kind, current = opt?.currentValue) {
  if (!opt) return null;
  const zh = kind === 'effort' ? EFFORT_ZH : MODE_ZH;
  const items = flatOptions(opt).map(o => { const v = String(o.value), z = zh[v.toLowerCase()]; return { value: v, label: z ? z[0] : String(o.name || v), sub: z ? z[1] : String(o.description || '') }; });
  return items.length ? { id: opt.id, current: current ?? null, items } : null;
}

// 有的 agent 没有改名接口（GLM Agent / iFlow / MiniMax Code / CodeBuddy / Qoder）：名字记在 claclaw 这边，按会话 id 查
const NAMES_FILE = path.join(DATA, 'claw-names.json');
let namesCache = null;
export const localNames = {
  all() { return (namesCache ??= readJson(NAMES_FILE)); },
  get(id) { return this.all()[id] || ''; },
  set(id, title) { const c = this.all(); if (title) c[id] = title; else delete c[id]; try { writeJsonAtomic(NAMES_FILE, c); } catch {} },
};
// 用户消息里 agent 自己塞的提示块（<system-reminder>、<xxx-reminder>、<agent-context>）去掉
export const stripTags = t => String(t || '').replace(/\s*<(system-reminder|[a-z]+(?:-[a-z]+)*-reminder|agent-context)>[\s\S]*?<\/\1>\s*/g, '\n').trim();

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
    // binCall：Windows 上 npm 装的命令是 .cmd，spawn 不了，换成 node 跑它里面的 JS 入口（其他系统原样返回）
    const { cmd, args } = binCall(...this.command(bin));
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
    // clientCapabilities 按 ACP 的样子给全（fs 两项都 false：文件读写由 agent 自己做）；iFlow 少了 fs 这项会拒绝 initialize
    const init = this.rpc('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'claclaw', version: '0.1' } });
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

  // 上次见到的模型 / 推理强度 / 权限清单（没接上时、新建对话框里先用它）
  cachedModels() { return modelsCached()[this.name] || null; }
  cachedOpt(kind) { return modelsCached()[this.name + ':' + kind] || null; }
  saveModels(opt, kind) {
    const key = kind ? this.name + ':' + kind : this.name;
    const { currentValue, ...v } = opt, c = modelsCached();
    if (JSON.stringify(c[key]) === JSON.stringify(v)) return;
    c[key] = v;
    try { writeJsonAtomic(MODELS_FILE, c); } catch {}
  }
  // 打开会话时先把进程起好（起进程 + initialize 要 1~2 秒），换模型、发第一条时就不用等；没会话接上照常 10 分钟后关
  warm(log) {
    if (this.proc || !this.findBin()) return;
    this.start(log).then(() => this.idleCheck(), () => {});
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
  // 接上 / 新建的应答里的选项清单；模型、模式不在 configOptions 里的 agent（iFlow）由子类从 models / modes 合成
  cfgOf(r) { return r?.configOptions; }

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
          this.setConfig(this.cfgOf(r));
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
    const mo = cfg.find(o => o.id === 'model');
    if (mo) this.agent.saveModels(mo);
    for (const k of ['effort', 'mode']) { const o = cfgFind(cfg, k); if (o) this.agent.saveModels(o, k); }
    const name = this.modelNameOf(cfg);
    if (name && name !== this.model) { this.model = name; this.emit({ t: 'session.meta', cwdShort: this.metaLine() }); }
    this.emit({ t: 'xmodels', ...this.xmodels() });
  }

  // 会话设置里的模型选择：模型库注入的（claclaw-*）一组，agent 自带的一组。
  // 还没接上时用上次记下的清单（cached，网页随后再要一次真的），当前项按模型 ID / 名字对（对上不止一个就不打勾）；一次都没接过就只有当前模型名
  xmodels() {
    let opt = this.config?.find(o => o.id === 'model'), cached;
    if (!opt) {
      const c = this.agent.cachedModels();
      if (!c) return { current: null, label: this.model || '', groups: null, ...this.optViews() };
      const store = storeNow(), hits = this.model ? flatOptions(c).filter(o => this.ownModel(o, store).id === this.model || this.cleanName(this.modelNameOf([{ ...c, currentValue: o.value }])) === this.model) : [];
      opt = { ...c, currentValue: hits.length === 1 ? hits[0].value : null }; cached = true;
    }
    const store = storeNow(), list = flatOptions(opt);
    const own = list.map(o => this.ownModel(o, store));
    const cur = list.find(o => o.value === opt.currentValue);
    return { current: opt.currentValue, label: cur ? this.cleanName(cur.name) : this.model, groups: splitGroups(store, this.constructor.group, own), cached, ...this.optViews() };
  }
  // 推理强度 / 权限：接上了用当前的；没接上用上次记下的清单（不知道当前是哪个）。
  // 推理强度跟着模型变：接上了却没有，就是这个模型没有
  optViews() {
    const out = {};
    for (const k of ['effort', 'mode']) out[k] = this.config ? cfgView(cfgFind(this.config, k), k) : cfgView(this.agent.cachedOpt(k), k, null);
    return out;
  }
  async setOption(kind, value) {
    if (!CFG_KINDS[kind]) throw new Error('不能调这一项');
    if (!this.attached) await this.attach();
    const opt = cfgFind(this.config, kind);
    if (!opt) throw new Error(this.constructor.label + (kind === 'effort' ? ' 当前模型没有推理强度可选' : ' 没有权限模式可选'));
    const hit = flatOptions(opt).find(o => String(o.value) === value);
    if (!hit) throw new Error('没有这个' + cfgKindName(kind) + '：' + value);
    if (String(opt.currentValue) !== value) {
      this.setConfig(await this.applyCfg(opt, hit.value));
      this.log?.(this.agent.name + ' ' + kind, this.sid.slice(0, 16), '→', value);
    }
    return cfgView(opt, kind).items.find(x => x.value === value)?.label || value;
  }
  // 改一个选项，返回新的 configOptions。一般走 session/set_config_option；
  // 子类合成的选项（_set = 'model' | 'mode'）走 session/set_model / session/set_mode，改完自己更新 currentValue
  async applyCfg(opt, value) {
    if (!opt._set) { const r = await this.agent.rpc('session/set_config_option', { sessionId: this.sid, configId: opt.id, value }); return r?.configOptions; }
    if (opt._set === 'model') await this.agent.rpc('session/set_model', { sessionId: this.sid, modelId: value });
    else await this.agent.rpc('session/set_mode', { sessionId: this.sid, modeId: value });
    return (this.config || []).map(o => o === opt ? { ...o, currentValue: value } : o);
  }
  // 新建对话框用：还没有会话时按上次记下的清单给出可选的模型 / 推理强度 / 权限
  static preview() { return new this(this.prefix + 'preview', {}).xmodels(); }
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
    this.setConfig(await this.applyCfg(opt, value));
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
      case 'session_info_update':   // agent 自己起的标题（本机改过名的不跟它走）
        if (!this.constructor.titleFromAgent || !u.title || this.replaying || localNames.get(this.id)) return;
        { const t = oneLine(u.title).slice(0, 100); if (t && t !== this.title) { this.title = t; this.emit({ t: 'session.renamed', title: t }); } }
        return;
      case 'config_option_update':
        this.setConfig(u.configOptions);
        return;
      case 'current_mode_update': {   // 模式被 agent 自己改了：合成的 mode 选项跟着更新
        const o = cfgFind(this.config, 'mode');
        if (o?._set && u.currentModeId && o.currentValue !== u.currentModeId) this.setConfig(this.config.map(x => x === o ? { ...x, currentValue: u.currentModeId } : x));
        return;
      }
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
    this.setConfig(await this.applyCfg(opt, hit.value));
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
    runner.setConfig(runner.cfgOf(r));
    this.runners.set(id, runner);
    return runner;
  }
}
