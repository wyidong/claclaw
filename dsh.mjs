// DeepSeek Harness（dsh）适配。
// - 会话列表和历史：直接读 ~/.dsh/sessions/<目录>/<id>/session.v4.jsonl.zstd（dsh 0.2 起；旧版是 v3，两个都在时读 v4。追加写的多段 zstd + JSONL），和读 Claude 会话文件一个思路。
// - 发消息：claclaw 自己起一个 `dsh --profile acp`（ACP 标准协议，stdin/stdout 一行一条 JSON-RPC），
//   用 session/resume 接上已有会话、session/prompt 发消息；不依赖 dsh 网页版（3080）开着。
// 网页里 DeepSeek 会话的 id = 'ds:' + dsh 会话 id，和 Claude 的 UUID、OpenClaw 的 oc: 区分开。
// 注意：同一个会话同时只能有一个写入方。dsh 网页版开着这个会话时这里接不上（反过来也一样），所以空闲就关掉。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { DATA } from './auth.mjs';

const HOME = os.homedir();
const DSH_HOME = process.env.DSH_HOME || path.join(HOME, '.dsh');
const ROOT = path.join(DSH_HOME, 'sessions');
const ATTACH = path.join(DSH_HOME, 'attachments', 'v1', 'objects');
// dsh 0.2 升级会话时会另写一份 v4，旧的 v3 留着不再更新，所以新格式优先
const LOG_NAMES = ['session.v4.jsonl.zstd', 'session.v3.jsonl.zstd'];

// 当前 Node 有没有 zstd（读 dsh 会话记录要用；Node 22.15 才有）
export const dsSupported = () => typeof zlib.zstdDecompressSync === 'function';
export const dsUnsupportedReason = () => '当前 Node 没有 zstd（需要 Node 22.15 以上），读不了 DeepSeek 会话';
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
      const f = LOG_NAMES.map(n => path.join(ROOT, g, d, n)).find(x => fs.existsSync(x));
      if (f) map.set(d, f);
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
  return { id: head.id, cwd: head.cwd || '', createdAt: head.createdAt || 0, sub: head.origin === 'subagent' || !!head.parentSession || head.delegationDepth > 0, title, model, firstPrompt, hasUser };
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

const tms = v => { const n = typeof v === 'string' ? (/^\d+$/.test(v) ? +v : Date.parse(v)) : +v; return n > 0 ? (n < 1e12 ? n * 1000 : n) : undefined; };   // 时间统一成毫秒（秒 / ISO 字符串都认）

// 费用估算：只用 dsh 日志里 provider 上报的 usage 桶，乘 DeepSeek 公开价。
// 缓存写入按未命中输入价；法定节假日、账号折扣/赠金不算，这是给用户“心里有数”的近似值。
const DS_PRICE = {
  flash: { hit: [0.02, 0.04], miss: [1, 2], out: [4, 8] },       // 元 / 百万 tokens： [空闲, 高峰]
  pro: { hit: [0.15, 0.30], miss: [4.5, 9], out: [13.5, 27] },
};
function dsPeak(ms) {
  const t = new Date((Number(ms) || Date.now()) + 8 * 3600 * 1000);   // 北京时间，无夏令时
  const d = t.getUTCDay(), h = t.getUTCHours();
  return d >= 1 && d <= 5 && ((h >= 9 && h < 12) || (h >= 14 && h < 18)) ? 1 : 0;
}
function dsRate(model, ms) {
  const p = /pro/i.test(String(model || '')) ? DS_PRICE.pro : DS_PRICE.flash;
  const k = dsPeak(ms);
  return { hit: p.hit[k], miss: p.miss[k], out: p.out[k] };
}
// 一个会话文件里的 usage 累加到 acc；返回这个会话最后用的模型
function addUsage(recs, acc) {
  let model = summarize(recs).model || '';
  for (const r of recs) {
    if (r.type !== 'assistant/message' && r.type !== 'compaction/summary') continue;
    const u = r.data?.usage;
    if (!u) continue;
    const m = r.type === 'compaction/summary' ? r.data.model : r.data.message?.source?.model;
    if (m) model = m;
    const input = Number(u.inputTokens || 0) || 0;
    const output = Number(u.outputTokens || 0) || 0;
    const hit = Number(u.cacheReadTokens || 0) || 0;
    const write = Number(u.cacheWriteTokens || 0) || 0;
    acc.tokens.uncachedInputTokens += input;
    acc.tokens.outputTokens += output;
    acc.tokens.cacheReadTokens += hit;
    acc.tokens.cacheWriteTokens += write;
    const price = dsRate(model, tms(r.time));
    // 缓存写入按未命中输入价；账号折扣/赠金/节假日不在估算里
    acc.cost += ((input + write) * price.miss + hit * price.hit + output * price.out) / 1e6;
    acc.messages++;
  }
  return model;
}
// 本次会话累计：四个 provider 上报的桶 + 按每条消息当时模型/时段估的费用（CNY）。
// 子代理是单独的会话文件（header.parentSession 指向父会话，可能多层），一起算进来
// 当前上下文大小：最后一次请求的输入量（未命中 + 缓存读 + 缓存写）。最近的是压缩记录时，用摘要的输出长度近似压缩后的大小
export function dsCtx(id) {
  if (!isDs(id)) return null;
  const sid = sidOf(id);
  if (sid.includes('/') || sid.includes('..')) return null;
  const f = scan().get(sid);
  const recs = f ? readRecords(f) || [] : [];
  for (let i = recs.length - 1; i >= 0; i--) {
    const r = recs[i], u = r.data?.usage;
    if (r.type === 'compaction/summary') return Number(u?.outputTokens) || null;
    if (r.type !== 'assistant/message' || !u) continue;
    const n = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
    if (n) return n;
  }
  return null;
}
export function dsUsage(id) {
  if (!isDs(id)) return null;
  const sid = sidOf(id);
  if (sid.includes('/') || sid.includes('..')) return null;
  const files = scan();
  const f = files.get(sid);
  if (!f) return null;
  const kids = new Map();   // 父会话 id → 子会话文件
  for (const [s, file] of files) {
    if (s === sid) continue;
    const head = (readRecords(file) || [])[0];
    const p = head?.type === 'session' ? head.parentSession : '';
    if (p) { if (!kids.has(p)) kids.set(p, []); kids.get(p).push([s, file]); }
  }
  const acc = { tokens: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0, messages: 0 };
  const model = addUsage(readRecords(f) || [], acc);
  const seen = new Set([sid]), todo = [...(kids.get(sid) || [])];
  let subagents = 0;
  while (todo.length) {
    const [s, file] = todo.shift();
    if (seen.has(s)) continue;
    seen.add(s); subagents++;
    addUsage(readRecords(file) || [], acc);
    todo.push(...(kids.get(s) || []));
  }
  return { model, messages: acc.messages, subagents, tokens: acc.tokens, costCny: Math.round(acc.cost * 10000) / 10000 };
}
function toItems(recs) {
  const items = [], toolIdx = new Map();
  for (const r of recs) {
    const d = r.data || {};
    if (r.type === 'user/message' && d.source?.kind === 'user') {
      const imgs = (d.content || []).filter(c => c.type === 'image').map(c => readImage(c.attachment)).filter(Boolean);
      const t = userText(d);
      if (t || imgs.length) items.push({ kind: 'user', text: t, images: imgs.length ? imgs : undefined, at: tms(r.time) });
    } else if (r.type === 'assistant/message') {
      for (const b of d.message?.content || []) {
        if (b.type === 'text' && b.text?.trim()) items.push({ kind: 'ai', text: b.text.trim(), at: tms(r.time) });
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
      items.push({ kind: 'user', text: '/' + d.name + (d.args ? ' ' + d.args.trim() : ''), at: tms(r.time) });
    } else if (r.type === 'command/done' && d.text) {
      items.push({ kind: 'ai', text: d.text, at: tms(r.time) });
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
// 正在关闭的会话：sid → 关闭用的 Promise。旧 runner 的关闭还没结束，同一个会话又被打开时，
// 新 runner 刚登记的 owners 会被旧 runner 的 finally 删掉（回复不显示），所以要等它关完再 resume。
const closing = new Map();

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
  // initialize 最多等 15 秒：初始化失败或挂住时，ready 会永远停在 rejected/pending，
  // 整个 DeepSeek 后端就永久不可用了。超时就杀掉子进程、把 proc/ready 置空，下次用时自动重新拉起。
  let initTimer = null;
  const init = rpc('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'claclaw', version: '0.1' } });
  const timeout = new Promise((_, rej) => {
    initTimer = setTimeout(() => rej(new Error('initialize 45 秒没有应答')), 45000);   // 老电脑上几个会话同时启动时会超过 15 秒
    initTimer.unref?.();
  });
  ready = Promise.race([init, timeout])
    .then(r => { clearTimeout(initTimer); caps = r?.agentCapabilities || {}; log?.('dsh acp ready'); return p; })
    .catch(e => {
      clearTimeout(initTimer);
      const last = errTail.trim().split('\n').pop() || '';
      const why = 'dsh 初始化失败：' + (e?.message || e) + (last ? '（' + last + '）' : '');
      try { p.kill(); } catch {}
      // 和进程自己挂掉时一样：proc/ready 置空（下次用的时候自动重新拉起）、挂着的请求全部作废
      dead(why);
      throw new Error(why);
    });
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

// ---------- dsh 原生 /compact ----------
// ACP 只暴露 session/new、resume、close、prompt 等，没有命令通道；/compact 是 dsh host 的
// 原生命令。这里临时起一个 dsh web（随机端口、不打开浏览器），用它已认证的
// POST /api/commands/execute 执行 /compact。该接口会自己 resume 目标会话，所以调用前
// 必须先把 claclaw 的 ACP 会话关掉，让 session.lock 真正释放。
const COMPACT_TIMEOUT = 10 * 60 * 1000;
const USAGE_EVERY = 150 * 1000;   // 长回合里推累计费用的间隔
const WEB_START_TIMEOUT = 45 * 1000;
const WEB_STOP_TIMEOUT = 2 * 1000;
const WEB_URL_RE = /dsh web:\s+(http:\/\/[^\s]+?\/\?token=[A-Za-z0-9_-]+)/;
const COMPACT_DONE_RE = /^Compacted \d+ history items/;

// 从 dsh web 的启动输出里取带 token 的地址；单独导出，方便测试（不会真的起进程）
export function parseDshWebUrl(text) {
  const m = String(text || '').replace(/\u001B\[[0-?]*[ -/]*[@-~]/g, '').match(WEB_URL_RE);
  return m ? m[1] : '';
}

const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

function startDshWeb(log) {
  const bin = dshBin();
  if (!bin) {
    const ready = Promise.reject(new Error('没找到 dsh 命令，先装好 DeepSeek Harness'));
    ready.catch(() => {});
    return { ready, stop: async () => {} };
  }
  const js = /\.m?js$/.test(bin);
  const profile = 'claclaw-compact';
  const args = ['--profile', profile];
  // 专用 profile，避免动用户自己的 web profile（也可能装着 TTS 等插件）。
  // 第一次用时从 dsh 自带的 web 模板建一个空壳；之后一直复用。
  if (!fs.existsSync(path.join(DSH_HOME, 'profiles', profile, 'package.json'))) args.push('--from-default-profile', 'web');
  args.push('--host', '127.0.0.1', '--port', '0', '--no-open');
  const p = spawn(js ? process.execPath : bin, js ? [bin, ...args] : args, {
    stdio: ['ignore', 'pipe', 'pipe'], cwd: HOME,
    env: { ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') },
  });
  p.stdout.setEncoding('utf8');
  p.stderr.setEncoding('utf8');
  let out = '', err = '', stopped = false;
  const ready = new Promise((resolve, reject) => {
    let timer = null;
    const cleanup = () => {
      clearTimeout(timer);
      p.stdout.off('data', onOut);
      p.stderr.off('data', onErr);
      p.off('exit', onExit);
      p.off('error', onError);
    };
    const fail = (why) => { cleanup(); reject(new Error(why)); };
    const onOut = (d) => {
      out = (out + d).slice(-12000);
      const url = parseDshWebUrl(out);
      if (!url) return;
      cleanup();
      try {
        const u = new URL(url);
        if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost' && u.hostname !== '[::1]') throw new Error('dsh web 没有绑定本机地址');
        resolve({ base: u.origin, token: u.searchParams.get('token') || '', url });
      } catch (e) { reject(new Error('dsh web 地址不可用：' + e.message)); }
    };
    const onErr = (d) => { err = (err + d).slice(-4000); };
    const onExit = (code, signal) => fail('dsh web 启动失败（' + (signal || 'exit ' + code) + '）' + (err.trim() ? '：' + err.trim().split('\n').pop() : ''));
    const onError = (e) => fail('dsh web 启动失败：' + e.message);
    p.stdout.on('data', onOut);
    p.stderr.on('data', onErr);
    p.once('exit', onExit);
    p.once('error', onError);
    timer = setTimeout(() => fail('dsh web ' + Math.round(WEB_START_TIMEOUT / 1000) + ' 秒没有启动完成' + (err.trim() ? '：' + err.trim().split('\n').pop() : '')), WEB_START_TIMEOUT);
    timer.unref?.();
  });
  ready.catch(() => {});
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    try { p.kill('SIGTERM'); } catch {}
    await new Promise(resolve => {
      if (p.exitCode !== null || p.signalCode !== null) return resolve();
      const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} resolve(); }, WEB_STOP_TIMEOUT);
      timer.unref?.();
      p.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    log?.('dsh compact host stopped');
  };
  return { ready, stop };
}

async function dshWebCookie(host) {
  const u = new URL('/connect', host.base);
  u.searchParams.set('token', host.token);
  let last;
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch(u, { redirect: 'manual' });
      if (r.status !== 302) throw new Error('dsh web 认证失败（HTTP ' + r.status + '）');
      const jars = typeof r.headers.getSetCookie === 'function' ? r.headers.getSetCookie() : [r.headers.get('set-cookie') || ''];
      const raw = jars.find(c => /^dsh-auth-/.test(c)) || jars[0] || '';
      const cookie = raw.split(';')[0];
      if (!/^dsh-auth-[^=]+=.+/.test(cookie)) throw new Error('dsh web 没有返回登录 cookie');
      return cookie;
    } catch (e) {
      last = e;
      if (i < 19) await sleep(100);
    }
  }
  throw last;
}

async function dshWebRpc(host, cookie, method, args, timeoutMs = COMPACT_TIMEOUT) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error('dsh web 请求超时')), timeoutMs);
  timer.unref?.();
  try {
    const r = await fetch(host.base + '/api/' + method, {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
    });
    const text = await r.text();
    let j;
    try { j = JSON.parse(text); } catch { throw new Error('dsh web 返回的不是 JSON（HTTP ' + r.status + '）'); }
    if (!j?.result) throw new Error('dsh web 返回格式不对');
    if (!j.result.ok) {
      const e = j.result.error || {};
      const x = new Error(e.message || e.code || 'dsh web 请求失败');
      x.code = e.code;
      throw x;
    }
    return j.result.value;
  } finally { clearTimeout(timer); }
}

// 等日志里出现这次压缩成功的 command/done，确认写入已经落盘再杀 dsh web
async function waitCompactDone(file, startedAt, ms = 5000) {
  const until = Date.now() + ms;
  for (;;) {
    const recs = readRecords(file) || [];
    for (let i = recs.length - 1; i >= 0; i--) {
      const r = recs[i];
      if (r.type !== 'command/done' || r.data?.kind !== 'success' || !COMPACT_DONE_RE.test(String(r.data?.text || ''))) continue;
      if (Number(r.time || 0) >= startedAt - 1000) return;
    }
    if (Date.now() >= until) return;
    await sleep(100);
  }
}

// 等 dsh web 进程退出、session.lock 真正可拿：ACP 再 resume 才不会撞 owners
async function waitDshUnlocked(dir, sid, ms = 5000) {
  if (!(await dshFlock())) return;
  const until = Date.now() + ms;
  for (;;) {
    let lease = null;
    try {
      lease = await acquireLease(dir, sid);
      await lease.release();
      return;
    } catch (e) {
      if (Date.now() >= until) throw e;
      await sleep(100);
    }
  }
}

// 压缩串行化：同一时间只起一个 dsh web，也避免两个请求同时初始化 profile。
let compactQueue = Promise.resolve();

// 在已经关掉 ACP 会话的前提下，用 dsh host 压缩一个会话。
// 返回 { ok, text }；失败时抛出可读错误（不抛 token）。
export function dsCompactSession(sid, opts = {}) {
  const run = () => compactSessionNow(sid, opts);
  const p = compactQueue.then(run, run);
  compactQueue = p.then(() => {}, () => {});
  return p;
}

async function compactSessionNow(sid, { log } = {}) {
  if (!dsSupported()) throw new Error(dsUnsupportedReason());
  const file = fileOf(sid);
  if (!file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  const dir = path.dirname(file);
  const startedAt = Date.now();
  const host = startDshWeb(log);
  try {
    const web = await host.ready;
    const cookie = await dshWebCookie(web);
    const value = await dshWebRpc(web, cookie, 'commands/execute', {
      agentId: sid, line: '/compact', submittedAttachments: [],
    });
    const result = value?.result;
    if (!result) throw new Error('这个 dsh 没有注册 /compact（缺少 command-compact 插件）');
    if (result.kind !== 'success') return { ok: false, text: result.text || '压缩没有成功' };
    if (COMPACT_DONE_RE.test(String(result.text || ''))) await waitCompactDone(file, startedAt);
    return { ok: true, text: result.text || '压缩完成' };
  } catch (e) {
    if (e?.code === 'session/agent-busy') throw new Error('这个会话正在 dsh 网页版 / 终端里打开着，先在那边关掉再压缩');
    if (e?.name === 'AbortError' || /aborted|超时/.test(String(e?.message || ''))) throw new Error('dsh 压缩超时，请稍后重试');
    throw e;
  } finally {
    await host.stop();
    await waitDshUnlocked(dir, sid).catch(() => {});
  }
}

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
  // /compact 由 claclaw 临时起 dsh web 调 dsh host 原生命令；goal/feedback 仍只能去 dsh web / 终端
  { name: 'compact', description: '压缩会话历史（压缩时会短暂断开）', builtin: true },
  { name: 'cost', description: '本次会话累计 token 和估算费用', builtin: true },
  { name: 'status', description: '当前模型、思考强度和估算费用', builtin: true },
  { name: 'stop', description: '停止当前正在跑的回合', builtin: true },
  { name: 'help', description: '列出可用命令', builtin: true },
];

// ---------- 打开的 DeepSeek 会话：接口和 Claude 的 Runner 对齐 ----------
export const dsRunners = new Map();

// 等某个会话的关闭结束（没有在关就直接返回）
async function waitClosing(sid) {
  const p = closing.get(sid);
  if (!p) return;
  try { await p; } catch {}
}

export class DsRunner {
  constructor(id, { log, onActivity, onTurnDone, onAsk, onCompacted, compact, info, usageEvery }) {
    this.id = id; this.sid = sidOf(id);
    this.log = log; this.onActivity = onActivity; this.onTurnDone = onTurnDone; this.onAsk = onAsk;
    this.onCompacted = onCompacted;
    this.compactFn = compact || dsCompactSession;
    this.info = { sessionId: id, cwd: info?.cwd || '' };
    this.cwd = info?.cwd || '';
    this.title = info?.title || '';
    this.model = '';
    this.mode = 'default'; this.allowedModes = ['default'];
    this.busy = false; this.busySince = 0;
    this.subs = new Set(); this.pending = new Map();
    this.suggestion = null; this.commands = COMMANDS;
    this.closed = false; this.attached = false; this.config = null;
    this.compacting = false;
    this.usageEvery = usageEvery || USAGE_EVERY; this.usageTimer = null; this.usageKey = '';
    this.msgId = null; this.textOpen = false;
    this.queue = [];          // 回复中又发来的消息：这一轮结束（或被中断）后合成一条发出
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
    await waitClosing(this.sid);   // 上一次关闭还没关完就先等它，否则会互相踩 owners
    owners.set(this.sid, this);
    try {
      const r = await rpc('session/resume', { sessionId: this.sid, cwd: this.cwd, mcpServers: [] });
      this.setConfig(r?.configOptions);
      this.attached = true;
    } catch (e) {
      if (owners.get(this.sid) === this) owners.delete(this.sid);
      idleCheck();
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
    if (on) this.startUsageTimer(); else this.stopUsageTimer();
    this.emit({ t: 'busy', on });
    this.onActivity?.(this.id, on ? '思考中' : null);
  }
  // 累计费用（标题栏 ID 后面那个 ≈¥）：每轮结束推一次；长回合里每 2.5 分钟再推一次（dsh 每一步都把 usage 写进日志）
  // 上下文大小（标题栏的压缩提示）：每轮结束推一次；compacted = 这一轮是压缩
  pushCtx(compacted) {
    const c = dsCtx(this.id);
    if (c === this.ctx && !compacted) return;
    this.ctx = c;
    this.emit({ t: 'ctx', tokens: c, ...(compacted ? { compacted: true } : {}) });
  }
  pushUsage() {
    const u = dsUsage(this.id);
    if (!u) return;
    const k = u.messages + ':' + u.costCny;
    if (k === this.usageKey) return;   // 没变就不推
    this.usageKey = k;
    this.emit({ t: 'usage', usage: u });
  }
  startUsageTimer() {
    if (this.usageTimer) return;
    this.usageTimer = setInterval(() => { if (!this.busy || this.closed) this.stopUsageTimer(); else this.pushUsage(); }, this.usageEvery);
    this.usageTimer.unref?.();
  }
  stopUsageTimer() { clearInterval(this.usageTimer); this.usageTimer = null; }
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

  // 不需要 ACP 的本地命令：不会打断当前回合（busy 时用 sys 条显示）
  localCommand(name) {
    const u = dsUsage(this.id);
    const cny = u ? (u.costCny <= 0 ? '0' : u.costCny < 0.01 ? u.costCny.toFixed(4) : u.costCny.toFixed(2)) : '0';
    const n = v => (Number(v) || 0).toLocaleString('en-US');
    if (name === 'cost') {
      if (!u) return '还没有读到 dsh 的 usage；先发一条消息。';
      return '本次会话估算：≈¥' + cny +
        '\n未命中输入 ' + n(u.tokens.uncachedInputTokens) + ' · 缓存命中 ' + n(u.tokens.cacheReadTokens) +
        ' · 输出 ' + n(u.tokens.outputTokens) + ' · 缓存写入 ' + n(u.tokens.cacheWriteTokens) +
        '\n' + u.messages + ' 次请求' + (u.subagents ? '（含 ' + u.subagents + ' 个子代理）' : '') + (u.model ? ' · ' + u.model : '') +
        '\n按公开价估算，不是 DeepSeek 账单。';
    }
    if (name === 'status') {
      const eff = this.config?.find(o => o.id === 'reasoning_effort');
      return '模型：' + (this.model || u?.model || '未知') +
        '\n思考强度：' + (eff?.currentValue || '未知') +
        '\n累计估算：≈¥' + cny;
    }
    if (name === 'help') {
      return '可用命令：\n' + COMMANDS.map(c => '`/' + c.name + (c.hint ? ' ' + c.hint : '') + '` ' + c.description).join('\n') +
        '\n\ndsh 原生的 /goal、/feedback 走 dsh host，当前 ACP 连接接不到；需要到 dsh web 或终端执行。';
    }
    if (name === 'goal' || name === 'feedback') {
      return 'dsh 的 /' + name + ' 走 dsh host，当前 ACP 连接接不到；请到 dsh web 或终端执行。';
    }
    return '';
  }
  // 本地命令的答复要等 server 推完 user 回显（它在 send() 返回后才推）再发：
  // 同步发的话，别的设备上答复排在问题前面，过程播报也会在 turn.done 之后又“开始一轮”
  localReply(fn) {
    setImmediate(() => {
      if (this.closed) return;
      const out = fn();
      if (!out) return;
      if (this.busy) this.emit({ t: 'sys', text: out.replace(/`/g, '') });   // 回合进行中：不结束这一轮，sys 条里不渲染 markdown
      else this.finish({ reason: 'command', text: out });
    });
  }

  send(text, images = []) {
    if (/^\/stop(?:\s|$)/.test(text)) {
      this.localReply(() => {
        if (!this.busy) return '当前没有在跑的回合';
        this.interrupt();
        return '';
      });
      return true;
    }
    const local = text.match(/^\/(cost|status|help|compact|goal|feedback)(?:\s+([\s\S]*))?$/);
    if (local) {
      if (local[1] === 'compact') {
        if ((local[2] || '').trim()) this.localReply(() => '用法：/compact（不带参数）');
        else if (this.compacting) this.localReply(() => '正在压缩，稍等');
        else if (this.busy) this.localReply(() => '这个会话正在跑，等这一轮结束再压缩');
        else setImmediate(() => { this.compact().catch(e => this.finish({ error: '压缩失败：' + e.message })); });
        return true;
      }
      this.localReply(() => this.localCommand(local[1]));
      return true;
    }
    if (this.busy) {
      // ACP 不支持插话：先排队。命令不排队（等这一轮结束再发），最多排 10 条
      if (/^\/(model|effort)\b/.test(text) || this.queue.length >= 10) return false;
      this.queue.push({ text, images });
      return 'queued';
    }
    const cmd = text.match(/^\/(model|effort)(?:\s+(.*))?$/);
    this.lastText = '';
    this.setBusy(true);
    (async () => {
      try {
        await this.attach();
        if (cmd) return this.finish(await this.command(cmd[1], (cmd[2] || '').trim()));
        // ACP 的 image 能力在 initialize 时按 llm.resolveModelInfo(provider,model).inputModalities 决定；
        // 模型不在 dsh 默认目录里时会回退成 text-only。deepseek-v4-flash 需要
        // ~/.dsh/profiles/acp/cordis.patch.yml 里补 inputModalities: [text, image] 才会被声明。
        if (images.length && !caps.promptCapabilities?.image) throw new Error('当前 DeepSeek 模型没有声明图片输入（ACP image=false）。在 dsh 里把模型目录补上 inputModalities: [text, image]（deepseek-v4-flash 本身支持图片），或把图片存到工作区后用 read_image 读；也可以改用 Claude / OpenClaw 发图。');
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
    this.stopUsageTimer();
    this.pushUsage();
    this.pushCtx(reason === 'command' && this.justCompacted);
    this.justCompacted = false;
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

  // 关掉当前 ACP 会话，释放 session.lock；不销毁 runner，压缩完还能 resume 回来
  async detach() {
    if (!this.attached) return;
    this.attached = false;
    if (owners.get(this.sid) === this) owners.delete(this.sid);
    idleCheck();
    const p = rpc('session/close', { sessionId: this.sid }).catch(e => { this.log?.('dsh compact close failed', e.message); });
    closing.set(this.sid, p);
    try { await p; } finally { if (closing.get(this.sid) === p) closing.delete(this.sid); }
  }

  // dsh web 刚退出时锁可能晚一点释放；已经 owned 时短暂重试
  async attachWithRetry() {
    let last;
    for (let i = 0; i < 40; i++) {
      try { await this.attach(); return; } catch (e) {
        last = e;
        if (!/already owned|write handle|别处打开着|正在.*打开/i.test(e.message || '')) throw e;
        await sleep(150);
      }
    }
    throw last;
  }

  // /compact：把这一轮当成“本地命令”，但要做一次真实的会话切换。
  async compact() {
    if (this.closed || this.compacting) return;
    this.compacting = true;
    let compacted = false;
    const wasAttached = this.attached;
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    this.setBusy(true);
    this.onActivity?.(this.id, '压缩中');
    this.emit({ t: 'sys', text: '正在压缩会话历史…压缩期间 dsh 会短暂断开' });
    try {
      if (wasAttached) await this.detach();
      const r = await this.compactFn(this.sid, { log: this.log });
      if (!r || !r.ok) throw new Error(r?.text || '压缩没有成功');
      compacted = true;
      // 还有人看着才恢复 ACP；没人看就等下次打开时新建 runner 接上
      const reattach = wasAttached && this.subs.size > 0;
      if (reattach) await this.attachWithRetry();
      this.compacting = false;
      this.justCompacted = true;
      this.finish({ reason: 'command', text: '压缩完成：' + r.text + (reattach ? '' : '\n\n下次发消息会重新接上压缩后的会话。') });
      if (!this.busy) { try { this.onCompacted?.(this); } catch (e) { this.log?.('dsh compact refresh failed', e.message); } }
    } catch (e) {
      this.compacting = false;
      if (wasAttached && this.subs.size > 0) { try { await this.attachWithRetry(); } catch {} }
      const why = compacted
        ? '压缩完成，但重新接上会话失败：' + (e?.message || e) + '\n重新打开这个会话可看到压缩后的历史。'
        : '压缩失败：' + (e?.message || e);
      this.emit({ t: 'ai.full', text: why });
      this.finish({ error: why });
    }
  }

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
    this.stopUsageTimer();
    dsRunners.delete(this.id);
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

// 新建：在某个目录里开一个新的 dsh 会话
export async function dsNewSession(cwd, opts) {
  await startAcp(opts.log);
  clearTimeout(idleTimer);
  const r = await rpc('session/new', { cwd, mcpServers: [] });
  await waitClosing(r.sessionId);
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

// 改名：ACP 没有 title 能力，但 dsh 的会话记录本身就是追加式事件流（session/title 是最后一条生效）。
// 这里在文件末尾追加一个 zstd 帧；追加前必须先拿到 dsh 自己的 session.lock（flock），
// 否则 dsh web / 终端 / 另一个 ACP 正在写时，seq 会撞车或把日志写坏。
let flockApi;
async function dshFlock() {
  if (flockApi !== undefined) return flockApi;
  try {
    const bin = dshBin();
    if (!bin) throw new Error('没找到 dsh 命令');
    const require = createRequire(bin);
    const file = require.resolve('@deepseek-ai/node-addon-system/flock');
    const mod = await import(pathToFileURL(file).href);
    if (typeof mod.tryLockExclusive !== 'function') throw new Error('dsh 的 flock 模块不可用');
    flockApi = mod;
  } catch {
    flockApi = null;
  }
  return flockApi;
}
export async function dsLockAvailable() { return !!(await dshFlock()); }

async function acquireLease(dir, sid) {
  const api = await dshFlock();
  if (!api) throw Object.assign(new Error('当前环境拿不到 dsh 的会话写入锁，改名暂不可用'), { code: 503 });
  const lockPath = path.join(dir, 'session.lock');
  await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
  let handle = null;
  try {
    handle = await fs.promises.open(lockPath, 'w');
    try { await api.tryLockExclusive(handle.fd); }
    catch (e) {
      if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') throw Object.assign(new Error('这个会话正在 dsh / 终端里使用，先关掉再改名'), { code: 409 });
      if (e.code === 'ERR_FLOCK_UNSUPPORTED_PLATFORM') throw Object.assign(new Error('当前平台不支持 dsh 的会话写入锁，改名暂不可用'), { code: 503 });
      throw e;
    }
    // 和 dsh 一样，锁住 inode 后确认锁文件没被替换
    const held = await handle.stat({ bigint: true });
    const cur = await fs.promises.stat(lockPath, { bigint: true }).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
    if (!cur || cur.ino !== held.ino || cur.dev !== held.dev) throw Object.assign(new Error('会话锁文件被替换，改名取消'), { code: 409 });
    const h = handle; handle = null;
    return { release: () => h.close() };
  } finally {
    if (handle) { try { await handle.close(); } catch {} }
  }
}

// 和 dsh 的 session-title 一样：去控制序列/零宽字符、压成一行、按 UTF-8 字节截断（dsh 默认 80 字节）
const TITLE_MAX_BYTES = 80;
const TITLE_OSC = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu;
const TITLE_CSI = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu;
const TITLE_ESC = /\u001B[@-_]/gu;
const TITLE_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu;
const TITLE_DIR = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu;
function cleanTitle(input) {
  return String(input || '')
    .replace(TITLE_OSC, '').replace(TITLE_CSI, '').replace(TITLE_ESC, '')
    .replace(TITLE_CTRL, '').replace(TITLE_DIR, '')
    .replace(/\s+/gu, ' ').trim();
}
function truncateUtf8(input, maxBytes) {
  if (Buffer.byteLength(input, 'utf8') <= maxBytes) return input;
  let used = 0, out = '';
  for (const ch of input) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (used + n > maxBytes) break;
    out += ch; used += n;
  }
  return out.trimEnd();
}

// 严格读：zstd 帧必须完整、每行必须是 JSON；半帧/坏帧一律拒绝，避免在坏日志后面追加
function unzstdAllStrict(b) {
  const out = [];
  let pos = 0;
  while (pos < b.length) {
    if (b.indexOf(MAGIC, pos) !== pos) return null;
    let from = pos + 4, done = false;
    for (;;) {
      const nx = b.indexOf(MAGIC, from), stop = nx < 0 ? b.length : nx;
      try { out.push(zlib.zstdDecompressSync(b.subarray(pos, stop))); pos = stop; done = true; break; }
      catch { if (nx < 0) break; from = nx + 1; }
    }
    if (!done) return null;
  }
  return Buffer.concat(out).toString('utf8');
}
function readRecordsStrict(file) {
  let buf;
  try { buf = fs.readFileSync(file); } catch (e) { throw Object.assign(new Error('读不了这个会话的记录：' + e.message), { code: 500 }); }
  const text = unzstdAllStrict(buf);
  if (text === null) throw Object.assign(new Error('会话日志末尾不完整，改名取消'), { code: 409 });
  const recs = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { recs.push(JSON.parse(line)); } catch { throw Object.assign(new Error('会话日志里有坏记录，改名取消'), { code: 409 }); }
  }
  if (!recs.length || recs[0].type !== 'session' || ![3, 4].includes(recs[0].version)) throw Object.assign(new Error('不是可识别的 dsh 会话日志'), { code: 409 });
  return recs;
}

// 追加前先备份到 claclaw 回收站；写失败就恢复
function backupSession(file, sid) {
  const dir = path.join(DATA, 'trash');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const base = new Date().toISOString().replace(/[:.]/g, '-') + '_dsh-rename_' + String(sid).replace(/[^A-Za-z0-9-]/g, '');
  const dest = path.join(dir, base + '.jsonl.zstd');
  fs.copyFileSync(file, dest);
  fs.writeFileSync(path.join(dir, base + '.json'), JSON.stringify({ kind: 'dsh-rename', sessionId: sid, from: file, at: new Date().toISOString() }, null, 2), { mode: 0o600 });
  return dest;
}
function appendFrame(file, frame) {
  const fd = fs.openSync(file, 'a');
  try {
    let off = 0;
    while (off < frame.length) {
      const n = fs.writeSync(fd, frame, off, frame.length - off);
      if (!(n > 0)) throw new Error('追加会话标题失败');
      off += n;
    }
    fs.fsyncSync(fd);
  } finally { try { fs.closeSync(fd); } catch {} }
}

export async function dsRename(id, title) {
  if (!dsSupported()) throw new Error(dsUnsupportedReason());
  if (!isDs(id)) throw Object.assign(new Error('不是 DeepSeek 会话'), { code: 400 });
  const sid = sidOf(id);
  const file = fileOf(sid);
  if (!file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  const text = truncateUtf8(cleanTitle(title), TITLE_MAX_BYTES);
  if (!text) throw Object.assign(new Error('名字不能为空'), { code: 400 });
  const runner = dsRunners.get(id);
  if (runner && !runner.closed) {
    if (runner.subs.size) throw Object.assign(new Error('当前会话正在网页里打开着，先切到别的会话再改名'), { code: 409 });
    if (runner.busy) throw Object.assign(new Error('这个会话还在回复，等它结束再改名'), { code: 409 });
    runner.dispose();
    await waitClosing(sid);   // 等 session/close 真正完成，再拿 dsh 的写入锁
  }
  const lease = await acquireLease(path.dirname(file), sid);
  let backup = null;
  try {
    const recs = readRecordsStrict(file);
    let seq = -1;
    for (const r of recs) if (Number.isInteger(r.seq) && r.seq > seq) seq = r.seq;
    backup = backupSession(file, sid);
    const rec = { type: 'session/title', seq: seq + 1, time: Date.now(), data: { title: text, messageSeqs: [], source: { kind: 'user' } } };
    appendFrame(file, zlib.zstdCompressSync(Buffer.from(JSON.stringify(rec) + '\n', 'utf8')));
    recCache.delete(file);
    return { title: text, seq: seq + 1 };
  } catch (e) {
    if (backup) { try { fs.copyFileSync(backup, file); } catch {} }
    throw e;
  } finally {
    try { await lease.release(); } catch {}
  }
}

// 会话目录（删除时整个挪走）
export const dsExists = id => isDs(id) && !!fileOf(sidOf(id));
export function dsSessionDir(id) {
  const f = isDs(id) ? fileOf(sidOf(id)) : null;
  return f ? path.dirname(f) : null;
}

// dsh 的 ACP 进程在不在跑（宿主页用）
export const dsAcpRunning = () => !!proc;
