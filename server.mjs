// claclaw —— 用手机浏览器接管本机的 AI 编程会话（Claude Code / OpenClaw / OpenCode / DeepSeek Harness）。
// 网页服务默认只监听 127.0.0.1 和本机的 Tailscale IP；登录要密码（初始账号 + 最近一次设置，两者都有效）。
// 会话用 Claude Agent SDK 驱动：改文件、跑命令前会问一次，等网页上点「允许 / 拒绝」；
// 原处（终端 / VS Code）闲置够久，网页端才能接管，接管时会核对进程启动时间，避免误杀别的进程。
// 协同（两台电脑的会话互发消息）走局域网上的另一个端口，配对用六位数配对码。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, listSessions, getSessionMessages, renameSession, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as push from './push.mjs';
import * as hosts from './hosts.mjs';
import { isOc, OcRunner, ocRunners, ocSessionList, ocRename, ocDelete, ocGatewayUp, ocCreate } from './openclaw.mjs';
import { hostInfo, slowInfo } from './host.mjs';
import { ttsVoices, ttsSynth, ttsWarm } from './tts.mjs';
import { markLast, nextPeerNo, ourBaseName, ourInbox, ourRelays, peerRelays, relayOf as relayOfPeer, RELAYS_HEADER, parseRelaysHeader, applyAdvert, discover, peerCall, loadPeer, savePeer, myName, newToken, hashToken, newId, findPeerByToken, lanIp, ourBase, PAIR_TTL, pendingList, addPending, getPending, dropPending, applyListener, peerStatus, callPeer, probeRelay, peerRoute, notePairFail, clearPairFails, pairHoldState, PEER_BASE } from './peer.mjs';
import { isDs, DsRunner, dsRunners, dsSessionList, dsNewSession, dsShutdown, dsSessionDir, dsAcpRunning, dsExists, dsSupported, dsUnsupportedReason, dsRename } from './dsh.mjs';
import * as skills from './skills.mjs';
import { isOp, OpRunner, opRunners, opSessionList, opNewSession, opShutdown, opAcpRunning, opExists, opDelete, opTakeoverInfo, opEndHolders, opInstalled, opRename, opSupported, opUnsupportedReason } from './opencode.mjs';
const STARTED_AT = Date.now();
setTimeout(() => { try { trimTrash(); } catch {} }, 5000);   // 回收站：启动时也清一次过期备份
setTimeout(() => slowInfo(path.dirname(fileURLToPath(import.meta.url))).catch(() => {}), 3000);
import { DATA, verify, verifyMaster, setLastSet, setupMaster, isSetUp, describeCredential, issueToken, checkToken, revokeToken, TOKEN_TTL_MS, writeJsonAtomic } from './auth.mjs';
import { readBody } from './httpbody.mjs';

// 监听地址：默认 127.0.0.1 + 本机的 Tailscale IPv4；绝不绑 0.0.0.0。
// CLACLAW_HOST 可以写逗号分隔的列表覆盖默认值
function tailscaleIp() {
  for (const bin of ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const ip = execFileSync(bin, ['ip', '-4'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n')[0];
      if (/^100\./.test(ip)) return ip;
    } catch {}
  }
  return null;
}
// https 地址：Tailscale 的 MagicDNS 名字 + tailscale serve 时可用；拿不到就没有（页面上不显示跳转链接）
function httpsUrl() {
  for (const bin of ['tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale']) {
    try {
      const st = JSON.parse(execFileSync(bin, ['status', '--json'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString());
      const name = String(st?.Self?.DNSName || '').replace(/\.$/, '');
      const serve = execFileSync(bin, ['serve', 'status'], { timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      if (name && serve.includes('https://' + name)) return 'https://' + name;
      return null;
    } catch {}
  }
  return null;
}
let HTTPS_URL = null, httpsCheckedAt = 0;
function getHttpsUrl() {
  if (Date.now() - httpsCheckedAt > 60_000) { HTTPS_URL = httpsUrl(); httpsCheckedAt = Date.now(); }
  return HTTPS_URL;
}

const HOSTS = process.env.CLACLAW_HOST
  ? process.env.CLACLAW_HOST.split(',').map(x => x.trim()).filter(Boolean)
  : ['127.0.0.1', tailscaleIp()].filter(Boolean);
if (HOSTS.some(h => h === '0.0.0.0' || h === '::')) throw new Error('不允许监听所有网卡');
// 端口：命令行 --port / -p 优先，其次环境变量 CLACLAW_PORT，默认 8787
function argPort() {
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const m = a[i].match(/^--port=(.+)$/);
    if (m) return m[1];
    if (a[i] === '--port' || a[i] === '-p') return a[i + 1];
  }
}
const PORT = Number(argPort() ?? process.env.CLACLAW_PORT ?? 8787);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) throw new Error('端口不合法：' + (argPort() ?? process.env.CLACLAW_PORT));
const ROOT = path.dirname(fileURLToPath(import.meta.url));
// 多宿主：别的宿主交回通知用的地址（这台的 Tailscale IP + 端口）
const SELF_URL = (ip => ip ? `http://${ip}:${PORT}` : '')(HOSTS.find(h => /^100\./.test(h)));
// 这台被别的 claclaw 添加了：通知先交给它发（它没发出去，push.sendAll 再自己发）
push.setRelay(async payload => {
  const list = hosts.relays();
  if (!list.length) return 0;
  const sent = await Promise.all(list.map(r => fetch(r.url + '/api/push/relay', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-claclaw-relay': r.token },
    body: JSON.stringify({ payload }), signal: AbortSignal.timeout(5000),
  }).then(x => x.ok ? x.json() : {}).then(j => Number(j.sent) || 0).catch(() => 0)));
  return sent.reduce((a, b) => a + b, 0);
});
const REGISTRY = path.join(os.homedir(), '.claude', 'sessions');
const HOME = os.homedir();

// 网页上可切换的基本模式；原会话用的是别的模式（比如 bypassPermissions）时，
// 网页继承它，并把它加进这个会话可切换的列表里 —— 只对该会话有效，不会凭空给出 bypass
const MODES = ['default', 'acceptEdits', 'plan'];
const ALL_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];

// 原会话在原处（VS Code / 终端）最后一次用的权限模式：从会话记录末尾往前找 user 记录的 permissionMode，
// 跳过网页（entrypoint=sdk-ts）自己写的，否则网页用过一次就把原来的模式盖掉了
function originalMode(file) {
  let fd;
  try { fd = fs.openSync(file, 'r'); } catch { return null; }
  try {
    const CHUNK = 4 << 20;
    let pos = fs.fstatSync(fd).size, carry = Buffer.alloc(0);
    while (pos > 0) {
      const start = Math.max(0, pos - CHUNK);
      const buf = Buffer.alloc(pos - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      pos = start;
      let all = Buffer.concat([buf, carry]);
      // 块首那半行留到下一轮拼完整再解析（按字节切，避免把多字节字符切坏）
      if (pos > 0) { const nl = all.indexOf(10); carry = all.subarray(0, nl < 0 ? all.length : nl); all = nl < 0 ? Buffer.alloc(0) : all.subarray(nl + 1); }
      const lines = all.toString('utf8').split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const l = lines[i];
        if (!l.includes('"permissionMode"')) continue;
        try {
          const o = JSON.parse(l);
          if (o.type === 'user' && o.permissionMode && o.entrypoint !== 'sdk-ts' && ALL_MODES.includes(o.permissionMode)) return o.permissionMode;
        } catch {}
      }
    }
  } finally { fs.closeSync(fd); }
  return null;
}
const OUT_MAX = 4000;
// 发图：前端会先压缩到长边 2000px 以内；这里再兜底限制张数和单张大小（base64 字符数）
const MAX_IMAGES = 5;
const MAX_IMAGE_B64 = 7 * 1024 * 1024;
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
// 历史记录里的图片总量上限，超过的只显示占位，免得打开会话时传几十 MB
const HISTORY_IMAGE_BUDGET = 4 * 1024 * 1024;
// 历史分页：打开时只发最后一页（约一屏），往上滑再按页要更早的；服务器最多保留最近 HISTORY_KEEP 条
const HISTORY_PAGE = 30, HISTORY_MORE = 40, HISTORY_KEEP = 600;
// 网页里的会话没人看、也没在跑多久后关掉进程（会话记录还在）；可在设置里改，默认 10 分钟
const idleCloseMs = () => minutesSetting('idleCloseMin', 10, 1) * 60_000;
// 新建后还没发过消息的会话：Claude Code 要等第一条消息才建会话文件，关掉就什么都不剩，所以多留一会儿
const IDLE_CLOSE_NEW_MS = 30 * 60_000;
// 原处（VS Code / 终端）闲置满这么久，网页端才能接管；反方向（原处收回）任何时候都行
// 可在设置里改，默认 30 分钟（环境变量 CLACLAW_TAKEOVER_MIN 仍可给默认值）
const takeoverMin = () => minutesSetting('takeoverMin', Number(process.env.CLACLAW_TAKEOVER_MIN ?? 30), 0);
function minutesSetting(key, dflt, min) {
  const v = Number(settings()[key]);
  return Number.isFinite(v) && v >= min && v <= 1440 ? v : dflt;
}
const WATCH_MS = 3000;

// 去掉从父 Claude 会话继承来的 CLAUDE* 变量，否则子进程会被当成那个会话的子进程，
// 不登记到 ~/.claude/sessions/，也收不到别的会话的消息（阶段 0 实测）
const CHILD_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
// 额度接近上限时 Claude Code 默认不出建议回复；这个开关让它在「接近上限」时也照常出（到上限仍然不出）
CHILD_ENV.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'true';

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- 会话登记表：判断某个会话是不是正被终端 / VS Code 占用 ----------

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function liveRegistry() {
  const map = new Map();
  let files = [];
  try { files = fs.readdirSync(REGISTRY).filter(f => f.endsWith('.json')); } catch {}
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(REGISTRY, f), 'utf8'));
      if (o.sessionId && pidAlive(o.pid)) {
        const list = map.get(o.sessionId) || [];
        list.push({ pid: o.pid, entrypoint: o.entrypoint, status: o.status, name: o.name, procStart: o.procStart, statusUpdatedAt: o.statusUpdatedAt || 0 });
        map.set(o.sessionId, list);
      }
    } catch {}
  }
  return map;
}

// 同一个会话在登记表里、但不是 claclaw 自己起的进程
function foreignHolders(sessionId, live = liveRegistry()) {
  const ours = runners.get(sessionId)?.childPid;
  return (live.get(sessionId) || []).filter(r => r.pid !== ours && !(r.entrypoint === 'sdk-ts' && isOurChild(r.pid)));
}

// 同一个进程的父进程不会变：查一次就记住，别每次都 fork 一个 ps
const childCache = new Map();   // pid → 父进程 pid（只记查成功的）
function isOurChild(pid) {
  const hit = childCache.get(pid);
  if (hit != null) return hit === process.pid;
  try {
    const ppid = Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim());
    if (Number.isFinite(ppid)) childCache.set(pid, ppid);
    return ppid === process.pid;
  } catch { return false; }
}

// 原处最近一次活跃：会话文件最后修改时间 和 登记表状态变化时间 取较晚的
function lastActive(holder, jsonlPath) {
  let mtime = 0;
  try { mtime = fs.statSync(jsonlPath).mtimeMs; } catch {}
  return Math.max(mtime, holder.statusUpdatedAt || 0);
}

function takeoverInfo(sessionId, jsonlPath, live) {
  const holders = foreignHolders(sessionId, live);
  if (!holders.length) return null;
  // 展示优先取「不空闲」的那个持有者（status / entrypoint / name 都跟着它）；都空闲时取第一个
  const h = holders.find(x => x.status !== 'idle') || holders[0];
  const idleMin = Math.floor((Date.now() - Math.max(...holders.map(x => lastActive(x, jsonlPath)))) / 60000);
  const allIdle = holders.every(x => x.status === 'idle');
  return {
    pids: holders.map(x => x.pid), entrypoint: h.entrypoint, name: h.name, status: h.status,
    idleMin, canTakeover: allIdle && idleMin >= takeoverMin(), needMin: takeoverMin(),
  };
}

// 防 pid 被复用：登记表里的 procStart 就是 UTC 下的 ps lstart
function sameProcess(holder) {
  try {
    const lstart = execFileSync('ps', ['-o', 'lstart=', '-p', String(holder.pid)], { env: { ...process.env, TZ: 'UTC' } }).toString();
    const norm = x => String(x).replace(/\s+/g, ' ').trim();
    return !holder.procStart || norm(lstart) === norm(holder.procStart);
  } catch { return false; }
}

async function endHolders(sessionId) {
  const holders = foreignHolders(sessionId);
  for (const h of holders) {
    if (!sameProcess(h)) { log('skip pid', h.pid, 'procStart mismatch'); continue; }
    log('takeover: SIGTERM', h.pid, h.entrypoint, h.name);
    try { process.kill(h.pid, 'SIGTERM'); } catch {}
  }
  for (let i = 0; i < 50; i++) {
    if (!holders.some(h => pidAlive(h.pid))) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  for (const h of holders) if (pidAlive(h.pid)) { log('takeover: SIGKILL', h.pid); try { process.kill(h.pid, 'SIGKILL'); } catch {} }
  await new Promise(r => setTimeout(r, 300));
  return !holders.some(h => pidAlive(h.pid));
}

// 会话最后一条用户消息：Claude Code 每轮都往会话文件末尾写 {"type":"last-prompt"}，只读文件尾部找最后一条；按文件大小 + 修改时间缓存
const lastPromptCache = new Map();
function lastPromptOf(file) {
  let st; try { st = fs.statSync(file); } catch { return ''; }
  const key = st.size + ':' + st.mtimeMs, c = lastPromptCache.get(file);
  if (c && c.key === key) return c.text;
  let text = '';
  try {
    const n = Math.min(st.size, 512 * 1024), buf = Buffer.alloc(n), fd = fs.openSync(file, 'r');
    try { fs.readSync(fd, buf, 0, n, st.size - n); } finally { fs.closeSync(fd); }
    const lines = buf.toString('utf8').split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"last-prompt"')) continue;
      try { text = String(JSON.parse(lines[i]).lastPrompt || ''); break; } catch {}
    }
  } catch {}
  text = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  lastPromptCache.set(file, { key, text });
  return text;
}
function jsonlPathOf(info) {
  // ~/.claude/projects/<cwd 中非字母数字换成 -> /<id>.jsonl
  return path.join(HOME, '.claude', 'projects', String(info.cwd || '').replace(/[^A-Za-z0-9]/g, '-'), info.sessionId + '.jsonl');
}

// ---------- 把工具调用整理成卡片要显示的东西 ----------

function relPath(p, cwd) {
  if (typeof p !== 'string') return '';
  if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1);
  if (p === HOME) return '~';
  if (p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length);
  return p;
}

const LOGIN_TOOL = 'mcp__claclaw__set_web_login';

function toolTarget(name, input, cwd) {
  input = input || {};
  if (name === LOGIN_TOOL) return '网页登录改成：' + (input.username ? '用户名 ' + input.username : '用户名留空') + '，' + (input.password ? '密码 ' + '•'.repeat(String(input.password).length) : '密码留空');
  if (name === 'Bash') return input.command || '';
  if (input.file_path) return relPath(input.file_path, cwd);
  if (input.notebook_path) return relPath(input.notebook_path, cwd);
  if (input.pattern) return input.pattern + (input.path ? '  ' + relPath(input.path, cwd) : '');
  if (input.url) return input.url;
  if (input.query) return input.query;
  if (input.description) return input.description;
  if (input.skill) return input.skill;
  if (input.to) return '→ ' + input.to;
  const s = Object.values(input).find(v => typeof v === 'string');
  return s ? s.slice(0, 200) : '';
}

function splitLines(s, max) {
  const lines = String(s ?? '').split('\n');
  return lines.length > max ? lines.slice(0, max).concat(['… 还有 ' + (lines.length - max) + ' 行']) : lines;
}

// 返回 [[' '|'+'|'-', text], ...]；没有 diff 可看的工具返回 null
function toolDiff(name, input) {
  input = input || {};
  if (name === 'Edit') {
    return [
      ...splitLines(input.old_string, 200).map(l => ['-', l]),
      ...splitLines(input.new_string, 200).map(l => ['+', l]),
    ];
  }
  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    return input.edits.flatMap((e, i) => [
      ...(i ? [[' ', '⋯']] : []),
      ...splitLines(e.old_string, 80).map(l => ['-', l]),
      ...splitLines(e.new_string, 80).map(l => ['+', l]),
    ]);
  }
  if (name === 'Write') return splitLines(input.content, 300).map(l => ['+', l]);
  return null;
}

function resultText(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) s = content.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : '')).join('\n');
  return s.length > OUT_MAX ? s.slice(0, OUT_MAX) + '\n… 已截断' : s;
}

function userText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(b => b.type === 'text').map(b => b.text).join('\n');
  return '';
}

// 系统注入的提示、斜杠命令包装等不是用户真正打的字，不显示
function isNoise(text) {
  const t = text.trim();
  return !t || /^<(system-reminder|command-|local-command|task-notification|ide_|user-prompt-submit-hook)/.test(t) || t.startsWith('Caveat:');
}

// 别的会话通过跨会话消息发来的：Claude Code 把正文包在 <cross-session-message> 里，前后再加给 Claude 看的说明和安全提示。
// 网页上只显示发送者和正文
// 一条里可能排了好几条，全部取出；不是跨会话消息返回空数组
function peerMessages(text) {
  return [...String(text || '').matchAll(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g)].map(m => {
    const attr = k => (m[1].match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
    return { from: attr('from-name') || attr('from'), text: m[2].trim() };
  });
}

// ---------- 历史消息 → 前端条目 ----------

// 打开会话时的历史记录：大会话要把整个记录文件读一遍（100MB 级的要 0.7 秒），
// 所以按「文件大小 + 修改时间」缓存，没变就直接用；列表刷新时顺手把最近几个会话预读好。
// 缓存里带着完整的 base64 图片（发给网页的那一页有 4MB 预算，但缓存里是全量），
// 最多 40 个会话的话内存能到上百 MB。所以除了条数上限，再加一个总字节上限，超了就从最旧的开始淘汰。
const HISTORY_CACHE_MAX = 64 * 1024 * 1024;
const historyCache = new Map();   // sessionId → { key, items, bytes }
let historyCacheBytes = 0;
// 估算一段历史的体积：图片按 base64 数据的长度算（内存里就占这么多）
function historyBytes(items) {
  let n = 0;
  for (const it of items) {
    n += 64;                                   // 这条记录本身的开销
    if (it.text) n += it.text.length;
    if (it.images) for (const im of it.images) n += (im?.data?.length || 0) + 64;
  }
  return n;
}
async function loadHistoryCached(sessionId, cwd) {
  let key = null;
  try { const st = fs.statSync(jsonlPathOf({ sessionId, cwd })); key = st.size + ':' + st.mtimeMs; } catch {}
  const hit = historyCache.get(sessionId);
  if (key && hit && hit.key === key) return hit.hist;
  const hist = await loadHistory(sessionId, cwd);   // { items, total }
  if (key) {
    if (hit) { historyCache.delete(sessionId); historyCacheBytes -= hit.bytes || 0; }
    const bytes = historyBytes(hist.items || []);
    historyCache.set(sessionId, { key, hist, bytes });
    historyCacheBytes += bytes;
    while (historyCache.size > 40 || historyCacheBytes > HISTORY_CACHE_MAX) {
      const first = historyCache.keys().next().value;
      if (first === undefined) break;
      const v = historyCache.get(first);
      historyCache.delete(first);
      historyCacheBytes -= v?.bytes || 0;
    }
  }
  return hist;
}
let prewarming = false;
async function prewarmHistory(list) {
  if (prewarming) return;
  prewarming = true;
  try { for (const s of list.slice(0, 6)) if (s.cwd && !s.unsent) await loadHistoryCached(s.id, s.cwd); } catch {} finally { prewarming = false; }
}

// 干活中途插话（Claude 还在回复时又发的消息）：会话文件里记成 attachment「queued_command」，
// SDK 的 getSessionMessages 不返回它们，所以自己从文件里找出来，按在文件里的位置插回历史
function queuedPrompts(sessionId, cwd) {
  let text = '';
  try { text = fs.readFileSync(jsonlPathOf({ sessionId, cwd }), 'utf8'); } catch { return { lineOf: new Map(), queued: [], timeOf: new Map() }; }
  const lineOf = new Map(), queued = [], timeOf = new Map();
  let i = 0;
  for (const line of text.split('\n')) {
    const k = line.lastIndexOf('"uuid":"');
    if (k >= 0) {
      const id = line.slice(k + 8, line.indexOf('"', k + 8));
      lineOf.set(id, i);
      const ts = line.match(/"timestamp":"([^"]+)"/);   // 每条记录的时间：聊天里显示消息时间
      if (ts) { const t = Date.parse(ts[1]); if (t) timeOf.set(id, t); }
      // 插话被吸收进这一轮时，SDK 用 source_uuid 合成一条用户消息（文件里没有这个 uuid 的行）：时间取插话那一刻
      const su = line.match(/"source_uuid":"([^"]+)"/);
      if (su && ts && !timeOf.has(su[1])) { const t = Date.parse(ts[1]); if (t) timeOf.set(su[1], t); }
    }
    if (line.includes('"queued_command"')) {
      try {
        const o = JSON.parse(line), pr = o.attachment?.prompt;
        if (o.attachment?.type === 'queued_command' && pr) queued.push({ i, text: typeof pr === 'string' ? pr : userText(pr), at: Date.parse(o.timestamp) || undefined });   // 带图片时是内容块数组
      } catch {}
    }
    i++;
  }
  return { lineOf, queued, timeOf };
}

async function loadHistory(sessionId, cwd) {
  const msgs = await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined);
  const items = [];
  const toolIdx = new Map();
  const { lineOf, queued, timeOf } = queuedPrompts(sessionId, cwd);
  const pushQueued = q => {
    const peers = peerMessages(q.text);
    if (peers.length) for (const p of peers) items.push({ kind: 'peer', from: p.from, text: p.text, at: q.at });
    else if (!isNoise(q.text)) items.push({ kind: 'user', text: q.text, queued: true, at: q.at });
  };
  let qi = 0;
  for (const m of msgs) {
    const at = lineOf.get(m.uuid);
    if (at != null) while (qi < queued.length && queued[qi].i < at) pushQueued(queued[qi++]);
    if (m.parent_tool_use_id) continue; // 子 Agent 内部的消息不展开
    const content = m.message?.content;
    const n0 = items.length;
    if (m.type === 'user') {
      if (Array.isArray(content)) {
        for (const b of content) {
          if (b.type === 'tool_result' && toolIdx.has(b.tool_use_id)) {
            const it = items[toolIdx.get(b.tool_use_id)];
            it.status = b.is_error ? 'no' : 'ok';
            it.output = resultText(b.content);
          }
        }
      }
      const t = userText(content);
      const peers = peerMessages(t);
      if (peers.length) { for (const p of peers) items.push({ kind: 'peer', from: p.from, text: p.text, at: timeOf.get(m.uuid) }); continue; }
      const imgs = Array.isArray(content) ? content.filter(b => b.type === 'image' && b.source?.type === 'base64') : [];
      if (imgs.length && !/<command-name>/.test(t)) {
        items.push({ kind: 'user', text: isNoise(t) ? '' : t, images: imgs.map(b => b.source), at: timeOf.get(m.uuid) });
        continue;
      }
      const cmd = t.match(/<command-name>\s*(\/?[^<\s]+)\s*<\/command-name>/);
      if (cmd) {
        // 用户执行过的斜杠命令：记录里被包成 <command-name>…</command-name><command-args>…</command-args>
        const args = (t.match(/<command-args>([\s\S]*?)<\/command-args>/) || [])[1] || '';
        items.push({ kind: 'user', text: (cmd[1].startsWith('/') ? cmd[1] : '/' + cmd[1]) + (args.trim() ? ' ' + args.trim() : '') });
      } else if (!isNoise(t)) items.push({ kind: 'user', text: t });
    } else if (m.type === 'assistant' && Array.isArray(content)) {
      for (const b of content) {
        if (b.type === 'text' && b.text.trim()) items.push({ kind: 'ai', text: b.text });
        else if (b.type === 'tool_use') {
          toolIdx.set(b.id, items.length);
          items.push({ kind: 'tool', id: b.id, name: b.name, target: toolTarget(b.name, b.input, cwd), diff: toolDiff(b.name, b.input), status: 'ok' });
        }
      }
    }
    const t = timeOf.get(m.uuid);
    if (t) for (let k = n0; k < items.length; k++) if (items[k].kind !== 'tool') items[k].at = t;
  }
  while (qi < queued.length) pushQueued(queued[qi++]);
  // 插话没赶上这一轮、变成下一轮的正式消息时，文件里两种记录都有：只留正式的那条
  const dedup = items.filter((x, k) => !(x.queued && items.slice(Math.max(0, k - 8), k + 9).some(y => y !== x && !y.queued && y.kind === 'user' && y.text === x.text)));
  dedup.forEach(x => { delete x.queued; });
  return { items: dedup.slice(-HISTORY_KEEP), total: dedup.length };
}

// 取一页：before 之前（绝对序号，不含）最多 count 条；图片按页从新到旧分预算，超出的给 null（前端显示占位）
function historyPage(h, before, count) {
  const base = h.total - h.items.length;
  const end = Math.max(0, Math.min(h.items.length, before - base));
  const start = Math.max(0, end - count);
  const page = h.items.slice(start, end);
  let budget = HISTORY_IMAGE_BUDGET;
  for (let i = page.length - 1; i >= 0; i--) {
    if (!page[i].images) continue;
    page[i] = { ...page[i], images: page[i].images.map(src => {
      if (budget < src.data.length) return null;
      budget -= src.data.length;
      return 'data:' + src.media_type + ';base64,' + src.data;
    }) };
  }
  return { items: page, start: base + start, more: start > 0 };
}

// ---------- Runner：一个被网页打开的会话 = 一个常驻的 SDK query ----------

const runners = new Map(); // sessionId -> Runner

// 网页里打开的会话才有这个工具：用户在对话里说「把网页登录改成 001 002」，Claude 调它。
// 调用照常走权限确认（手机上会弹「允许」），不会静默修改。
function claclawMcp(sessionId) {
  return createSdkMcpServer({
    name: 'claclaw',
    version: '1.0.0',
    tools: [
      tool(
        'set_web_login',
        '修改 claclaw 网页（就是用户现在用来和你对话的这个手机网页）的登录用户名和密码。' +
        '只在用户明确要求改网页登录用户名/密码时调用，例如「把用户密码改成 001 002」= username 001、password 002。' +
        '用户名和密码各自可以留空（传空字符串），但至少要有一个；用户说「只要密码 xxx」就 username 传空。' +
        '以本说明为准：如果之前的对话里出现过别的限制（例如必须有用户名、有 admin 初始账号），那些已经过时。' +
        '只保留最后一次设置的这一组；用户首次打开网页时设置的初始账号始终有效，不受影响。回复里不要复述密码。',
        { username: z.string().default('').describe('新的用户名，不要用户名就传空字符串'), password: z.string().default('').describe('新的密码，不要密码就传空字符串') },
        async ({ username, password }) => {
          try {
            const r = setLastSet(username, password);
            log('web login changed via chat');
            return { content: [{ type: 'text', text: '已改好：' + describeCredential(r) + '。下次登录生效，初始账号仍然可用。' }] };
          } catch (e) {
            return { content: [{ type: 'text', text: '修改失败：' + e.message }], isError: true };
          }
        },
        { alwaysLoad: true },
      ),
      // claclaw 协同：只有加入协同的会话能用（每次调用时检查，设置改了立刻生效）
      tool(
        'peer_sessions',
        '查看能对话的其他 AI 会话：本机 claclaw 里的会话（Claude / DeepSeek / OpenCode / OpenClaw，local 一栏），以及协同对方（另一台已配对的电脑）开放的会话（peers 一栏）。' +
        '只在用户要你和「别的会话 / 对方 / 另一台电脑的会话」沟通时使用。peer 填「本机」只列本机，填对方名字只列那个对方，不填两边都列。',
        { peer: z.string().optional().describe('「本机」或对方名字，可省略') },
        async ({ peer }) => {
          const j = await peerListCore({ fromId: sessionId, to: peer });
          return j.ok ? { content: [{ type: 'text', text: JSON.stringify({ local: j.local, peers: j.peers, note: j.peerNote }, null, 2) }] } : { content: [{ type: 'text', text: j.error }], isError: true };
        },
        { alwaysLoad: true },
      ),
      tool(
        'peer_send',
        '给另一个 AI 会话发一条消息，等它这一轮回复完，返回回复原文（最多等 10 分钟）。peer 填「本机」就是发给本机 claclaw 里的会话（session 必填，peer_sessions 的 local 一栏）；填对方名字或不填就是发给协同对方（另一台已配对的电脑）。' +
        '用于和对方的会话沟通、提问、交付结果。消息要言简意赅：只写对方需要的信息，不寒暄、不复述。不要在消息里发送密码、令牌、密钥。' +
        '有多个已配对对方时用 peer 指定名字；对方有多个会话时用 session 指定（peer_sessions 列出的 id），只有一个时可以不填。',
        { text: z.string().describe('消息正文，4000 字以内'), peer: z.string().optional().describe('「本机」或对方名字；只配对了一个对方时可省略'), session: z.string().optional().describe('目标会话 id（peer_sessions 列出的）；发给本机时必填') },
        async ({ text, peer, session }) => {
          const j = await peerSendCore({ fromId: sessionId, to: peer, session, text });
          return { content: [{ type: 'text', text: j.ok ? j.reply : (j.peer ? '对方返回错误：' : '') + j.error }], isError: !j.ok };
        },
        { alwaysLoad: true },
      ),
    ],
  });
}

// ---------- claclaw 协同：收件 ----------
// 只在本机浏览器（127.0.0.1 直连，不经 tailscale serve 之类的代理）打开时能改配置
function isLocalReq(req) {
  const ip = req.socket.remoteAddress || '';
  const host = String(req.headers.host || '').replace(/:\d+$/, '');
  return /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip) && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(host)
    && !req.headers['x-forwarded-for'] && !Object.keys(req.headers).some(k => k.startsWith('tailscale-'));
}
// 某个对方能看到的会话：协同会话池 ∩ 开放给它的（没单独设过 = 全部开放）
const peerAllowed = (c, p) => Array.isArray(p?.allow) ? c.sessions.filter(id => p.allow.includes(id)) : c.sessions;
// 协同会话可以是任意 Claw 的：Claude（UUID）、DeepSeek（ds:）、OpenCode（op:）、OpenClaw（oc:）
const PEER_SID = /^([0-9a-f-]{36}|(ds|op|oc):\S{1,200})$/;
const clawOfId = id => isDs(id) ? 'deepseek' : isOp(id) ? 'opencode' : isOc(id) ? 'openclaw' : 'claude';
const runnerOf = id => (isDs(id) ? dsRunners : isOp(id) ? opRunners : isOc(id) ? ocRunners : runners).get(id);
// 给对方看的短 ID（对方用它的开头匹配会话）：Claude 取前 8 位；DeepSeek / OpenCode 保留前缀再取 8 位；OpenClaw 的 key 本来就短，原样给
const peerShortId = id => { const m = id.match(/^(ds:(?:session-)?|op:(?:ses_)?)/); return m ? id.slice(0, m[0].length + 8) : isOc(id) ? id : id.slice(0, 8); };
// 某个对方能看到的会话（统一成 {sessionId, claw, title, cwd}；Claude 的还带着 SDK 原来的字段，送消息时要用）
async function peerSessionInfos(c, p) {
  const ids = peerAllowed(c, p), lists = {};
  const load = {
    claude: () => listSessions({ includeProgrammatic: true, limit: 2000 }),
    deepseek: () => dsSessionList({ busy: x => !!dsRunners.get(x)?.busy }),
    opencode: () => opSessionList({ busy: x => !!opRunners.get(x)?.busy, takeoverMin: takeoverMin() }),
    openclaw: () => ocSessionList(log),
  };
  const out = [];
  for (const id of ids) {
    const claw = clawOfId(id);
    if (!lists[claw]) { try { lists[claw] = await load[claw](); } catch { lists[claw] = []; } }   // 某个 Claw 读不了（网关没开等）：它的会话先不列
    const list = lists[claw];
    if (claw === 'claude') { const s = list.find(x => x.sessionId === id); if (s) out.push({ ...s, claw, title: s.customTitle || s.summary || '' }); }
    else { const s = list.find(x => x.id === id); if (s) out.push({ sessionId: id, claw, title: s.title || '', cwd: s.cwd || '' }); }
  }
  return out;
}
// 回复是不是 Claude Code 的额度用完提示：只认以这句提示开头、整段不超过 120 字的回复（正文里提到这句话不算）
function quotaHit(text) {
  if (!text || text.length > 120) return null;
  if (!/^\s*(you['’]?ve hit your [a-z ]*limit|claude usage limit reached)/i.test(text)) return null;
  const m = text.match(/resets?\s+(?:at\s+)?([^\n·|]+)/i);
  return { resets: m ? m[1].trim() : '' };
}
// 把对方的消息送进会话，收集这一轮的回复
// 找到（没有就拉起）接收协同消息的会话进程；各 Claw 的进程对外接口一样：subscribe / send / emit / turn.done
// ---------- 会话找会话：本机四个 Claw 之间、以及跨电脑（协同）----------
// Claude 会话的 peer_sessions / peer_send 工具、本机命令 claclaw-peer 共用这一套。
// 发起方必须认得出是哪个会话（fromId）：本机命令没带 --from 时，按「命令在哪个目录跑 + 哪个会话正在回复」自动认；认不出就拒绝。
// 规矩：本机的会话之间都能互相找；找另一台电脑，发起的会话要在协同池里，且只能找开放了它的对方。
// （这是用法上的规矩，不是安全边界：本机以你的身份运行的程序本来就读得到 claclaw 的数据。）
const LOCAL_NAMES = ['本机', 'local'];
const isLocalTo = to => LOCAL_NAMES.includes(String(to || '').trim().toLowerCase());
const CLAW_LABEL = { claude: 'Claude', deepseek: 'DeepSeek', opencode: 'OpenCode', openclaw: 'OpenClaw' };
const realp = p => { try { return fs.realpathSync(p); } catch { return p; } };
function allRunners() {
  return [[runners, 'claude'], [dsRunners, 'deepseek'], [opRunners, 'opencode'], [ocRunners, 'openclaw']]
    .flatMap(([m, claw]) => [...m.values()].filter(r => !r.closed).map(r => ({ r, claw })));
}
// 本机所有会话（统一成 {sessionId, claw, title, cwd}；Claude 的带着 SDK 原字段）
async function localSessions() {
  const out = [];
  const add = async (claw, load) => { let l = []; try { l = await load(); } catch {} return l; };
  for (const s of await add('claude', () => listSessions({ includeProgrammatic: true, limit: 2000 }))) out.push({ ...s, claw: 'claude', title: s.customTitle || s.summary || s.firstPrompt || '' });
  for (const [claw, load] of [['deepseek', () => dsSessionList({ busy: x => !!dsRunners.get(x)?.busy })], ['opencode', () => opSessionList({ busy: x => !!opRunners.get(x)?.busy, takeoverMin: takeoverMin() })], ['openclaw', () => ocSessionList(log)]]) {
    if (!detectClaws().some(c => c.id === claw && c.installed && c.supported)) continue;
    for (const s of await add(claw, load)) out.push({ sessionId: s.id, claw, title: s.title || '', cwd: claw === 'openclaw' ? '' : s.cwd || '', lastModified: s.lastModified || 0 });
  }
  return out;
}
async function findLocalSession(prefix) {
  const k = String(prefix || '').trim().toLowerCase();
  if (k.length < 6) return { error: '会话 ID 太短，至少写 6 位' };
  const hit = (await localSessions()).filter(s => s.sessionId.toLowerCase().startsWith(k));
  if (hit.length === 1) return { info: hit[0] };
  return { error: hit.length ? '有多个会话的 ID 以「' + prefix + '」开头，写长一点' : '本机没有这个会话：' + prefix };
}
// 自动认发起方：命令在哪个目录跑（AI 的命令就在它会话的目录里跑）+ 哪个会话正在回复
function callerCandidates(cwd) {
  const c = cwd ? realp(cwd) : '', busy = allRunners().filter(x => x.r.busy);
  const byDir = busy.filter(x => x.claw !== 'openclaw' && c && (() => { const d = realp(x.r.cwd || x.r.info?.cwd || ''); return d && (c === d || c.startsWith(d + path.sep)); })());
  return (byDir.length ? byDir : busy.filter(x => x.claw === 'openclaw')).map(x => x.r.id);
}
async function resolveFrom(from, cwd) {
  if (from) {
    const r = runnerOf(from);
    if (r) return { id: from };
    const f = await findLocalSession(from);
    return f.info ? { id: f.info.sessionId } : { error: '--from 的会话认不出：' + f.error };
  }
  const c = callerCandidates(cwd);
  if (c.length === 1) return { id: c[0] };
  return { error: c.length ? '认不出是哪个会话在发（同时有 ' + c.length + ' 个会话在回复）：用 --from 写上你的会话 ID' : '认不出是哪个会话在发：只有 claclaw 里正在回复的会话能自动认出来，其他情况用 --from 写上你的会话 ID' };
}
function senderLabel(fromId) {
  const r = runnerOf(fromId);
  return (r?.info?.customTitle || r?.info?.summary || r?.title || '会话') + '（' + CLAW_LABEL[clawOfId(fromId)] + ' · ' + peerShortId(fromId) + '）';
}
// 用到时自动装技能（不用用户点）：非 Claude 的 Claw 一用上就装好 claclaw-peer，AI 才知道怎么找别的会话
function ensureSkill(claw) {
  if (!claw || claw === 'claude' || skills.stateAt('claclaw-peer', 'agents') !== 'none') return;
  try { skills.install('claclaw-peer', 'agents'); log('skill auto-installed claclaw-peer →', claw); } catch (e) { log('skill auto-install failed', e.message); }
}
async function peerListCore({ fromId, to } = {}) {
  const out = { ok: true };
  if (!to || isLocalTo(to)) {
    // 本机：claclaw 里开着的、24 小时内有动静的会话，最近的在前，最多 40 个（全部会话太多；更早的直接写 ID 也能发）
    const recent = Date.now() - 24 * 3600e3, open = new Set(allRunners().map(x => x.r.id));
    const at = s => Math.max(s.lastModified || 0, webActive[s.sessionId] || 0, open.has(s.sessionId) ? Date.now() : 0);
    out.local = (await localSessions())
      .filter(s => s.sessionId !== fromId && at(s) > recent)
      .sort((a, b) => at(b) - at(a)).slice(0, 40)
      .map(s => ({ id: peerShortId(s.sessionId), title: String(s.title || '').replace(/\s+/g, ' ').slice(0, 60), claw: s.claw, busy: !!runnerOf(s.sessionId)?.busy }));
    if (isLocalTo(to)) return out;
  }
  const c = loadPeer();
  if (!c.enabled) { out.peerNote = 'claclaw 协同没有开启，只能找本机的会话'; return out; }
  if (fromId && !c.sessions.includes(fromId)) { out.peerNote = '这个会话没有加入 claclaw 协同，只能找本机的会话'; return out; }
  const list = c.peers.filter(p => p.inbox && p.theirToken && (!to || p.name === to) && (!fromId || peerAllowed(c, p).includes(fromId)));
  if (!list.length) { if (to) return { ok: false, error: '没有叫「' + to + '」的已配对对方' }; out.peerNote = '还没有可以联系的已配对对方'; return out; }
  out.peers = [];
  for (const p of list) {
    try { const j = await peerCall(c, p, '/sessions', { ms: 15000 }); out.peers.push({ peer: p.name, ok: j.ok, sessions: j.sessions, error: j.error }); }
    catch (e) { out.peers.push({ peer: p.name, ok: false, error: e.message }); }
  }
  return out;
}
const localBusy = new Set();
async function peerSendCore({ fromId, to, session, text }) {
  text = String(text || '').trim();
  if (!text) return { ok: false, error: '消息是空的' };
  if (!fromId) return { ok: false, error: '认不出是哪个会话在发' };
  if (isLocalTo(to)) {
    if (!session) return { ok: false, error: '找本机的会话要写 --session（会话 ID，list 里有）' };
    const f = await findLocalSession(session);
    if (!f.info) return { ok: false, error: f.error };
    if (f.info.sessionId === fromId) return { ok: false, error: '不能发给自己' };
    const id = f.info.sessionId;
    if (localBusy.has(id) || peerBusy.has(id)) return { ok: false, error: '对方会话上一条还在处理，稍后再发' };
    localBusy.add(id);
    log('local send', peerShortId(fromId), '→', peerShortId(id), text.length + ' chars');
    try {
      const [code, obj] = await peerDeliver(f.info, text.slice(0, 4000), senderLabel(fromId), null, { local: true, fromId });
      return obj.ok ? { ok: true, peer: '本机 · ' + (f.info.title || peerShortId(id)), reply: obj.reply || '（对方这一轮没有文字回复）' } : { ok: false, error: obj.error || 'HTTP ' + code, code: obj.code, resets: obj.resets };
    } finally { localBusy.delete(id); }
  }
  const c = loadPeer();
  if (!c.enabled) return { ok: false, error: 'claclaw 协同没有开启（本机的会话可以用 --to 本机 找）' };
  if (!c.sessions.includes(fromId)) return { ok: false, code: 'not-joined', error: '这个会话没有加入 claclaw 协同，不能找另一台电脑（本机的会话可以用 --to 本机 找）' };
  const can = c.peers.filter(p => p.inbox && p.theirToken && peerAllowed(c, p).includes(fromId));   // 只有把这个会话开放给它的对方
  const p = to ? can.find(x => x.name === to) : can.length === 1 ? can[0] : null;
  if (!p) return { ok: false, error: to ? '没有叫「' + to + '」的已配对对方' : can.length ? '有多个已配对对方，指定一个：' + can.map(x => x.name).join('、') : '还没有可以联系的已配对对方' };
  const r = runnerOf(fromId);
  const from = (r?.info?.customTitle || r?.info?.summary || r?.title || '会话') + ' · ' + myName(c);
  try {
    // msg_id：这条消息的编号，对方据此去重（同一个编号收到两次只投递一次）；from_session：对方要事后回复时找哪个会话
    const msgId = crypto.randomUUID();
    const j = await peerCall(c, p, '', { body: { msg_id: msgId, from, from_session: peerShortId(fromId), text: text.slice(0, 4000), session: session || undefined } });
    log('peer send', peerShortId(fromId), '→', p.name, j.ok ? (j.accepted || j.status === 202 ? 'accepted' : 'ok') : 'fail');
    markLast(fromId, p.id);
    // 202 / accepted：对方收到了，但这一轮没等到回复——回复会由对方另发一条消息，开头写「回复 <编号>」。别重发
    if (j.ok && (j.status === 202 || j.accepted)) return { ok: true, accepted: true, peer: p.name, id: j.id || msgId, reply: '对方已收到（编号 ' + (j.id || msgId) + '），回复稍后会单独发来，开头写「回复 ' + (j.id || msgId) + '」。不用重发。' + (j.note ? '（' + j.note + '）' : '') };
    return j.ok ? { ok: true, peer: p.name, reply: j.reply || '（对方这一轮没有文字回复）' } : { ok: false, peer: p.name, error: j.error || '未知', code: j.code, resets: j.resets };
  } catch (e) { return { ok: false, error: e.message }; }
}
// 本机命令发的消息可能要等很久（对方最多 10 分钟）：命令先等一阵，没等到就给个任务号，之后凭任务号取
const localJobs = new Map();   // job → { promise, at }
async function waitJob(job, sec) {
  const j = localJobs.get(job);
  if (!j) return { ok: false, error: '没有这个任务（任务号不对，或已经过期）' };
  const res = await Promise.race([j.promise, new Promise(r => setTimeout(() => r(null), sec * 1000))]);
  if (!res) return { pending: true, job };
  localJobs.delete(job);
  return res;
}
async function handleLocal(req, res, url) {
  const ip = req.socket.remoteAddress || '';
  if (!/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ip) || req.headers['x-forwarded-for'] || !skills.checkLocal(req.headers['x-claclaw-local'])) return sendJson(res, 403, { ok: false, error: '只接受本机带令牌的请求' });
  for (const [k, v] of localJobs) if (Date.now() - v.at > 30 * 60e3) localJobs.delete(k);
  const q = url.searchParams, wait = Math.max(5, Math.min(Number(q.get('wait')) || 110, 280));
  if (url.pathname === '/api/local/peer/result') return sendJson(res, 200, await waitJob(q.get('job') || '', wait));
  if (url.pathname === '/api/local/peer/whoami') {
    const f = await resolveFrom(q.get('from') || '', q.get('cwd') || '');
    if (!f.id) return sendJson(res, 200, { ok: false, error: f.error });
    const r = runnerOf(f.id);
    return sendJson(res, 200, { ok: true, id: f.id, claw: clawOfId(f.id), title: r?.info?.customTitle || r?.info?.summary || r?.title || '', pool: loadPeer().sessions.includes(f.id) });
  }
  if (url.pathname === '/api/local/peer/list') {
    const f = await resolveFrom(q.get('from') || '', q.get('cwd') || '');
    if (!f.id) return sendJson(res, 200, { ok: false, error: f.error });
    return sendJson(res, 200, await peerListCore({ fromId: f.id, to: q.get('to') || '' }));
  }
  if (url.pathname === '/api/local/peer/send' && req.method === 'POST') {
    let b = {}; try { b = JSON.parse(await readBody(req, 64 * 1024)); } catch {}
    const f = await resolveFrom(String(b.from || '').trim(), String(b.cwd || ''));
    if (!f.id) return sendJson(res, 200, { ok: false, error: f.error });
    const job = crypto.randomBytes(4).toString('hex');
    localJobs.set(job, { at: Date.now(), promise: peerSendCore({ fromId: f.id, to: String(b.to || '').trim(), session: String(b.session || '').trim(), text: b.text }) });
    return sendJson(res, 200, await waitJob(job, Math.max(5, Math.min(Number(b.wait) || 110, 280))));
  }
  return sendJson(res, 404, { ok: false, error: 'not found' });
}
// 别的 Claw 的会话列表也标上协同：加入了协同（紫框）、最近和哪个对方通信（名字底色）
function peerMark(list) {
  const pc = loadPeer(), on = new Set(pc.enabled ? pc.sessions : []);
  return list.map(x => {
    const l = pc.last?.[x.id], p = l && pc.peers.find(y => y.id === l.peer);
    return { ...x, peer: on.has(x.id) || undefined, peerLast: p ? { id: p.id, no: p.no, color: p.color, name: p.name, at: l.at } : undefined };
  });
}
async function peerRunner(info) {
  const id = info.sessionId;
  if (isDs(id)) {
    let r = dsRunners.get(id);
    if (!r) { if (!dsExists(id)) return [404, { ok: false, error: '会话不存在' }]; r = new DsRunner(id, dsOpts()); dsRunners.set(id, r); r.history(); }   // history() 顺带读出会话目录，发消息要用
    return r;
  }
  if (isOp(id)) {
    let r = opRunners.get(id);
    if (!r) {
      if (opTakeoverInfo(id, takeoverMin())) return [409, { ok: false, error: '这个会话正在对方电脑的终端里使用，暂时收不了消息' }];
      if (!opExists(id)) return [404, { ok: false, error: '会话不存在' }];
      r = new OpRunner(id, dsOpts()); opRunners.set(id, r); r.history();
    }
    return r;
  }
  if (isOc(id)) {
    let r = ocRunners.get(id);
    if (!r) {
      r = new OcRunner(id, { log, onActivity: setActivity, onTurnDone: ocTurnDone }); ocRunners.set(id, r);
      try { await r.open(); } catch (e) { r.dispose(); return [502, { ok: false, error: '连不上 OpenClaw 网关：' + e.message }]; }
    }
    return r;
  }
  if (!runners.has(id)) {
    if (info.cwd && !fs.existsSync(info.cwd)) return [410, { ok: false, error: '会话目录已不存在' }];
    if (takeoverInfo(id, jsonlPathOf(info), liveRegistry())) return [409, { ok: false, error: '这个会话正在对方电脑的终端 / VS Code 里使用，暂时收不了消息' }];
    const inherited = inheritedMode(info);
    runners.set(id, new Runner(info, inherited, MODES.includes(inherited) ? MODES : [...MODES, inherited]));
  }
  return runners.get(id);
}
async function peerDeliver(info, text, from, peerId, { local = false } = {}) {
  if (peerId) markLast(info.sessionId, peerId);
  const id = info.sessionId;
  const r = await peerRunner(info);
  if (Array.isArray(r)) return r;
  if (r.busy) return [409, { ok: false, error: '这个会话正在忙，稍后再发' }];
  // 开头写明它自己的会话 ID 和主动找别的会话的办法：Claude 会话用内置工具，其他 Claw 用 claclaw-peer 技能（用到时自动装好）
  const claw = info.claw || clawOfId(id);
  ensureSkill(claw);
  const how = claw === 'claude' ? 'peer_send 工具' : 'claclaw-peer 技能';
  const hint = '你的会话 ID：' + id + '；这一轮的回复会自动传回给' + (local ? '它' : '对方') + '，要主动找别的会话用 ' + how + '；';
  const msg = (local ? '【claclaw 本机 · 来自会话：' : '【claclaw 协同 · 来自对方：') + from + '（' + hint + '来信长的话先提炼要点再处理；回复言简意赅，只写结果或必要的问题）】\n' + text;
  // 协同消息到了：没人正看着这个会话就推一条通知（点开直接进这个会话）
  if (!r.watched()) {
    localSound();
    const badge = markUnread(id);
    push.sendAll({ title: (local ? '会话消息 · ' : '协同消息 · ') + (from || '对方'), body: snippet(text, '发来一条消息'), tag: 'peer-msg-' + id, url: '/?s=' + id, badge }, log)
      .then(n => log('peer msg push →', n)).catch(() => {});
  }
  return new Promise(resolve => {
    let reply = '', cur = '', done = false;
    const sub = { readyState: 1, visible: false, send(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'ai.start') cur = '';
      else if (m.t === 'ai.delta') cur += m.text || '';
      else if (m.t === 'ai.end') { if (cur.trim()) reply = cur; cur = ''; }
      else if (m.t === 'ai.full') { if (m.text?.trim()) reply = m.text; }
      else if (m.t === 'turn.done') {
        const out = (cur.trim() || reply).trim();
        // 额度用完时 Claude Code 把「You've hit your session limit · resets 6:10pm」当普通回复吐出来，
        // 原样转给对方会被当成「已回复」。识别出来改成明确的错误，对方据此到点重发。
        const q = info.claw === 'claude' || !info.claw ? quotaHit(out) : null;   // 额度提示的格式只认 Claude 的
        if (q) return end(429, { ok: false, code: 'quota_exhausted', error: '对方 Claude 额度已用完，消息未处理' + (q.resets ? '，' + q.resets + ' 恢复，之后请重发' : '，请稍后重发'), resets: q.resets || null, raw: out });
        end(200, { ok: m.subtype === 'success', reply: out, error: m.error });
      }
    } };
    const end = (code, obj) => { if (done) return; done = true; clearTimeout(timer); r.unsubscribe(sub); resolve([code, obj]); };
    const timer = setTimeout(() => end(504, { ok: false, error: '10 分钟内没等到回复', partial: (cur || reply).trim() }), 10 * 60 * 1000);
    r.subscribe(sub);
    r.send(msg);
    r.emit({ t: 'user', text: msg, images: [] });
  });
}
const peerBusy = new Set();
const peerSeen = new Map();   // 对方 id:msg_id → { at, result }：去重
const cleanIp = ip => String(ip || '').replace(/^::ffff:/, '');
async function peerHandler(req, res) {
  const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const c = loadPeer();
  const u = new URL(req.url, 'http://x');
  const sub = u.pathname.replace(/\/+$/, '');
  if (!c.enabled || (sub !== PEER_BASE && !sub.startsWith(PEER_BASE + '/'))) { log('peer reject 404', cleanIp(req.socket.remoteAddress), req.method, u.pathname.slice(0, 80)); res.writeHead(404); return res.end(); }
  const route = sub.slice(PEER_BASE.length) || '/';
  // 经中继隧道进来的请求：隧道就跑在本机（来源是本机地址），真正的来源 IP 在 x-forwarded-for 里（中继填的）
  const sockIp = cleanIp(req.socket.remoteAddress), fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = fwd && /^[\d.:a-f]+$/i.test(fwd) && (sockIp === '127.0.0.1' || sockIp === '::1' || sockIp === lanIp()) ? cleanIp(fwd) : sockIp;
  const readJson = async () => { try { return JSON.parse(await readBody(req, 64 * 1024)); } catch { return null; } };
  try {
    // 1. 配对申请：谁都可以申请，但要我们这边的人把两位数配对码告诉对方才能完成
    if (route === '/pair') {
      if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST' });
      const b = await readJson() || {};
      const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || ip;
      const okUrl = u => /^https?:\/\/\S+$/i.test(String(u || '')) ? String(u).slice(0, 2000) : '';
      const inbox = okUrl(b.inbox), inboxAlt = okUrl(b.inboxAlt);   // 对方的名字地址（.local）和 IP 地址
      let p; try { p = addPending(name, ip, inbox); p.inboxAlt = inboxAlt; p.relays = (Array.isArray(b.relays) ? b.relays : [b.relay]).map(okUrl).filter(Boolean).slice(0, 5); } catch (e) { return out(e.code || 400, { ok: false, error: e.message }); }   // relay：对方的中继地址（跨网络时用）
      log('peer pair request from', ip, name);
      // 开着的网页也提醒一下（App 在前台时 iPhone 不弹推送横幅）
      { const msg = JSON.stringify({ t: 'peer.pair', name, ip, code: p.code }); for (const w of wss.clients) if (w.readyState === 1) w.send(msg); }
      localSound();
      push.sendAll({ title: 'claclaw 协同', body: name + '（' + ip + '）申请配对，配对码 ' + p.code, tag: 'peer-pair', url: '/?view=peer' }, log)
        .then(n => log('peer pair push sent →', n)).catch(e => log('peer pair push failed', e.message));
      return out(200, { ok: true, requestId: p.id, expiresIn: Math.round(PAIR_TTL / 1000), message: '已提交配对申请：请向对方要两位数配对码，然后调用 pair/confirm' });
    }
    if (route === '/pair/confirm') {
      if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST' });
      const b = await readJson() || {};
      const rid = String(b.requestId || '');
      // 输错后的冷却：输错的一方一直显示「配对中」，到时才告诉它失败；别人这时也配不了
      const hold = pairHoldState(rid);
      if (hold?.done) return out(403, { ok: false, failed: true, error: '配对码错误，配对失败' });
      if (hold) return hold.mine ? out(202, { ok: false, pairing: true, retryIn: Math.ceil(hold.left / 1000) }) : out(429, { ok: false, error: '正在配对中，稍后再试' });
      const p = getPending(rid);
      if (!p) return out(404, { ok: false, error: '配对申请不存在或已过期，请重新申请' });
      if (String(b.code || '').trim() !== p.code) {
        dropPending(p.id);
        const wait = notePairFail(p.id);
        log('peer pair wrong code from', ip, 'hold', wait / 1000 + 's');
        return out(202, { ok: false, pairing: true, retryIn: Math.ceil(wait / 1000) });
      }
      dropPending(p.id);
      clearPairFails();
      const token = newToken();
      const theirToken = typeof b.token === 'string' && b.token.length >= 16 ? b.token.slice(0, 200) : '';
      const c2 = loadPeer();
      c2.peers = c2.peers.filter(x => !(p.inbox && (x.inbox === p.inbox || x.inboxAlt === p.inbox)));   // 同一个对方重新配对：替换旧的
      c2.peers.push({ id: newId(), no: nextPeerNo(c2), name: p.name, ip: p.ip, inbox: p.inbox, inboxAlt: p.inboxAlt || '', relays: p.relays || [], tokenHash: hashToken(token), theirToken, pairedAt: Date.now(), lastSeen: Date.now() });
      savePeer(c2);
      log('peer paired', p.ip, p.name, theirToken ? 'two-way' : 'one-way');
      return out(200, { ok: true, token, name: myName(c2), ...ourInbox(c2) });
    }
    // 2. 配对后的正常收发：请求头带钥匙
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const peer = findPeerByToken(c, auth);
    if (!peer) { log('peer reject 401', ip, req.method, route, auth ? 'bad token' : 'no token'); return out(401, { ok: false, error: '还没配对，或钥匙不对：先 POST ' + PEER_BASE + '/pair 申请配对' }); }
    // 对方带来了它当前的中继地址（主 → 备）：和记的不一样就更新（对方换中继、加备用都不用重新配对）
    let dirty = false;
    if (RELAYS_HEADER in req.headers) {
      const rs = parseRelaysHeader(req.headers[RELAYS_HEADER]);
      if (rs && JSON.stringify(rs) !== JSON.stringify(peerRelays({ relays: peer.relays, relay: peer.relay }))) { peer.relays = rs; delete peer.relay; dirty = true; log('peer relays updated', peer.name, rs.length); }
    }
    if (dirty || peer.ip !== ip || Date.now() - (peer.lastSeen || 0) > 60000) { peer.ip = ip; peer.lastSeen = Date.now(); savePeer(c); }
    const infos = await peerSessionInfos(c, peer);
    const brief = infos.map(s => ({ id: peerShortId(s.sessionId), title: s.title, claw: s.claw, busy: !!runnerOf(s.sessionId)?.busy }));
    if (route === '/sessions') return out(200, { ok: true, name: myName(c), sessions: brief });
    if (route !== '/') return out(404, { ok: false, error: '没有这个接口' });
    if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST 发消息' });
    let body = ''; try { body = await readBody(req, 64 * 1024); } catch { return out(413, { ok: false, error: '消息太长' }); }
    let text = body, from = '', want = '';
    let msgId = '';
    try { const j = JSON.parse(body); text = j.text; from = String(j.from || '').replace(/\s+/g, ' ').slice(0, 60); want = String(j.session || ''); msgId = String(j.msg_id || '').slice(0, 100); } catch {}
    // 去重：同一个对方、同一个 msg_id 30 分钟内再来，直接给上次的结果（还在处理就等同一个结果），不再投递
    const dupKey = msgId && peer.id + ':' + msgId;
    for (const [k, v] of peerSeen) if (Date.now() - v.at > 30 * 60e3) peerSeen.delete(k);
    if (dupKey && peerSeen.has(dupKey)) { log('peer dup', peer.name, msgId.slice(0, 12)); const [code, obj] = await peerSeen.get(dupKey).result; return out(code, obj); }
    text = String(text || '').trim();
    if (!text) return out(400, { ok: false, error: '消息是空的' });
    if (text.length > 4000) return out(413, { ok: false, error: '消息太长（最多 4000 字）' });
    const info = want ? infos.find(s => s.sessionId.toLowerCase().startsWith(want.toLowerCase())) : infos.length === 1 ? infos[0] : null;
    if (!info) return out(400, { ok: false, error: want ? '没有这个会话' : '有多个会话，用 session 指定一个', sessions: brief });
    if (peerBusy.has(info.sessionId)) return out(429, { ok: false, error: '上一条还在处理，稍后再发' });
    peerBusy.add(info.sessionId);
    log('peer in', peer.name, ip, '→', info.sessionId.slice(0, 8), text.length + ' chars');
    const result = peerDeliver(info, text, peer.name + (from && from !== peer.name ? ' · ' + from : ''), peer.id);
    if (dupKey) peerSeen.set(dupKey, { at: Date.now(), result });
    try {
      const [code, obj] = await result;
      if (dupKey && !(code < 300 || code === 504)) peerSeen.delete(dupKey);   // 没送达（忙、出错）的不记：同一个编号重发要能再投递
      out(code, obj);
    } finally { peerBusy.delete(info.sessionId); }
  } catch (e) { out(500, { ok: false, error: e.message }); }
}
// 我们向对方发起的配对（只放内存）
let outPair = null;   // {base, requestId, token, expiresAt}
function peerPublic(c, local) {
  return {
    local, enabled: c.enabled, port: c.port, dir: c.dir, sessions: c.sessions, name: myName(c), relay: ourRelays(c)[0] || '', relays: ourRelays(c),
    relayInvite: relayInvitesOf(c).length > 0, relayList: relayList(c), relayState: relayList(c)[0] || { status: 'off' },
    // 「复制邀请」里给对方的：让我们也能主动找他（含注册口令，只在本机打开时给）
    relayTunnelCmd: local && relayInvitesOf(c)[0] && clarelay ? clarelay.tunnelCommand(relayInvitesOf(c)[0], '<你本机收消息的服务地址>') : '',
    ip: lanIp(), base: ourBase(c), baseName: ourBaseName(c), ...peerStatus(),
    pending: pendingList().map(p => ({ id: p.id, name: p.name, ip: p.ip, two: !!p.inbox, expiresAt: p.expiresAt, code: local ? p.code : undefined })),
    peers: c.peers.map(p => ({ id: p.id, no: p.no, color: p.color, name: p.name, relay: local ? relayOfPeer(p) : !!relayOfPeer(p), relays: local ? peerRelays(p) : peerRelays(p).length, allow: Array.isArray(p.allow) ? p.allow : null, ip: p.ip, inbox: p.inbox, inboxAlt: p.inboxAlt, canCall: !!(p.inbox && p.theirToken), pairedAt: p.pairedAt, lastSeen: p.lastSeen })),
    outPair: outPair && outPair.expiresAt > Date.now() ? { base: outPair.base, expiresAt: outPair.expiresAt, pairing: !!outPair.pairing } : null,
  };
}
setTimeout(() => { const c = loadPeer(); applyListener(c, peerHandler, log); applyAdvert(c, log); applyRelay(c); }, 1000);

// ---------- 跨网络：经 clarelay 中继 ----------
// 协同页粘贴一次中继邀请码（clarelay1.…），claclaw 自己在后台连隧道，把公开地址 + 证书指纹存成「中继地址」，配对时告诉对方。
// clarelay 是独立项目：装成 npm 包，或者放在 claclaw 旁边的 ../clarelay 目录；都没有就提示。
let clarelay = null;
const relayTuns = new Map();   // 邀请码 → { to, t, state: { status, error } }   status: connecting | online | offline | error
// 中继邀请码（主 → 备）：兼容旧的单个 relayInvite
const relayInvitesOf = c => (Array.isArray(c.relayInvites) ? c.relayInvites : c.relayInvite ? [c.relayInvite] : []).filter(Boolean);
const relayHostOf = inv => { try { return new URL(clarelay.parseInvite(inv).relay).host; } catch { return '?'; } };
async function loadClarelay() {
  if (clarelay) return clarelay;
  for (const p of ['clarelay/tunnel.mjs', pathToFileURL(path.join(ROOT, '..', 'clarelay', 'tunnel.mjs')).href]) {
    try { return clarelay = await import(p); } catch {}
  }
  return null;
}
// 每个中继一条隧道（主备同时在线：切换、换中继都不断）；连好后把各自的中继地址按主 → 备存进 relays，配对和每次请求都告诉对方
let relayChain = Promise.resolve();
const applyRelay = c => (relayChain = relayChain.then(() => applyRelayNow(c)).catch(e => log('relay apply failed', e.message)));
async function applyRelayNow(c) {
  const to = (ourBase(c) || '').replace(new RegExp(PEER_BASE + '$'), '');   // 隧道转给本机的协同收件服务（局域网 IP + 协同端口）
  const invites = c.enabled && to ? relayInvitesOf(c) : [];
  for (const [inv, r] of relayTuns) if (!invites.includes(inv) || r.to !== to) { try { r.t?.stop(); } catch {} relayTuns.delete(inv); }
  const mod = invites.length ? await loadClarelay() : null;
  for (const inv of invites) {
    if (relayTuns.has(inv)) continue;
    const cur = { to, state: { status: 'connecting' } };
    relayTuns.set(inv, cur);
    if (!mod) { cur.state = { status: 'error', error: '没找到 clarelay：把它放在 claclaw 旁边的 clarelay 目录，或用 npm 装上' }; continue; }
    try {
      const t = await mod.startTunnel({
        invite: inv, to, state: path.join(DATA, 'relay-tunnel.json'), log,
        onStatus: st => { if (relayTuns.get(inv) === cur) cur.state = { status: st.online ? 'online' : 'offline', error: st.error }; },
      });
      if (relayTuns.get(inv) !== cur) { t.stop(); continue; }
      cur.t = t; cur.state = { status: 'online' };
      cur.addr = t.urlFor ? t.urlFor(PEER_BASE) : t.publicUrl + PEER_BASE + (t.pin ? '#pin=' + t.pin : '');   // clarelay 0.2：带 #pin=…&key=…（端到端加密）
      log('relay tunnel online', relayHostOf(inv));
    } catch (e) { cur.state = { status: 'error', error: e.message }; log('relay tunnel failed', e.message); }
  }
  // 存地址：连不上的那个沿用上次的地址（名字存在隧道状态文件里，重启不变）
  const c2 = loadPeer(), old = c2.relayAddrOf || {}, map = {};
  for (const inv of relayInvitesOf(c2)) { const a = relayTuns.get(inv)?.addr || old[inv]; if (a) map[inv] = a; }
  let relays = relayInvitesOf(c2).map(inv => map[inv]).filter(Boolean);
  // 有中继这次没连上、也没记过它的地址：保留原来对外公布的地址（中继重启时公开地址不变），别让对方以为我们没有中继
  if (relays.length < relayInvitesOf(c2).length) for (const a of (c2.relays || [])) if (!relays.includes(a)) relays.push(a);
  if (JSON.stringify(relays) !== JSON.stringify(c2.relays || []) || JSON.stringify(map) !== JSON.stringify(old)) {
    c2.relayAddrOf = map; c2.relays = relays; c2.relay = relays[0] || ''; savePeer(c2);
  }
}
const relayList = c => relayInvitesOf(c).map((inv, i) => ({ i, host: clarelay ? relayHostOf(inv) : '', primary: i === 0, ...(relayTuns.get(inv)?.state || { status: c.enabled ? 'connecting' : 'off' }) }));

class Runner {
  constructor(info, mode, allowedModes, opts = {}) {
    this.id = info.sessionId;
    this.info = info;
    // 新建的会话：用预先分配的 sessionId 开新会话，而不是 resume（第一条消息之前还没有会话文件）
    this.isNew = !!opts.isNew;
    this.createdAt = Date.now();
    this.allowedModes = allowedModes;
    this.cwd = info.cwd;
    this.title = info.summary;
    this.mode = mode;
    this.busy = false;
    this.subs = new Set();
    this.pending = new Map(); // requestId -> { resolve, input, suggestions, card }
    this.queue = [];
    this.wake = null;
    this.closeTimer = null;
    this.closed = false;
    this.textOpen = false;
    this.start();
  }

  start() {
    const self = this;
    const inbox = {
      async *[Symbol.asyncIterator]() {
        while (!self.closed) {
          while (self.queue.length) yield self.queue.shift();
          await new Promise(r => (self.wake = r));
        }
      },
    };
    this.q = query({
      prompt: inbox,
      options: {
        ...(this.isNew ? { sessionId: this.id, ...(this.info.customTitle ? { title: this.info.customTitle } : {}) } : { resume: this.id }),
        cwd: this.cwd,
        permissionMode: this.mode,
        // 只有继承来的模式就是 bypass 时才放开（SDK 要求显式同意才能进 bypass）
        allowDangerouslySkipPermissions: this.allowedModes.includes('bypassPermissions'),
        includePartialMessages: true,
        // 每轮结束后由 Claude Code 生成一条「下一句可能要说的话」，在网页输入框里做成提示
        promptSuggestions: true,
        // 不传 settingSources = 和 CLI 一样加载 user + project + local，网页会话与原会话的权限完全一致
        env: CHILD_ENV,
        mcpServers: { claclaw: claclawMcp(this.id) },
        canUseTool: (name, input, o) => this.askPermission(name, input, o),
        stderr: d => log('[stderr]', this.id.slice(0, 8), String(d).trim().slice(0, 300)),
      },
    });
    // init 要等第一条消息才来，命令列表不能等它：一打开就取（init 到了再按「仅终端可用」过滤一遍）
    this.loadCommands();
    this.pump().catch(e => {
      log('runner error', this.id.slice(0, 8), e?.message);
      this.emit({ t: 'error', message: '会话进程出错：' + (e?.message || e) });
    }).finally(() => this.dispose(this.closeReason));
  }

  emit(ev) {
    const s = JSON.stringify({ ...ev, sessionId: this.id });
    for (const ws of this.subs) if (ws.readyState === 1) ws.send(s);
    this.trackActivity(ev);
  }

  // 会话列表里显示的「正在做什么」（3～4 个字）；所有打开的页面都会收到，可以同时看多个会话的状态
  trackActivity(ev) {
    let a = this.activity;
    switch (ev.t) {
      case 'user': case 'tool.result': case 'perm.done': a = '思考中'; break;
      case 'ai.start': case 'ai.delta': a = '回复中'; break;
      case 'tool.start': a = toolActivity(ev.name); break;
      case 'perm.request': a = '等你确认'; break;
      case 'busy': a = ev.on ? (a || '思考中') : null; break;
      case 'turn.done': if (!this.busy) a = null; break;
      case 'session.closed': a = null; break;
      default: return;
    }
    if (!this.busy && ev.t !== 'perm.request') a = ev.t === 'user' ? '思考中' : null;
    if (a !== this.activity) { this.activity = a; setActivity(this.id, a); }
  }

  async pump() {
    for await (const m of this.q) {
      if (m.parent_tool_use_id) continue;
      // 不是从网页发消息开始的一轮（别的会话发来消息、定时任务等）：一有输出就算「在干活」，
      // 否则网页显示成空闲、没有工作状态，空闲关闭还可能把干到一半的进程关掉
      if (!this.busy && (m.type === 'stream_event' || m.type === 'assistant')) {
        this.busy = true; this.busySince = Date.now(); this.cancelClose();
        log('busy (started elsewhere)', this.id.slice(0, 8));
        this.emit({ t: 'busy', on: true });
      }
      if (m.type === 'stream_event') {
        const e = m.event;
        if (e.type === 'message_start' && e.message?.id) (this.streamed ||= new Set()).add(e.message.id);
        if (e.type === 'content_block_start' && e.content_block?.type === 'text') {
          this.textOpen = true; this.emit({ t: 'ai.start' });
        } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && this.textOpen) {
          this.emit({ t: 'ai.delta', text: e.delta.text });
        } else if (e.type === 'content_block_stop' && this.textOpen) {
          this.textOpen = false; this.emit({ t: 'ai.end' });
        }
      } else if (m.type === 'assistant') {
        // /context 这类本地命令的输出是一条整段的 assistant 消息，没有流式片段，要整段发
        if (!this.streamed?.has(m.message?.id)) {
          const text = (m.message?.content || []).filter(b => b.type === 'text').map(b => b.text).join('\n');
          if (text.trim()) this.emit({ t: 'ai.full', text });
        }
        for (const b of m.message?.content || []) {
          if (b.type === 'tool_use') {
            this.emit({ t: 'tool.start', id: b.id, name: b.name, target: toolTarget(b.name, b.input, this.cwd), diff: toolDiff(b.name, b.input) });
          }
        }
      } else if (m.type === 'user') {
        const content = m.message?.content;
        if (Array.isArray(content)) {
          for (const b of content) {
            if (b.type === 'tool_result') this.emit({ t: 'tool.result', id: b.tool_use_id, output: resultText(b.content), isError: !!b.is_error });
          }
        }
        const peers = peerMessages(userText(content));
        for (const p of peers) this.emit({ t: 'peer', from: p.from, text: p.text });
        if (!peers.length && m.origin?.kind === 'peer') this.emit({ t: 'peer', from: m.origin.name || m.origin.from || '', text: '' });
      } else if (m.type === 'system') {
        if (m.subtype === 'init') {
          this.mode = m.permissionMode || this.mode;
          this.childPid = (liveRegistry().get(this.id) || []).find(r => r.entrypoint === 'sdk-ts' && isOurChild(r.pid))?.pid;
          log('init', this.id.slice(0, 8), 'mode', this.mode, 'model', m.model);
          this.terminalOnly = new Set(m.terminal_slash_commands || []);
          this.loadCommands();
        } else if (m.subtype === 'peer_message_hold') {
          const who = m.from_name || m.from || '另一个会话';
          if (m.state === 'held') this.emit({ t: 'sys', text: who + ' 发来一条消息，因权限模式不同被扣住，需要批准（网页端暂不支持批准）' });
          else this.emit({ t: 'sys', text: who + ' 的消息：' + (m.outcome || m.state) });
        } else if (m.subtype === 'local_command_output') {
          // /cost、/context 这类本地命令的输出
          this.emit({ t: 'cmd.out', text: String(m.content || '') });
        } else if (m.subtype === 'compact_boundary') {
          const c = m.compact_metadata || {};
          const k = n => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n ?? '?'));
          this.emit({ t: 'sys', text: (c.trigger === 'auto' ? '已自动压缩会话历史' : '已压缩会话历史') + '（' + k(c.pre_tokens) + (c.post_tokens != null ? ' → ' + k(c.post_tokens) : '') + ' tokens）' });
        } else if (m.subtype === 'commands_changed') {
          this.loadCommands();
        } else if (m.subtype === 'session_state_changed') {
          // CLI 自己报的忙/闲，比 result 更准：插话的消息可能在 result 之后又开一轮，idle 才是真正结束
          this.sawState = true;
          if (m.state === 'running' && !this.busy) { this.busy = true; this.busySince = Date.now(); this.cancelClose(); this.emit({ t: 'busy', on: true }); }
          else if (m.state === 'idle' && this.busy) { this.busy = false; this.steered = []; this.emit({ t: 'busy', on: false }); this.maybeScheduleClose(); }
        } else if (m.subtype === 'status') {
          // 不需要显示
        }
      } else if (m.type === 'prompt_suggestion') {
        // 在 result 之后才到；只保留最新一条，重新打开会话时也带上
        this.suggestion = m.suggestion;
        this.emit({ t: 'suggest', text: m.suggestion });
      } else if (m.type === 'result') {
        touchWeb(this.id);
        if (!this.sawState) this.busy = false;   // 有 session_state 时以它的 idle 为准
        this.emit({ t: 'turn.done', subtype: m.subtype, cost: m.total_cost_usd, error: m.subtype !== 'success' ? (m.errors || []).join('; ') || m.subtype : undefined });
        this.notify(m.subtype === 'success' ? snippet(m.result, '回复完了') : '这一轮出错结束了', 'done-' + this.id);
        // 有插话排着时 CLI 可能接着干：网页端的「工作中」以 CLI 的 idle 为准，这里先把状态同步回去
        if (this.sawState && this.busy) this.emit({ t: 'busy', on: true });
        this.maybeScheduleClose();
      }
    }
  }

  // 当前会话可用的斜杠命令（内置 + skill + 插件 + MCP），去掉只能在终端里用的
  async loadCommands() {
    try {
      const list = await this.q.supportedCommands();
      const seen = new Set();
      this.commands = list
        .filter(c => !this.terminalOnly?.has(c.name) && !c.name.startsWith('__'))
        .filter(c => (seen.has(c.name) ? false : seen.add(c.name)))
        .map(c => ({ name: c.name, description: c.description || '', hint: c.argumentHint || '', builtin: !!c.builtin }))
        .sort((a, b) => (b.builtin - a.builtin) || a.name.localeCompare(b.name));
      this.emit({ t: 'commands', commands: this.commands });
    } catch (e) {
      log('supportedCommands failed', e?.message);
    }
  }

  // 正在工作时也能发：作为「插话」排队（priority next），Claude 在下一个合适的时机读到，和终端里边干边打字一样
  send(text, images = []) {
    const steering = this.busy;
    // 干活中途插的话：被 Claude 读到之前还不在会话文件里，先记着，重新打开会话时补显示
    if (steering && text) { (this.steered ||= []).push(text); if (this.steered.length > 10) this.steered.shift(); }
    touchWeb(this.id);
    this.busy = true;
    if (!steering) this.busySince = Date.now();   // 网页显示「已工作多久」从这里算，刷新页面也不归零
    this.suggestion = null;
    this.cancelClose();
    // 有图片时用内容块数组：图片在前、文字在后（Claude 看图再读问题效果更好）
    const content = images.length
      ? [...images.map(i => ({ type: 'image', source: { type: 'base64', media_type: i.media_type, data: i.data } })),
         ...(text ? [{ type: 'text', text }] : [])]
      : text;
    this.queue.push({ type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, ...(steering ? { priority: 'next' } : {}) });
    if (steering) log('steer', this.id.slice(0, 8));
    this.wake?.();
    return true;
  }

  askPermission(name, input, o) {
    // 网页端还不支持回答选择题：拒绝并让 Claude 改成在回复里直接问
    const requestId = crypto.randomUUID();
    const canAlways = !!(o.suggestions?.length) && !o.suppressAlwaysAllowRule;
    const req = {
      t: 'perm.request', requestId, toolUseID: o.toolUseID, name,
      title: o.title || null,
      displayName: o.displayName || name,
      description: o.description || '',
      target: toolTarget(name, input, this.cwd),
      plan: name === 'ExitPlanMode' ? String(input?.plan || '') : undefined,
      // 选择题：把题目和选项交给网页，网页把答案按「题目文字 → 选中的选项」传回来
      questions: name === 'AskUserQuestion' && Array.isArray(input?.questions)
        ? input.questions.map(q => ({ question: String(q.question || ''), header: String(q.header || ''), multiSelect: !!q.multiSelect,
            options: (q.options || []).map(o => ({ label: String(o.label || ''), description: String(o.description || '') })) }))
        : undefined,
      reason: o.decisionReason || '',
      canAlways, defaultToNo: !!o.defaultToNo,
    };
    return new Promise(resolve => {
      this.pending.set(requestId, { resolve, input, suggestions: o.suggestions, req });
      o.signal?.addEventListener('abort', () => {
        if (this.pending.delete(requestId)) {
          this.emit({ t: 'perm.cancel', requestId, toolUseID: o.toolUseID });
          resolve({ behavior: 'deny', message: '已取消' });
        }
      });
      this.emit(req);
      this.notify(req.questions ? 'Claude 在问你问题' : '等你确认：' + (req.displayName || name), 'perm-' + this.id);
    });
  }

  replyPermission(requestId, decision, answers) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (decision === 'answer' && p.req.questions) {
      // 只收题目里有的、字符串的答案；每道题都要有答案
      const clean = {};
      for (const q of p.req.questions) {
        const a = answers && typeof answers[q.question] === 'string' ? answers[q.question].trim().slice(0, 2000) : '';
        if (a) clean[q.question] = a;
      }
      if (Object.keys(clean).length === p.req.questions.length) {
        p.resolve({ behavior: 'allow', updatedInput: { ...p.input, answers: clean } });
        this.emit({ t: 'perm.done', requestId, toolUseID: p.req.toolUseID, decision: 'answer', answers: clean });
        return;
      }
      decision = 'deny';
    }
    if (decision === 'allow') p.resolve({ behavior: 'allow', updatedInput: p.input });
    else if (decision === 'allow_session' && p.req.canAlways) p.resolve({ behavior: 'allow', updatedInput: p.input, updatedPermissions: p.suggestions });
    else p.resolve({ behavior: 'deny', message: p.req.questions ? '用户没有回答这个问题（在网页上取消了）。' : '用户在网页上拒绝了这次操作。' });
    this.emit({ t: 'perm.done', requestId, toolUseID: p.req.toolUseID, decision });
  }

  async interrupt() {
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    try { await this.q.interrupt(); } catch (e) { log('interrupt failed', e?.message); }
    this.emit({ t: 'sys', text: '已中断' });
  }

  async setMode(mode) {
    if (!this.allowedModes.includes(mode)) return;
    try {
      await this.q.setPermissionMode(mode);
      this.mode = mode;
      this.emit({ t: 'mode', mode });
    } catch (e) {
      this.emit({ t: 'error', message: '切换模式失败：' + e?.message });
    }
  }

  subscribe(ws) { this.subs.add(ws); this.cancelClose(); }

  // 有人正看着这个会话（页面在前台、打开的就是它）就不推送
  watched() { return [...this.subs].some(ws => ws.visible !== false); }

  notify(body, tag) {
    if (this.watched()) return;
    const title = this.info.customTitle || this.title || path.basename(this.cwd || '') || '会话';
    localSound();
    const badge = markUnread(this.id);
    push.sendAll({ title, body, tag, url: '/?s=' + this.id, badge }, log)
      .then(n => n && log('push sent', this.id.slice(0, 8), body, '→', n));
  }
  unsubscribe(ws) { this.subs.delete(ws); this.maybeScheduleClose(); }

  // 没人看、也没在跑 → 一分钟后关掉进程，把会话还给终端
  // 新建的、还没有会话文件（= 一条消息都没发过）
  unsent() { return this.isNew && !fs.existsSync(jsonlPathOf(this.info)); }

  maybeScheduleClose() {
    if (this.subs.size || this.busy || this.pending.size || this.closeTimer) return;
    this.closeTimer = setTimeout(() => this.dispose(), this.unsent() ? Math.max(IDLE_CLOSE_NEW_MS, idleCloseMs()) : idleCloseMs());
  }
  cancelClose() { clearTimeout(this.closeTimer); this.closeTimer = null; }

  dispose(reason) {
    if (this.closed) return;
    this.closed = true;
    if (this.activity) { this.activity = null; setActivity(this.id, null); }
    this.cancelClose();
    for (const id of [...this.pending.keys()]) this.replyPermission(id, 'deny');
    try { this.q.close(); } catch {}
    this.wake?.();
    runners.delete(this.id);
    this.emit({ t: 'session.closed', reason });
    log('closed', this.id.slice(0, 8), reason || '');
  }
}

// ---------- HTTP ----------

// 没有对话内容、无法 resume 的「僵尸会话」：比如新开就改了名、一句话没说的会话，
// 文件里只有一条 custom-title。每条真实消息都带 cwd，没有 cwd 就说明从没聊过；
// 小文件再确认一下有没有 user 消息（大文件不可能是空会话，不读）
function resumable(s) {
  if (!s.cwd) return false;
  if ((s.fileSize ?? Infinity) > 64 * 1024) return true;
  try { return fs.readFileSync(jsonlPathOf(s), 'utf8').includes('"type":"user"'); } catch { return true; }
}

// 网页里新建的会话是 SDK 起的（entrypoint=sdk-ts），listSessions({ includeProgrammatic: false })
// 会把它们和探针、脚本跑出来的会话一起滤掉。记下网页自己建的会话 id，列表里单独补回来。
// 同时记下新建时继承的权限模式：这种会话从没在 VS Code / 终端用过，originalMode() 找不到东西，
// 不记的话关掉再打开就掉回 default
// 文件格式 { id: { mode } }；旧版是 id 数组，读的时候兼容
const WEB_SESSIONS = path.join(DATA, 'web-sessions.json');

// ---------- 本机提示音 ----------
// Edge / Chrome 在 Mac 上弹的网页通知常常不带声音。claclaw 就跑在这台电脑上，
// 所以推送时可以顺便用系统直接响一声（只在 macOS 上有效）。开关存在 data/settings.json，网页上可开关。
const SETTINGS = path.join(DATA, 'settings.json');
const SOUND_OK = process.platform === 'darwin';
function settings() { try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); } catch { return {}; } }
function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  writeJsonAtomic(SETTINGS, next);   // 原子写：崩溃不会写坏 settings.json
  return next;
}
const SOUND_DIR = '/System/Library/Sounds';
const SOUNDS = SOUND_OK ? (() => { try { return fs.readdirSync(SOUND_DIR).filter(f => f.endsWith('.aiff')).map(f => f.slice(0, -5)).sort(); } catch { return []; } })() : [];
const soundName = () => (SOUNDS.includes(settings().soundName) ? settings().soundName : 'Glass');
// ---------- 各会话正在做什么（会话列表实时显示）----------
const activityMap = {};
let activityTimer = null;
// OpenClaw 会话一轮结束：没人看着就推送（和 Claude 会话一样）
// 推送正文：回复的开头（去掉 Markdown 记号，压成一行，最多 80 字）；没有文字就退回「回复完了」
function snippet(text, fallback) {
  const t = String(text || '')
    .replace(/```[\s\S]*?```/g, ' [代码] ').replace(/`([^`]*)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '').replace(/\*\*|__|~~|\|/g, '')
    .replace(/\s+/g, ' ').trim();
  if (!t) return fallback;
  return t.length > 80 ? t.slice(0, 80) + '…' : t;
}
function ocTurnDone(r, ok, text) {
  if (r.watched()) return;
  localSound();
  const badge = markUnread(r.id);
  push.sendAll({ title: r.title || (isDs(r.id) ? 'DeepSeek' : isOp(r.id) ? 'OpenCode' : 'OpenClaw'), body: ok ? snippet(text, '回复完了') : '这一轮出错结束了', tag: 'done-' + r.id, url: '/?s=' + encodeURIComponent(r.id), badge }, log).catch(() => {});
}
// DeepSeek / OpenCode 会话要你确认操作：没人看着就推送
function dsAsk(r, body) {
  if (r.watched()) return;
  localSound();
  const badge = markUnread(r.id);
  push.sendAll({ title: r.title || (isOp(r.id) ? 'OpenCode' : 'DeepSeek'), body, tag: 'perm-' + r.id, url: '/?s=' + encodeURIComponent(r.id), badge }, log).catch(() => {});
}
const dsOpts = () => ({ log, onActivity: setActivity, onTurnDone: ocTurnDone, onAsk: dsAsk });
function setActivity(id, a) {
  if (a) activityMap[id] = a; else delete activityMap[id];
  if (activityTimer) return;   // 0.5 秒合并一次，流式输出时不刷屏
  activityTimer = setTimeout(() => {
    activityTimer = null;
    const msg = JSON.stringify({ t: 'activity', activity: activityMap });
    for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
  }, 500);
}
function toolActivity(name = '') {
  if (name === 'Bash' || name === 'BashOutput') return '运行命令';
  if (name === 'Read' || name === 'NotebookRead') return '读文件';
  if (name === 'Edit' || name === 'Write' || name === 'MultiEdit' || name === 'NotebookEdit') return '改文件';
  if (name === 'Grep' || name === 'Glob' || name === 'LS') return '查找中';
  if (name === 'WebFetch' || name === 'WebSearch') return '查网页';
  if (name === 'Agent' || name === 'Task') return '派子任务';
  if (name === 'SendMessage') return '发消息';
  if (name === 'ListAgents') return '找会话';
  if (name === 'TodoWrite') return '列计划';
  if (/playwright|browser/i.test(name)) return '操作浏览器';
  return '用工具';
}

// ---------- 这台电脑装了哪些 Claw（没装的不在网页上列出来）----------
function inPath(name) {
  const dirs = new Set([...(process.env.PATH || '').split(':'), '/usr/local/bin', '/opt/homebrew/bin', path.join(HOME, '.local', 'bin')]);
  for (const d of dirs) if (d && fs.existsSync(path.join(d, name))) return true;
  return false;
}
function detectClaws() {
  // 有些 Claw 要新一点的 Node 才读得了它的会话（DeepSeek 要 zstd，OpenCode 要 node:sqlite）。
  // 这种情况不是「即将支持」，而是「这台机器的 Node 版本不够」，要把原因说清楚。
  const dsOk = dsSupported(), opOk = opSupported();
  return [
    { id: 'claude', installed: fs.existsSync(path.join(HOME, '.claude', 'projects')), supported: true },
    { id: 'openclaw', installed: fs.existsSync(path.join(HOME, '.openclaw', 'openclaw.json')) || inPath('openclaw'), supported: true },
    { id: 'deepseek', installed: fs.existsSync(path.join(HOME, '.dsh')) || inPath('dsh'), supported: dsOk, reason: dsOk ? undefined : dsUnsupportedReason() },
    { id: 'opencode', installed: opInstalled(), supported: opOk, reason: opOk ? undefined : opUnsupportedReason() },
  ];
}

// ---------- 未读 ----------
// 推送通知（回复完了 / 等你确认）时记一条未读；任何设备打开并正在看这个会话时清掉。
// 服务器统一记，手机和电脑看到的红点、角标是同一份；存在 data/unread.json，重启不丢。
const UNREAD_FILE = path.join(DATA, 'unread.json');
function unreadMap() { try { return JSON.parse(fs.readFileSync(UNREAD_FILE, 'utf8')) || {}; } catch { return {}; } }
const unreadTotal = u => Object.values(u).reduce((a, n) => a + (n || 0), 0);
function saveUnread(u) {
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  writeJsonAtomic(UNREAD_FILE, u);
  const msg = JSON.stringify({ t: 'unread', unread: u });
  for (const c of wss.clients) if (c.readyState === 1) c.send(msg);
}
function markUnread(id) { const u = unreadMap(); u[id] = (u[id] || 0) + 1; saveUnread(u); return unreadTotal(u); }
function clearUnread(id) { const u = unreadMap(); if (!u[id]) return; delete u[id]; saveUnread(u); }

// ---------- 在 claclaw 里的最近活动 ----------
// 网页里打开、发消息、一轮结束都算「在 claclaw 活跃」；会话列表的「最近活跃」只看这个（不看终端 / VS Code）
const WEB_ACTIVE_FILE = path.join(DATA, 'web-active.json');
let webActive = (() => { try { return JSON.parse(fs.readFileSync(WEB_ACTIVE_FILE, 'utf8')) || {}; } catch { return {}; } })();
let webActiveTimer = null;
function touchWeb(id) {
  if (!id) return;
  webActive[id] = Date.now();
  clearTimeout(webActiveTimer);
  webActiveTimer = setTimeout(() => {
    const cut = Date.now() - 7 * 86400e3;   // 只留最近 7 天的
    for (const k of Object.keys(webActive)) if (webActive[k] < cut) delete webActive[k];
    try { writeJsonAtomic(WEB_ACTIVE_FILE, webActive); } catch {}
  }, 2000);
}

let lastSound = 0;
function localSound(force = false) {
  if (!SOUND_OK || (!force && !settings().localSound)) return;
  if (!force && Date.now() - lastSound < 1500) return; // 几条通知挤在一起时只响一声
  lastSound = Date.now();
  execFile('afplay', [path.join(SOUND_DIR, soundName() + '.aiff')], () => {});
}
function webSessions() {
  try {
    const o = JSON.parse(fs.readFileSync(WEB_SESSIONS, 'utf8'));
    return Array.isArray(o) ? Object.fromEntries(o.map(id => [id, {}])) : (o && typeof o === 'object' ? o : {});
  } catch { return {}; }
}
const webSessionIds = () => new Set(Object.keys(webSessions()));
function rememberWebSession(id, mode, force) {
  const all = webSessions();
  all[id] = force ? { mode, force: true } : { mode };
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = WEB_SESSIONS + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, WEB_SESSIONS);
}
// 切到「跳过确认」：换一个允许跳过确认的进程（会话内容不变，接着 resume），看着它的网页都转到新进程上
function switchToBypass(old) {
  rememberWebSession(old.id, 'bypassPermissions', true);
  const subs = [...old.subs];
  old.subs.clear();   // 先摘掉订阅：dispose 发的 session.closed 不要让网页以为会话关了
  old.dispose('mode');
  const r = new Runner(old.info, 'bypassPermissions', [...MODES, 'bypassPermissions']);
  runners.set(old.id, r);
  for (const w of subs) r.subscribe(w);
  r.emit({ t: 'mode', mode: 'bypassPermissions', modes: r.allowedModes });
  log('mode → bypassPermissions (restart)', old.id.slice(0, 8));
  return r;
}
// 会话该继承的模式：原处（VS Code / 终端）最后用的优先；网页新建的会话用新建时记下的
function inheritedMode(info) {
  const w = webSessions()[info.sessionId];
  if (w?.force && ALL_MODES.includes(w.mode)) return w.mode;   // 在网页上明确切过的（比如切到跳过确认）：以它为准
  const m = originalMode(jsonlPathOf(info)) || w?.mode;
  return ALL_MODES.includes(m) ? m : 'default';
}

async function sessionList() {
  const ours = webSessionIds();
  const [normal, all, live] = [
    await listSessions({ includeProgrammatic: false, limit: 80 }),
    ours.size ? await listSessions({ includeProgrammatic: true, limit: 500 }) : [],
    liveRegistry(),
  ];
  const seen = new Set(normal.map(s => s.sessionId));
  const list = normal.concat(all.filter(s => ours.has(s.sessionId) && !seen.has(s.sessionId)));
  const unread = unreadMap();
  const pc = loadPeer(), peerOn = new Set(pc.enabled ? pc.sessions : []);
  const peerLastOf = id => { const l = pc.last[id], p = l && pc.peers.find(x => x.id === l.peer); return p ? { id: p.id, no: p.no, color: p.color, name: p.name, at: l.at } : undefined; };
  return list.filter(resumable).map(s => {
    const ours = runners.has(s.sessionId);
    const elsewhere = ours ? null : takeoverInfo(s.sessionId, jsonlPathOf(s), live);
    return {
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || '(无标题)',
      cwd: s.cwd || '',
      cwdShort: relPath(s.cwd || '', null),
      branch: s.gitBranch === 'HEAD' ? '' : s.gitBranch || '',   // HEAD：不是 git 目录（或没在任何分支上），不显示
      // 没有分支的会话、最近在网页里活跃过的会话（「最近活跃」组始终显示）：标题下面显示最后一条用户消息
      lastPrompt: s.gitBranch && s.gitBranch !== 'HEAD' && !((webActive[s.sessionId] || 0) > Date.now() - 6 * 3600e3) ? undefined : lastPromptOf(jsonlPathOf(s)) || s.firstPrompt || undefined,
      lastModified: s.lastModified,
      openInWeb: ours,
      busyElsewhere: elsewhere,
      unread: unread[s.sessionId] || 0,
      webActive: webActive[s.sessionId] || 0,
      peer: peerOn.has(s.sessionId) || undefined,   // 加入了 claclaw 协同（列表里用浅紫色边框标出来）
      peerLast: peerLastOf(s.sessionId),             // 最近一次和哪个对方通信：{no, name, at}
    };
  }).concat(
    // 网页里新建、还没发过消息的会话：没有会话文件，listSessions 看不到，也列出来
    [...runners.values()].filter(r => !r.closed && r.unsent() && !list.some(s => s.sessionId === r.id)).map(r => ({
      id: r.id, title: r.info.customTitle || '新会话', cwd: r.cwd, cwdShort: relPath(r.cwd || '', null),
      branch: '', lastModified: r.createdAt, openInWeb: true, busyElsewhere: null, unsent: true, webActive: webActive[r.id] || r.createdAt,
    })),
  ).sort((a, b) => (b.lastModified || 0) - (a.lastModified || 0));
}

// ---------- 登录 ----------

const COOKIE = 'claclaw_sid';
// 登录失败限流：每个 IP 记失败次数，错够 MAX_FAILS 次就锁定；
// 每锁一次锁定时长翻倍（从 10 分钟起，最长 24 小时），登录成功就清零。
const fails = new Map();   // ip -> { n, until, at }
const MAX_FAILS = 5;
const LOCK_BASE_MIN = 10, LOCK_MAX_MIN = 24 * 60;   // 分钟
const FAILS_TTL_MS = 60 * 60 * 1000;                // 清理的宽限期
const lockMinutes = n => Math.min(LOCK_BASE_MIN * 2 ** (n - MAX_FAILS), LOCK_MAX_MIN);
function lockedFor(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() ? f : null;
}
function noteFail(ip) {
  const f = fails.get(ip);
  const n = (f?.n || 0) + 1;
  const until = n >= MAX_FAILS ? Date.now() + lockMinutes(n) * 60000 : 0;
  fails.set(ip, { n, until, at: Date.now() });
  return { n, until };
}
function clearFails(ip) { fails.delete(ip); }
function tooManyTries(f) {
  return '失败次数太多，请 ' + Math.max(1, Math.ceil((f.until - Date.now()) / 60000)) + ' 分钟后再试';
}
// 定期清理过期的条目（#25）。
// 注意：不能只看「上次失败多久以前」——锁定时长会越来越长，按失败时间清会把退避重置掉。
// 所以要以「锁定结束的时间」为准：锁定期内的条目一律留着，锁定结束后再过 FAILS_TTL_MS 才删。
setInterval(() => {
  const now = Date.now();
  for (const [ip, f] of fails) {
    if (f.until > now) continue;                       // 还锁着，别动
    if (now - Math.max(f.at, f.until) > FAILS_TTL_MS) fails.delete(ip);
  }
}, 5 * 60 * 1000).unref?.();

function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)claclaw_sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const authed = req => checkToken(cookieToken(req));

function sendJson(res, code, obj, headers = {}) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}

function loginCookie(token) {
  return `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`;
}

// 首次设置初始账号：只在还没设置过时可用，设好直接登录
async function handleSetup(req, res) {
  if (isSetUp()) return sendJson(res, 409, { error: '初始账号已经设置过了，请直接登录' });
  // 首次设置只认 127.0.0.1 直连（本机浏览器，或 SSH 隧道 ssh -L 8787:127.0.0.1:8787）：
  // 不然谁先打开网页谁就能设置初始账号
  if (!isLocalReq(req)) { log('setup refused from', req.socket.remoteAddress); return sendJson(res, 403, { error: '首次设置只能用 http://127.0.0.1:' + PORT + ' 打开（本机浏览器，或 SSH 隧道）' }); }
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  try {
    setupMaster(body.username, body.password);
  } catch (e) {
    return sendJson(res, 400, { error: e.message });
  }
  const ip = req.socket.remoteAddress;
  log('initial login set up from', ip);
  sendJson(res, 200, { ok: true }, { 'set-cookie': loginCookie(issueToken('master', ip)) });
}

async function handleLogin(req, res) {
  const ip = req.socket.remoteAddress;
  const f = lockedFor(ip);
  if (f) return sendJson(res, 429, { error: tooManyTries(f) });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const via = verify(body.username, body.password);
  if (!via) {
    const { n } = noteFail(ip);
    log('login failed from', ip, 'fails=' + n);
    return sendJson(res, 401, { error: n >= MAX_FAILS ? tooManyTries(lockedFor(ip)) : '用户名或密码不对' });
  }
  clearFails(ip);
  const token = issueToken(via, ip);
  log('login ok from', ip, 'via', via);
  sendJson(res, 200, { ok: true }, { 'set-cookie': loginCookie(token) });
}

// ---------- 删除会话：要求再次输入初始账号；文件挪进 data/trash/，不直接删 ----------

const TRASH = path.join(DATA, 'trash');
// 回收站里的备份保留 30 天：启动时和每次删除之后清一次（目录和文件都清）
const TRASH_KEEP_DAYS = 30;
function trimTrash() {
  let entries = [];
  try { entries = fs.readdirSync(TRASH); } catch { return; }
  const cut = Date.now() - TRASH_KEEP_DAYS * 86400e3;
  for (const name of entries) {
    const p = path.join(TRASH, name);
    try { if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { recursive: true, force: true }); } catch {}
  }
}

async function handleDelete(req, res) {
  const ip = req.socket.remoteAddress;
  const f = lockedFor(ip);
  if (f) return sendJson(res, 429, { error: tooManyTries(f) });
  if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  if (!verifyMaster(body.username, body.password)) {
    const { n } = noteFail(ip);
    log('delete: wrong initial credentials from', ip, 'fails=' + n);
    return sendJson(res, 401, { error: n >= MAX_FAILS ? tooManyTries(lockedFor(ip)) : '初始用户名或密码不对' });
  }
  clearFails(ip);
  if (isOp(body.id)) {
    const r = opRunners.get(body.id);
    if (r && !r.closed && r.subs.size) return sendJson(res, 409, { error: '当前会话不支持删除：它正在网页里打开着，先切到别的会话再删' });
    if (r?.busy) return sendJson(res, 409, { error: '这个会话还在回复，等它结束再删' });
    if (opTakeoverInfo(body.id, takeoverMin())) return sendJson(res, 409, { error: '这个会话正在终端的 opencode 里打开，先关掉再删' });
    r?.dispose();
    // opencode 的会话在它的数据库里：先导出一份 JSON 到回收站（opencode import 能找回），再删
    try { await opDelete(body.id, TRASH); } catch (e) { return sendJson(res, 502, { error: 'OpenCode 删除失败：' + e.message }); }
    log('deleted session', body.id);
    return sendJson(res, 200, { ok: true });
  }
  if (isOc(body.id) || isDs(body.id)) {
    const r = (isOc(body.id) ? ocRunners : dsRunners).get(body.id);
    if (r && !r.closed && r.subs.size) return sendJson(res, 409, { error: '当前会话不支持删除：它正在网页里打开着，先切到别的会话再删' });
    if (r?.busy) return sendJson(res, 409, { error: '这个会话还在回复，等它结束再删' });
    r?.dispose();
    if (isOc(body.id)) {
      try { await ocDelete(body.id, log); } catch (e) { return sendJson(res, 502, { error: 'OpenClaw 删除失败：' + e.message }); }
    } else {
      // dsh：整个会话目录挪进 claclaw 的回收站（和 Claude 会话一样能找回）
      const dir = dsSessionDir(body.id);
      if (!dir) return sendJson(res, 404, { error: '找不到这个会话' });
      if (r) await new Promise(ok => setTimeout(ok, 500));   // 等 dsh 关掉会话、写完收尾
      const dest = path.join(TRASH, new Date().toISOString().replace(/[:.]/g, '-') + '_dsh_' + path.basename(dir));
      fs.mkdirSync(TRASH, { recursive: true, mode: 0o700 });
      try { trimTrash(); } catch {}
      fs.renameSync(dir, dest);
      fs.writeFileSync(path.join(dest, 'origin.json'), JSON.stringify({ sessionId: body.id, from: dir, deletedAt: new Date().toISOString() }, null, 2));
    }
    log('deleted session', body.id);
    return sendJson(res, 200, { ok: true });
  }
  const list = await listSessions({ includeProgrammatic: true, limit: 2000 });
  const info = list.find(s => s.sessionId === body.id);
  if (!info) return sendJson(res, 404, { error: '找不到这个会话' });
  const holders = foreignHolders(info.sessionId);
  if (holders.length) return sendJson(res, 409, { error: '这个会话正在' + (holders[0].entrypoint === 'cli' ? '终端' : holders[0].entrypoint === 'claude-vscode' ? ' VS Code ' : '别处') + '打开，先关掉再删' });
  const file = jsonlPathOf(info);
  if (!fs.existsSync(file)) return sendJson(res, 404, { error: '找不到会话文件' });
  // 正有网页在看的会话（包括发起删除的这个页面当前所在的会话）不给删
  const r = runners.get(info.sessionId);
  if (r && !r.closed && r.subs.size) return sendJson(res, 409, { error: '当前会话不支持删除：它正在网页里打开着，先切到别的会话再删' });
  // 没人看、但进程还没到点关的：先关掉，等会话进程真正退出再挪文件。
  // 进程退出时会往会话记录末尾补写标题、费用等收尾信息，挪早了会在原处留下一个只有这几行的空壳
  if (r) {
    r.closeReason = 'deleted';
    r.dispose('deleted');
    for (let i = 0; i < 50 && liveRegistry().get(info.sessionId)?.length; i++) await new Promise(ok => setTimeout(ok, 100));
    await new Promise(ok => setTimeout(ok, 200));
  }
  const dest = path.join(TRASH, new Date().toISOString().replace(/[:.]/g, '-') + '_' + info.sessionId);
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  try { trimTrash(); } catch {}
  fs.writeFileSync(path.join(dest, 'origin.json'), JSON.stringify({ sessionId: info.sessionId, title: info.customTitle || info.summary, cwd: info.cwd, from: path.dirname(file), deletedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(file, path.join(dest, path.basename(file)));
  const sub = file.replace(/\.jsonl$/, '');
  if (fs.existsSync(sub)) fs.renameSync(sub, path.join(dest, path.basename(sub)));
  log('deleted session', info.sessionId.slice(0, 8), '→', path.relative(ROOT, dest));
  sendJson(res, 200, { ok: true });
}

// ---------- 会话改名：SDK renameSession 往会话记录末尾追加一条 custom-title，和终端 /rename 一样 ----------

async function handleRename(req, res) {
  if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const title = String(body.title ?? '').replace(/\s+/g, ' ').trim();
  if (!title) return sendJson(res, 400, { error: '名字不能为空' });
  if (title.length > 100) return sendJson(res, 400, { error: '名字太长了（最多 100 个字）' });
  if (isOc(body.id)) {
    try { await ocRename(body.id, title, log); } catch (e) { return sendJson(res, 502, { error: 'OpenClaw 改名失败：' + e.message }); }
    const r = ocRunners.get(body.id); if (r) { r.title = title; r.emit({ t: 'session.renamed', title }); }
    log('renamed openclaw session', body.id);
    return sendJson(res, 200, { ok: true, title });
  }
  if (isDs(body.id)) {
    let accepted;
    try { accepted = (await dsRename(body.id, title)).title; } catch (e) { return sendJson(res, e.code || 502, { error: 'DeepSeek 改名失败：' + e.message }); }
    const r = dsRunners.get(body.id); if (r) { r.title = accepted; r.emit({ t: 'session.renamed', title: accepted }); }
    log('renamed deepseek session', body.id);
    return sendJson(res, 200, { ok: true, title: accepted });
  }
  if (isOp(body.id)) {
    try { await opRename(body.id, title, log); } catch (e) { return sendJson(res, 502, { error: 'OpenCode 改名失败：' + e.message }); }
    const r = opRunners.get(body.id); if (r) { r.title = title; r.emit({ t: 'session.renamed', title }); }
    log('renamed opencode session', body.id);
    return sendJson(res, 200, { ok: true, title });
  }
  const list = await listSessions({ includeProgrammatic: true, limit: 2000 });
  const info = list.find(s => s.sessionId === body.id);
  if (!info) return sendJson(res, 404, { error: '找不到这个会话' });
  await renameSession(info.sessionId, title, info.cwd ? { dir: info.cwd } : undefined);
  runners.get(info.sessionId)?.emit({ t: 'session.renamed', title });
  log('renamed session', info.sessionId.slice(0, 8));
  sendJson(res, 200, { ok: true, title });
}

// ---------- 多宿主（见 hosts.mjs）----------
// 只有用 Tailscale 地址（100.64.0.0/10 的 IP，或 tailscale serve 的 *.ts.net 名字）打开时才能切换宿主；
// 127.0.0.1、局域网 IP 打开的就是单宿主
function multiHostReq(req) {
  const h = String(req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
  return /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d{1,3}\.\d{1,3}$/.test(h) || /\.ts\.net$/.test(h);
}
async function handleHosts(req, res, url) {
  const act = url.pathname.slice('/api/hosts'.length);
  const si = req.method === 'GET' && !act ? await slowInfo(ROOT).catch(() => ({})) : null;
  // 下面两个 relay 是首连宿主经 Tailscale IP 调这台的，不受限制；其余要用 Tailscale 地址打开
  if (!act.startsWith('/relay') && !multiHostReq(req)) {
    if (si) return sendJson(res, 200, { single: true, self: { id: '', name: si.name || os.hostname() }, hosts: [], tailnet: null }, { 'cache-control': 'no-store' });
    return sendJson(res, 403, { error: '用 Tailscale 地址打开网页时才能切换宿主' });
  }
  if (si) return sendJson(res, 200, await hosts.overview({ name: si.name || os.hostname() }), { 'cache-control': 'no-store' });
  if (req.method !== 'POST' || !/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
  let b = {};
  try { b = JSON.parse(await readBody(req, 4096)); } catch {}
  try {
    if (act === '/add') {
      const si = await slowInfo(ROOT).catch(() => ({}));
      const r = await hosts.add(b, { selfUrl: SELF_URL, selfName: si.name || os.hostname() });
      log('host added', r.name, r.relay ? '(push relay ok)' : '(no push relay)');
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (act === '/remove') { const ok = await hosts.remove(String(b.id || '')); log('host removed', b.id); return sendJson(res, 200, { ok }); }
    // 下面两个是首连宿主调这台的：登记 / 取消「通知交给它发」
    if (act === '/relay') { hosts.setRelay(b); log('push relay set →', b.name || b.id); return sendJson(res, 200, { ok: true }); }
    if (act === '/relay/remove') { hosts.dropRelay(String(b.id || '')); log('push relay removed', b.id); return sendJson(res, 200, { ok: true }); }
  } catch (e) { return sendJson(res, 400, { error: e.message }); }
  sendJson(res, 404, { error: 'not found' });
}

const handler = async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const page = (name) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      fs.createReadStream(path.join(ROOT, 'public', name)).pipe(res);
    };
    const go = (to) => { res.writeHead(302, { location: to, 'cache-control': 'no-store' }); res.end(); };
    const setUp = isSetUp();
    if (url.pathname === '/setup') return setUp ? go('/login') : page('login.html');
    if (url.pathname === '/login') return setUp ? page('login.html') : go('/setup');
    // 主屏幕图标：iOS 添加到主屏幕时不带 cookie 去取，必须免登录；只放行 icons/ 下已知的 png
    const icon = url.pathname.match(/^\/icons\/([a-z0-9-]+\.png)$/);
    if (icon && fs.existsSync(path.join(ROOT, 'public', 'icons', icon[1]))) {
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      return fs.createReadStream(path.join(ROOT, 'public', 'icons', icon[1])).pipe(res);
    }
    // manifest 由浏览器不带 cookie 去取，必须免登录
    // Service Worker 脚本：浏览器更新它时不一定带 cookie，免登录（里面没有任何敏感内容）
    if (url.pathname === '/sw.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, 'public', 'sw.js')).pipe(res);
    }
    if (url.pathname === '/manifest.webmanifest') {
      res.writeHead(200, { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'no-cache' });
      return fs.createReadStream(path.join(ROOT, 'public', 'manifest.webmanifest')).pipe(res);
    }
    // 多宿主：「这个端口上是不是 claclaw」—— 免登录，只回实例 ID、电脑名、版本
    if (url.pathname === '/api/claclaw/hello') {
      const si = await slowInfo(ROOT).catch(() => ({}));
      return sendJson(res, 200, { app: 'claclaw', id: hosts.selfId(), name: si.name || os.hostname(), version: si.commit || '' }, { 'cache-control': 'no-store' });
    }
    // 本机命令（技能里的 claclaw-peer 等）：只认本机 + ~/.claclaw/local.json 里的令牌，不走登录
    if (url.pathname.startsWith('/api/local/')) return handleLocal(req, res, url);
    // 别的宿主交过来的通知：凭添加时给它的转发令牌（不走登录 cookie）
    if (url.pathname === '/api/push/relay' && req.method === 'POST') {
      const h = hosts.hostByRelayToken(req.headers['x-claclaw-relay']);
      if (!h) return sendJson(res, 401, { error: 'bad relay token' });
      let b = {};
      try { b = JSON.parse(await readBody(req, 8192)); } catch {}
      const p = b.payload && typeof b.payload === 'object' ? b.payload : null;
      if (!p) return sendJson(res, 400, { error: 'bad request' });
      const u = new URL(String(p.url || '/'), 'http://x');
      u.searchParams.set('host', h.id);   // 点通知：先切到那台宿主，再打开会话
      const out = { ...p, title: h.name + ' · ' + String(p.title || 'claclaw'), tag: 'h' + h.id + '-' + String(p.tag || ''), url: u.pathname + u.search };
      const sent = await push.sendAll(out, log, { noRelay: true, source: h.id });
      return sendJson(res, 200, { sent });
    }
    if (url.pathname === '/api/setup' && req.method === 'POST') return handleSetup(req, res);
    if (url.pathname === '/api/login' && req.method === 'POST') return handleLogin(req, res);
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      revokeToken(cookieToken(req));
      return sendJson(res, 200, { ok: true }, { 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) return sendJson(res, 401, { error: 'login required' });
      return go(setUp ? '/login' : '/setup');
    }
    // 多宿主：/h/<宿主ID>/api/… 原样转给那台宿主
    const hp = url.pathname.match(/^\/h\/([\w-]{4,64})(\/api\/.*)$/);
    if (hp) return multiHostReq(req) ? hosts.proxyHttp(req, res, hp[1], hp[2] + url.search) : sendJson(res, 404, { error: '单宿主', hostGone: true });
    if (url.pathname === '/api/hosts' || url.pathname.startsWith('/api/hosts/')) return handleHosts(req, res, url);
    if (url.pathname === '/api/push/pick' && req.method === 'POST') {
      let b = {};
      try { b = JSON.parse(await readBody(req, 2048)); } catch {}
      return sendJson(res, 200, { ok: push.pick(String(b.endpoint || ''), String(b.host || '')) });
    }
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 页面版本 = 文件内容的短哈希 + 修改时间，改了页面自动变，用来确认手机拿到的是不是新页面
      const file = path.join(ROOT, 'public', 'index.html');
      const html = fs.readFileSync(file, 'utf8');
      const mt = new Date(fs.statSync(file).mtimeMs);
      const pad = n => String(n).padStart(2, '0');
      const ver = crypto.createHash('sha1').update(html).digest('hex').slice(0, 7) +
        ' · ' + pad(mt.getMonth() + 1) + '-' + pad(mt.getDate()) + ' ' + pad(mt.getHours()) + ':' + pad(mt.getMinutes());
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(html.replace('__PAGE_VERSION__', ver));
    }
    if (url.pathname === '/api/push/key') return sendJson(res, 200, { publicKey: push.publicKey(), devices: push.subscriptionCount(), httpsUrl: getHttpsUrl() });
    if (url.pathname === '/api/push/status') return sendJson(res, 200, { subscribed: push.hasSubscription(url.searchParams.get('endpoint') || '') });
    if ((url.pathname === '/api/push/subscribe' || url.pathname === '/api/push/unsubscribe') && req.method === 'POST') {
      if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
      let body = {};
      try { body = JSON.parse(await readBody(req, 8192)); } catch {}
      try {
        if (url.pathname === '/api/push/subscribe') { push.subscribe(body.subscription, req.headers['user-agent']); log('push subscribed', push.subscriptionCount(), 'device(s)'); }
        else push.unsubscribe(String(body.endpoint || ''));
        return sendJson(res, 200, { ok: true });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/settings/session') {
      if (req.method === 'POST') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
        let body = {};
        try { body = JSON.parse(await readBody(req, 1024)); } catch {}
        const patch = {};
        if (body.idleCloseMin != null) patch.idleCloseMin = Math.min(1440, Math.max(1, Math.round(Number(body.idleCloseMin) || 10)));
        if (body.takeoverMin != null) patch.takeoverMin = Math.min(1440, Math.max(0, Math.round(Number(body.takeoverMin) || 0)));
        saveSettings(patch);
        log('session settings', JSON.stringify(patch));
      }
      return sendJson(res, 200, { idleCloseMin: minutesSetting('idleCloseMin', 10, 1), takeoverMin: takeoverMin() });
    }
    // 技能：列表（每个技能在各安装位置的状态）、安装、卸载
    if (url.pathname === '/api/skills' || url.pathname.startsWith('/api/skills/')) {
      const installed = detectClaws().filter(c => c.installed).map(c => c.id);
      if (req.method === 'GET' && url.pathname === '/api/skills') return sendJson(res, 200, skills.list(installed), { 'cache-control': 'no-store' });
      let b = {}; try { b = JSON.parse(await readBody(req, 4096)); } catch {}
      const target = b.target || (b.claw ? skills.targetOf(b.claw) : '');
      try {
        if (url.pathname === '/api/skills/install' && req.method === 'POST') { skills.install(String(b.name || ''), target); log('skill installed', b.name, '→', target); }
        else if (url.pathname === '/api/skills/uninstall' && req.method === 'POST') { skills.uninstall(String(b.name || ''), target); log('skill removed', b.name, '←', target); }
        else return sendJson(res, 404, { error: 'not found' });
      } catch (e) { return sendJson(res, 400, { error: e.message }); }
      return sendJson(res, 200, skills.list(installed));
    }
    if (url.pathname === '/api/claws') {
      // running：装了但没启动的（OpenClaw 网关没开）手机上灰着显示、电脑上不显示；其他 Claw 用的时候才拉起进程，装了就算可用
      const list = detectClaws();
      for (const c of list) c.running = c.installed && c.supported ? (c.id === 'openclaw' ? await ocGatewayUp(log) : true) : false;
      return sendJson(res, 200, list);
    }
    if (url.pathname === '/api/sound') {
      if (req.method === 'POST') {
        if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
        let body = {};
        try { body = JSON.parse(await readBody(req, 1024)); } catch {}
        if (typeof body.name === 'string' && SOUNDS.includes(body.name)) { saveSettings({ soundName: body.name }); localSound(true); } // 换声音：试听
        if (typeof body.on === 'boolean') {
          saveSettings({ localSound: body.on });
          log('local sound', body.on ? 'on' : 'off');
          if (body.on) localSound(true); // 打开时响一声给你听
        }
      }
      return sendJson(res, 200, { supported: SOUND_OK, on: SOUND_OK && !!settings().localSound, name: soundName(), sounds: SOUNDS });
    }
    if (url.pathname === '/api/push/test' && req.method === 'POST') {
      localSound();
      const n = await push.sendAll({ title: 'Claclaw', body: '测试通知：推送已经通了', tag: 'test', url: '/' }, log);
      return sendJson(res, 200, { sent: n });
    }
    if (url.pathname === '/api/sessions/delete' && req.method === 'POST') return handleDelete(req, res);
    if (url.pathname === '/api/sessions/rename' && req.method === 'POST') return handleRename(req, res);
    if (url.pathname === '/api/sessions' && url.searchParams.get('claw') === 'openclaw') {
      try { return sendJson(res, 200, peerMark(await ocSessionList(log)), { 'cache-control': 'no-store' }); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/api/peer' || url.pathname.startsWith('/api/peer/')) {
      const local = isLocalReq(req), c = loadPeer();
      const pub = cc => ({ ...peerPublic(cc, true), canAssign: local });   // canAssign：能不能改开放哪些会话（只在本机）
      if (req.method === 'GET' && url.pathname === '/api/peer') {
        // 协同池里每个会话的名字、目录（有的会话不在会话列表里，比如网页里新建的，页面上只能显示 ID）
        const all = c.sessions.length ? await localSessions().catch(() => []) : [];
        const poolInfo = c.sessions.map(id => { const s = all.find(x => x.sessionId === id); return s ? { id, title: String(s.title || '').replace(/\s+/g, ' ').slice(0, 80), cwd: s.cwd || '', claw: s.claw } : { id }; });
        return sendJson(res, 200, { ...pub(c), poolInfo });
      }
      let b = {}; try { b = JSON.parse(await readBody(req, 16 * 1024) || '{}'); } catch {}
      const act = url.pathname.slice('/api/peer'.length);
      // 查对方在不在线是只读的：手机、Tailscale 打开的网页也能看
      // 手机（不是本机打开）也能做全部操作——只有「开放哪些会话」（协同池、给某个对方开放哪些）要在这台电脑上用 127.0.0.1 设
      if (!local && (act === '/allow' || (act === '' && Array.isArray(b.sessions)))) return sendJson(res, 403, { error: '开放哪些会话只能在这台电脑上用 127.0.0.1 打开网页时设置' });
      if (act === '/reject') { dropPending(String(b.id || '')); return sendJson(res, 200, peerPublic(loadPeer(), true)); }
      if (act === '/peer-relay') {
        // 给已配对的对方补上 / 改掉它的中继地址（跨网络时用；局域网仍然优先）
        const p = c.peers.find(x => x.id === b.id);
        if (!p) return sendJson(res, 404, { error: '没有这个对方' });
        const raw = Array.isArray(b.relays) ? b.relays.join(' ') : String(b.relay || '');
        const list = raw.split(/\s+/).filter(Boolean);
        if (list.some(r => !/^https:\/\/\S+#pin=sha256\/\/\S+$/.test(r))) return sendJson(res, 400, { error: '中继地址要是 https://…#pin=…（&key=…）整段，多个用换行分开（第一个是主）' });
        p.relays = list.slice(0, 5).map(r => r.slice(0, 2000)); delete p.relay; savePeer(c);
        log('peer relay', p.name, p.relays.length);
        return sendJson(res, 200, pub(c));
      }
      if (act === '/allow') {
        // 给某个对方单独设开放哪些会话（null = 全部开放）
        const p = c.peers.find(x => x.id === b.id);
        if (!p) return sendJson(res, 404, { error: '没有这个对方' });
        if (b.sessions === null) delete p.allow;
        else if (Array.isArray(b.sessions)) p.allow = b.sessions.filter(x => typeof x === 'string' && PEER_SID.test(x)).slice(0, 100);
        savePeer(c); log('peer allow', p.name, Array.isArray(p.allow) ? p.allow.length : 'all');
        return sendJson(res, 200, pub(c));
      }
      if (act === '/revoke') { c.peers = c.peers.filter(p => p.id !== b.id); savePeer(c); log('peer revoked', b.id); return sendJson(res, 200, pub(c)); }
      if (act === '/check') {
        // 已配对的对方在不在线：能用钥匙列出对方的会话就算在线
        // 带 id 只查这一个：网页按对方分别查，在线的不用等离线的那个超时
        const out = await Promise.all(c.peers.filter(p => !b?.id || p.id === b.id).map(async p => {
          if (!p.inbox || !p.theirToken) return { id: p.id, online: null };
          // route：这次实际走的路（局域网 / 中继）；relay：单独试中继的结果（null = 没有中继地址）
          const [main, relay] = await Promise.all([
            peerCall(c, p, '/sessions', { ms: 6000 }).then(j => ({ online: !!j.ok, sessions: j.sessions || [], error: j.ok ? undefined : j.error }), e => ({ online: false, error: e.message })),
            probeRelay(p),
          ]);
          return { id: p.id, ...main, route: main.online ? peerRoute.get(p.id)?.via : undefined, relay };
        }));
        return sendJson(res, 200, out);
      }
      if (act === '/pair-start') {
        // 我们向对方申请配对：对方页面会出现申请和六位数配对码，对方的人把码告诉你
        const base = String(b.url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/\S+$/i.test(base)) return sendJson(res, 400, { error: '对方地址要以 http:// 开头，例如 http://192.168.1.x:8788/claclaw-peer' });
        if (!c.enabled) return sendJson(res, 400, { error: '先开启我们这边的协同（对方要能回连我们）' });
        try {
          const alt = /^https?:\/\/\S+$/i.test(String(b.urlAlt || '')) ? String(b.urlAlt).replace(/\/+$/, '') : '';
          let j, used = base;
          try { j = await callPeer(base, '/pair', { body: { name: myName(c), ...ourInbox(c) }, ms: 8000 }); }
          catch (e) { if (!alt) throw e; used = alt; j = await callPeer(alt, '/pair', { body: { name: myName(c), ...ourInbox(c) }, ms: 8000 }); }   // 名字连不上：用 IP
          if (!j.ok || !j.requestId) return sendJson(res, 200, { error: '对方没有接受申请：' + (j.error || 'HTTP ' + j.status) });
          outPair = { base: used, baseAlt: used === base ? alt : base, requestId: j.requestId, token: newToken(), expiresAt: Date.now() + (Number(j.expiresIn) || 300) * 1000 };
          return sendJson(res, 200, pub(c));
        } catch (e) { return sendJson(res, 200, { error: e.message }); }
      }
      if (act === '/pair-finish') {
        if (!outPair || outPair.expiresAt < Date.now()) return sendJson(res, 400, { error: '配对申请已过期，请重新发起' });
        try {
          const j = await callPeer(outPair.base, '/pair/confirm', { body: { requestId: outPair.requestId, code: String(b.code || '').trim(), token: outPair.token }, ms: 8000 });
          if (j.pairing) { outPair.pairing = true; outPair.expiresAt = Math.max(outPair.expiresAt, Date.now() + (Number(j.retryIn) || 30) * 1000 + 5 * 60e3); return sendJson(res, 200, { ...pub(c), retryIn: Number(j.retryIn) || 30 }); }
          if (!j.ok || !j.token) { if (j.failed || /作废|过期|不存在|失败/.test(j.error || '')) outPair = null; return sendJson(res, 200, { error: j.error || '配对失败' }); }
          const c2 = loadPeer();
          const okUrl = u => /^https?:\/\/\S+$/i.test(String(u || '')) ? String(u).slice(0, 2000) : '';
          const inbox = okUrl(j.inbox) || outPair.base, inboxAlt = okUrl(j.inboxAlt) || (inbox !== outPair.base ? outPair.base : outPair.baseAlt || '');
          c2.peers = c2.peers.filter(p => ![inbox, inboxAlt, outPair.base].includes(p.inbox));
          c2.peers.push({ id: newId(), no: nextPeerNo(c2), name: String(j.name || '').slice(0, 40) || new URL(outPair.base).hostname, ip: new URL(outPair.base).hostname, inbox, inboxAlt, relays: (Array.isArray(j.relays) ? j.relays : [j.relay]).map(okUrl).filter(Boolean).slice(0, 5), tokenHash: hashToken(outPair.token), theirToken: j.token, pairedAt: Date.now(), lastSeen: Date.now() });
          savePeer(c2); outPair = null;
          log('peer paired (we asked)', c2.peers.at(-1).name);
          return sendJson(res, 200, { ...pub(c2), paired: c2.peers.at(-1).name });
        } catch (e) { return sendJson(res, 200, { error: e.message }); }
      }
      if (act === '/nearby') {
        // 附近开着协同的 claclaw（Bonjour），已经配对的标出来
        const list = await discover(c);
        return sendJson(res, 200, list.map(n => ({ ...n, paired: c.peers.some(p => [p.inbox, p.inboxAlt].some(u => u && (u.startsWith(n.base) || (n.baseIp && u.startsWith(n.baseIp))))) })));
      }
      if (act === '/pair-cancel') { outPair = null; return sendJson(res, 200, pub(c)); }
      if (act !== '') return sendJson(res, 404, { error: 'not found' });
      if (c.peers.length && ((b.port != null && Number(b.port) !== c.port) || (typeof b.name === 'string' && b.name.trim() !== (c.name || '')))) return sendJson(res, 400, { error: '已经有配对，名字和端口不能改；要改先撤销全部配对' });
      if (b.port != null) { const p = Number(b.port); if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === PORT) return sendJson(res, 400, { error: '端口要在 1024–65535 之间，且不能和 claclaw 自己的端口相同' }); c.port = p; }
      if (typeof b.dir === 'string') c.dir = b.dir;
      if (typeof b.name === 'string') c.name = b.name.replace(/\s+/g, ' ').trim().slice(0, 40);
      // 中继邀请码（clarelay1.…，可以多个，主 → 备）：relayAdd 加一个（排在最后，当备用）、relayRemove 删第几个、relayPrimary 把第几个设为主；
      // 旧的 relayInvite：非空 = 加一个，空 = 全部删掉
      if (typeof b.relayInvite === 'string' && !b.relayInvite.trim()) { c.relayInvites = []; delete c.relayInvite; c.relays = []; c.relay = ''; c.relayAddrOf = {}; }
      const add = typeof b.relayAdd === 'string' ? b.relayAdd : typeof b.relayInvite === 'string' ? b.relayInvite : '';
      if (add.trim()) {
        const mod = await loadClarelay();
        if (!mod) return sendJson(res, 400, { error: '没找到 clarelay：把它放在 claclaw 旁边的 clarelay 目录，或用 npm 装上' });
        const inv = (add.match(/clarelay1\.[A-Za-z0-9_-]+/) || [''])[0];
        if (!inv || !mod.isInvite(inv)) return sendJson(res, 400, { error: '这不是中继邀请码（应该以 clarelay1. 开头）' });
        const list = relayInvitesOf(c);
        if (list.some(x => relayHostOf(x) === relayHostOf(inv))) c.relayInvites = list.map(x => relayHostOf(x) === relayHostOf(inv) ? inv : x);   // 同一台中继换了口令：原位替换
        else c.relayInvites = [...list, inv].slice(0, 3);
        delete c.relayInvite;
      }
      if (Number.isInteger(b.relayRemove) || Number.isInteger(b.relayPrimary)) {
        const list = relayInvitesOf(c), k = Number.isInteger(b.relayRemove) ? b.relayRemove : b.relayPrimary;
        if (!(k >= 0 && k < list.length)) return sendJson(res, 400, { error: '没有这个中继' });
        c.relayInvites = Number.isInteger(b.relayRemove) ? list.filter((_, i) => i !== k) : [list[k], ...list.filter((_, i) => i !== k)];
        delete c.relayInvite;
        const m = c.relayAddrOf || {}; c.relays = c.relayInvites.map(x => m[x]).filter(Boolean); c.relay = c.relays[0] || '';
      }
      // 中继地址（不用 clarelay、自己开隧道时手填）：公开地址 + 协同路径 + #pin=证书指纹
      if (typeof b.relay === 'string') {
        const r = b.relay.trim();
        if (r && !/^https?:\/\/\S+$/.test(r)) return sendJson(res, 400, { error: '中继地址要以 http:// 或 https:// 开头' });
        if (/^https:/.test(r) && !/#pin=sha256\/\/[A-Za-z0-9+/=]+(&key=\S+)?$/.test(r)) return sendJson(res, 400, { error: 'https 中继地址末尾要带证书指纹：#pin=sha256//…' });
        c.relay = r.slice(0, 500);
      }
      if (Array.isArray(b.sessions)) c.sessions = b.sessions.filter(x => typeof x === 'string' && PEER_SID.test(x)).slice(0, 100);
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      if (c.enabled && !c.sessions.length) return sendJson(res, 400, { error: '先选至少一个会话加入协同' });
      savePeer(c);
      applyListener(c, peerHandler, log); applyAdvert(c, log); applyRelay(c).catch(() => {});
      await new Promise(ok => setTimeout(ok, 300));   // 等监听结果（端口被占用会马上报错）
      log('peer config saved', c.enabled ? 'on' : 'off', c.sessions.length, 'sessions');
      return sendJson(res, 200, pub(c));
    }
    // 电脑合成语音：手机网页拿去播放（登录后才能用）
    if (url.pathname === '/api/tts/voices') return sendJson(res, 200, await ttsVoices());
    if (url.pathname === '/api/tts/warm' && req.method === 'POST') { ttsWarm(); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/tts/log' && req.method === 'POST') { let b = {}; try { b = JSON.parse(await readBody(req, 1024)); } catch {} log('tts client', String(b.m || '').replace(/\s+/g, ' ').slice(0, 200)); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req, 8192)); } catch {}
      try {
        const t0 = Date.now();
        const { buf, type } = await ttsSynth(b.text, String(b.voice || ''), b.rate);
        log('tts', String(b.voice || ''), String(b.text || '').length + '字', (Date.now() - t0) + 'ms');
        res.writeHead(200, { 'content-type': type, 'content-length': buf.length, 'cache-control': 'no-store' });
        return res.end(buf);
      } catch (e) { log('tts failed', String(b.voice || ''), e.message); return sendJson(res, 400, { error: e.message }); }
    }
    if (url.pathname === '/api/host') {
      const live = m => [...m.values()].filter(r => !r.closed);
      const count = m => ({ open: live(m).length, busy: live(m).filter(r => r.busy).length });
      const claws = Object.fromEntries(detectClaws().map(c => [c.id, { installed: c.installed }]));
      claws.openclaw.up = claws.openclaw.installed ? await ocGatewayUp(log) : false;
      claws.deepseek.up = dsAcpRunning();
      claws.opencode.up = opAcpRunning();
      const info = await hostInfo({
        root: ROOT, port: PORT, hosts: HOSTS, https: getHttpsUrl(), startedAt: STARTED_AT,
        sessions: { claude: count(runners), openclaw: count(ocRunners), deepseek: count(dsRunners), opencode: count(opRunners), push: push.subscriptionCount() },
        claws: { claude: { ...claws.claude, ...count(runners) }, openclaw: { ...claws.openclaw, ...count(ocRunners) }, deepseek: { ...claws.deepseek, ...count(dsRunners) }, opencode: { ...claws.opencode, ...count(opRunners) } },
      });
      return sendJson(res, 200, info, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/sessions' && url.searchParams.get('claw') === 'opencode') {
      try { return sendJson(res, 200, peerMark(opSessionList({ busy: id => !!opRunners.get(id)?.busy, takeoverMin: takeoverMin() })), { 'cache-control': 'no-store' }); }
      catch (e) { return sendJson(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/sessions' && url.searchParams.get('claw') === 'deepseek') {
      try { return sendJson(res, 200, peerMark(dsSessionList({ busy: id => !!dsRunners.get(id)?.busy })), { 'cache-control': 'no-store' }); }
      catch (e) { return sendJson(res, 500, { error: e.message }); }
    }
    if (url.pathname === '/api/sessions') {
      const list = await sessionList();
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(list));
      setTimeout(() => prewarmHistory(list), 50);   // 回到列表后点进去就快
      return;
    }
    res.writeHead(404).end('not found');
  } catch (e) {
    log('http error', e?.message);
    res.writeHead(500).end('error');
  }
};

// ---------- WebSocket ----------

// 没有认证期间至少挡住跨站：手机上随便哪个网页都能 new WebSocket('ws://100.x:8787')，
// 浏览器不对 WebSocket 做同源限制，所以只接受 Origin 与 Host 一致的连接
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // 非浏览器客户端（curl / 测试脚本）
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}

const wss = new WebSocketServer({ noServer: true });
function onUpgrade(req, socket, head) {
  const hw = new URL(req.url, 'http://x').pathname.match(/^\/h\/([\w-]{4,64})\/ws$/);
  if (hw) {
    if (!sameOrigin(req) || !authed(req) || !multiHostReq(req)) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); return socket.destroy(); }
    return hosts.proxyWs(req, socket, head, hw[1], wss, log);
  }
  if (new URL(req.url, 'http://x').pathname !== '/ws' || !sameOrigin(req)) {
    log('ws rejected', req.headers.origin || '', req.socket.remoteAddress);
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    return socket.destroy();
  }
  if (!authed(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
}

wss.on('connection', (ws, req) => {
  log('ws connected from', req.socket.remoteAddress);
  ws.visible = true; // 页面会在切到后台 / 回到前台时告诉我们
  let runner = null;
  const send = o => ws.readyState === 1 && ws.send(JSON.stringify(o));
  send({ t: 'unread', unread: unreadMap() });
  send({ t: 'activity', activity: activityMap });

  // 打开 / 新建 / 离开会话要排队一个个处理：处理里有 await（列会话、读历史、起 ACP），
  // 两次打开挨得近（重连自动打开 + 点通知 / 连点两个会话）时并发跑，后点的可能先完成，
  // 页面停在先点的那个上，连接还同时订阅着两个会话 → 串台。还没轮到就已被更新的打开顶掉的直接丢弃。
  let openChain = Promise.resolve(), openSeq = 0;
  ws.on('message', raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (/^session\.(open|new|leave)$/.test(m?.t)) {
      const seq = ++openSeq;
      openChain = openChain.then(() => (m.t === 'session.open' && seq !== openSeq) ? null : handle(m));
    } else handle(m);
  });
  async function handle(m) {
    try {
      // 这个会话的进程被换过（比如切到「跳过确认」要重启进程）：改用新的那个
      if (runner?.closed && runners.get(runner.id) && !runners.get(runner.id).closed) runner = runners.get(runner.id);
      if (m.t === 'visible') { ws.visible = !!m.on; if (ws.visible && runner) clearUnread(runner.id); return; }
      // 手机回到会话列表页：不再看着这个会话（推送、未读、空闲关闭都照常算）
      if (m.t === 'session.leave') { runner?.unsubscribe(ws); runner = null; return; }
      // 往上滑：要 before（绝对序号）之前的一页
      if (m.t === 'history.more') {
        if (!runner) return;
        if (runner instanceof DsRunner || runner instanceof OpRunner) {
          const pg = historyPage(runner.history(), Number(m.before) || 0, HISTORY_MORE);
          return send({ t: 'history.page', id: runner.id, items: pg.items, start: pg.start, more: pg.more });
        }
        if (runner instanceof OcRunner) {
          const pg = await runner.more();
          const start = Math.max(0, (Number(m.before) || 0) - pg.items.length);
          return send({ t: 'history.page', id: runner.id, items: pg.items, start: pg.more ? Math.max(1, start) : 0, more: pg.more });
        }
        const hist = await loadHistoryCached(runner.id, runner.cwd);
        const pg = historyPage(hist, Number(m.before) || 0, HISTORY_MORE);
        return send({ t: 'history.page', id: runner.id, items: pg.items, start: pg.start, more: pg.more });
      }
      if (m.t === 'session.new' && (isOc(m.from) || m.claw === 'openclaw')) {
        ensureSkill('openclaw');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        // OpenClaw：网关新建会话（没有目录的概念），建好直接打开
        const title = String(m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        let id;
        try { id = await ocCreate(title, log); } catch (e) { return send({ t: 'error', message: 'OpenClaw 新建会话失败：' + e.message }); }
        runner?.unsubscribe(ws);
        const r = new OcRunner(id, { log, onActivity: setActivity, onTurnDone: ocTurnDone });
        ocRunners.set(id, r);
        runner = r;
        r.subscribe(ws);
        const pg = await r.open();
        log('new openclaw session', r.key);
        return send({
          t: 'session.opened', id, title: title || r.title || '新会话', cwd: 'OpenClaw', cwdShort: 'OpenClaw' + (r.model ? ' · ' + r.model : ''),
          mode: 'default', modes: ['default'], busy: false, claw: 'openclaw', commands: r.commands || [],
          history: pg.items, historyStart: 100000 - pg.items.length, historyTotal: 100000, historyMore: pg.more,
          pending: [], suggestion: null, isNew: true,
        });
      }
      if (m.t === 'session.new' && (isOp(m.from) || m.claw === 'opencode')) {
        ensureSkill('opencode');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        // OpenCode：用 opencode 的 ACP 在目录里新建会话；目录默认用参照会话的
        let cwd = isOp(m.from) ? (opRunners.get(m.from)?.cwd || opSessionList().find(s => s.id === m.from)?.cwd) : '';
        if (typeof m.cwd === 'string' && m.cwd.trim()) {
          let d = m.cwd.trim();
          if (d === '~' || d.startsWith('~/')) d = HOME + d.slice(1);
          if (!path.isAbsolute(d)) return send({ t: 'error', message: '目录要写完整路径（/ 或 ~ 开头）：' + m.cwd });
          cwd = path.resolve(d);
        }
        if (!cwd) cwd = HOME;
        let st = null; try { st = fs.statSync(cwd); } catch {}
        if (!st?.isDirectory()) return send({ t: 'error', message: '目录不存在：' + cwd });
        let r;
        try { r = await opNewSession(cwd, dsOpts()); } catch (e) { return send({ t: 'error', message: 'OpenCode 新建会话失败：' + e.message }); }
        runner?.unsubscribe(ws);
        runner = r;
        r.subscribe(ws);
        log('new opencode session', r.sid, 'in', cwd);
        return send({
          t: 'session.opened', id: r.id, title: '新会话', cwd, cwdShort: r.metaLine(), claw: 'opencode',
          mode: 'default', modes: ['default'], busy: false, history: [], pending: [], suggestion: null,
          commands: r.commands, isNew: true,
        });
      }
      if (m.t === 'session.new' && (isDs(m.from) || m.claw === 'deepseek')) {
        ensureSkill('deepseek');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        // DeepSeek：用 dsh 的 ACP 在目录里新建会话；目录默认用参照会话的
        let cwd = isDs(m.from) ? (dsRunners.get(m.from)?.cwd || dsSessionList().find(s => s.id === m.from)?.cwd) : '';
        if (typeof m.cwd === 'string' && m.cwd.trim()) {
          let d = m.cwd.trim();
          if (d === '~' || d.startsWith('~/')) d = HOME + d.slice(1);
          if (!path.isAbsolute(d)) return send({ t: 'error', message: '目录要写完整路径（/ 或 ~ 开头）：' + m.cwd });
          cwd = path.resolve(d);
        }
        if (!cwd) cwd = HOME;
        let st = null; try { st = fs.statSync(cwd); } catch {}
        if (!st?.isDirectory()) return send({ t: 'error', message: '目录不存在：' + cwd });
        const r = await dsNewSession(cwd, dsOpts());
        runner?.unsubscribe(ws);
        runner = r;
        r.subscribe(ws);
        log('new dsh session', r.sid, 'in', cwd);
        return send({
          t: 'session.opened', id: r.id, title: '新会话', cwd, cwdShort: r.metaLine(), claw: 'deepseek',
          mode: 'default', modes: ['default'], busy: false, history: [], pending: [], suggestion: null,
          commands: r.commands, isNew: true,
        });
      }
      if (m.t === 'session.new') {
        // 在某个会话的目录里新建一个兄弟会话：同目录、同权限模式
        const list = await listSessions({ includeProgrammatic: true, limit: 2000 });
        const from = list.find(s => s.sessionId === m.from) || runners.get(m.from)?.info;
        // 目录：默认用参照会话的目录；也可以指定别的目录（新建对话框里点目录可以改）
        let cwd = from?.cwd;
        if (typeof m.cwd === 'string' && m.cwd.trim()) {
          let d = m.cwd.trim();
          if (d === '~' || d.startsWith('~/')) d = HOME + d.slice(1);
          if (!path.isAbsolute(d)) return send({ t: 'error', message: '目录要写完整路径（/ 或 ~ 开头）：' + m.cwd });
          d = path.resolve(d);
          let st = null; try { st = fs.statSync(d); } catch {}
          if (!st?.isDirectory()) return send({ t: 'error', message: '目录不存在：' + d });
          cwd = d;
        }
        if (!cwd) return send({ t: 'error', message: '找不到要参照的会话' });
        if (!fs.existsSync(cwd)) return send({ t: 'error', message: '会话目录已不存在：' + cwd });
        const title = String(m.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
        const id = crypto.randomUUID();
        const inherited = from ? ((runners.get(from.sessionId)?.mode) || inheritedMode(from)) : 'default';
        const allowed = MODES.includes(inherited) ? MODES : [...MODES, inherited];
        const info = { sessionId: id, cwd, summary: title || '新会话', customTitle: title || undefined };
        runner?.unsubscribe(ws);
        runner = new Runner(info, inherited, allowed, { isNew: true });
        runners.set(id, runner);
        rememberWebSession(id, inherited);
        runner.subscribe(ws);
        log('new session', id.slice(0, 8), 'in', cwd, 'mode', inherited, from ? 'sibling of ' + from.sessionId.slice(0, 8) : '');
        send({
          t: 'session.opened', id, title: info.summary, cwd: info.cwd, cwdShort: relPath(info.cwd, null),
          mode: runner.mode, modes: runner.allowedModes, busy: false, history: [], pending: [], suggestion: null,
          commands: runner.commands || null, isNew: true,
        });
      } else if (m.t === 'session.open' && isDs(m.id)) {
        ensureSkill('deepseek');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        runner?.unsubscribe(ws);
        let r = dsRunners.get(m.id);
        if (!r) { r = new DsRunner(m.id, dsOpts()); dsRunners.set(m.id, r); }
        const hist = r.history();
        if (!hist.total && !r.attached && !dsExists(m.id)) { dsRunners.delete(m.id); runner = null; return send({ t: 'error', message: '找不到这个会话' }); }   // 空会话（新建后还没发消息）文件在就能打开
        runner = r;
        r.subscribe(ws);
        if (ws.visible !== false) clearUnread(m.id);
        const pg = historyPage(hist, hist.total, HISTORY_PAGE);
        for (const q of r.queue) pg.items.push({ kind: 'user', text: q.text, waiting: true });   // 排着队、还没发出的
        log('open dsh', r.sid, hist.total, 'items');
        send({
          t: 'session.opened', id: m.id, title: r.title, cwd: r.cwd, cwdShort: r.metaLine(), claw: 'deepseek',
          mode: 'default', modes: ['default'], busy: r.busy, commands: r.commands,
          history: pg.items, historyStart: pg.start, historyTotal: hist.total, historyMore: pg.more,
          busyFor: r.busy && r.busySince ? Date.now() - r.busySince : 0,
          pending: [...r.pending.values()].map(p => p.req), suggestion: null,
        });
      } else if (m.t === 'session.open' && isOp(m.id)) {
        ensureSkill('opencode');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        let r = opRunners.get(m.id);
        if (!r) {
          // 终端里的 opencode 正开着它：和 Claude 会话一样，闲置够久才能接管，接管会结束终端里的 opencode
          const el = opTakeoverInfo(m.id, takeoverMin());
          if (el) {
            if (!m.takeover || !el.canTakeover) return send({ t: 'session.busy', id: m.id, ...el });
            if (!(await opEndHolders(el))) return send({ t: 'error', message: '没能结束终端里的 opencode，未接管' });
            log('takeover opencode done', m.id);
          }
        }
        runner?.unsubscribe(ws);
        if (!r) { r = new OpRunner(m.id, dsOpts()); opRunners.set(m.id, r); }
        const hist = r.history();
        if (!hist.total && !r.attached && !opExists(m.id)) { opRunners.delete(m.id); runner = null; return send({ t: 'error', message: '找不到这个会话' }); }
        runner = r;
        r.subscribe(ws);
        if (ws.visible !== false) clearUnread(m.id);
        const pg = historyPage(hist, hist.total, HISTORY_PAGE);
        for (const q of r.queue) pg.items.push({ kind: 'user', text: q.text, waiting: true });   // 排着队、还没发出的
        log('open opencode', r.sid, hist.total, 'items');
        send({
          t: 'session.opened', id: m.id, title: r.title, cwd: r.cwd, cwdShort: r.metaLine(), claw: 'opencode',
          mode: 'default', modes: ['default'], busy: r.busy, commands: r.commands,
          history: pg.items, historyStart: pg.start, historyTotal: hist.total, historyMore: pg.more,
          busyFor: r.busy && r.busySince ? Date.now() - r.busySince : 0,
          pending: [...r.pending.values()].map(p => p.req), suggestion: null,
        });
      } else if (m.t === 'session.open' && isOc(m.id)) {
        ensureSkill('openclaw');   // 用上这个 Claw 就装好 claclaw-peer 技能（AI 才知道怎么找别的会话）
        runner?.unsubscribe(ws);
        let r = ocRunners.get(m.id);
        if (!r) { r = new OcRunner(m.id, { log, onActivity: setActivity, onTurnDone: ocTurnDone }); ocRunners.set(m.id, r); }
        runner = r;
        r.subscribe(ws);
        if (ws.visible !== false) clearUnread(m.id);
        const pg = await r.open();
        // 历史条目没有全局序号：给一个足够大的虚拟起点，往上翻一页就往前挪一页
        const total = 100000;
        log('open openclaw', r.key, pg.items.length, 'items');
        send({
          t: 'session.opened', id: m.id, title: r.title, cwd: 'OpenClaw', cwdShort: 'OpenClaw' + (r.model ? ' · ' + r.model : ''),
          mode: 'default', modes: ['default'], busy: r.busy, claw: 'openclaw', commands: r.commands || [],
          history: pg.items, historyStart: total - pg.items.length, historyTotal: total, historyMore: pg.more,
          busyFor: r.busy && r.busySince ? Date.now() - r.busySince : 0, pending: [], suggestion: null,
        });
      } else if (m.t === 'session.open') {
        const list = await listSessions({ includeProgrammatic: true, limit: 500 });
        // 刚新建、还没发过消息的会话不在列表里（没有会话文件），从开着的 runner 里拿
        const info = list.find(s => s.sessionId === m.id) || runners.get(m.id)?.info;
        if (!info) return send({ t: 'error', message: '找不到这个会话' });
        if (!runners.has(m.id)) {
          if (info.cwd && !fs.existsSync(info.cwd)) return send({ t: 'error', message: '会话目录已不存在：' + info.cwd });
          const el = takeoverInfo(m.id, jsonlPathOf(info), liveRegistry());
          if (el) {
            if (!m.takeover || !el.canTakeover) return send({ t: 'session.busy', id: m.id, ...el });
            if (!(await endHolders(m.id))) return send({ t: 'error', message: '没能结束原处的会话进程，未接管' });
            log('takeover done', m.id.slice(0, 8));
          }
        }
        runner?.unsubscribe(ws);
        const tHist = Date.now();
        const hist = await loadHistoryCached(m.id, info.cwd);
        const pg = historyPage(hist, hist.total, HISTORY_PAGE);
        const histMs = Date.now() - tHist;
        // 正在干活时插的话还没写进会话文件：补在最后，免得「发出去又不见了」
        const live = runners.get(m.id);
        if (live?.busy && live.steered?.length) {
          // 已经被 Claude 读到的插话会出现在会话文件里（整段历史里找，不只看这一页）：从待显示里去掉，只补还在排队的
          const seen = new Set(hist.items.filter(x => x.kind === 'user').map(x => x.text));
          live.steered = live.steered.filter(t => !seen.has(t));
          for (const t of live.steered) pg.items.push({ kind: 'user', text: t, queued: true });
        }
        if (!runners.has(m.id)) {
          const inherited = inheritedMode(info);
          const allowed = MODES.includes(inherited) ? MODES : [...MODES, inherited];
          log('open', m.id.slice(0, 8), 'inherit mode', inherited);
          runners.set(m.id, new Runner(info, inherited, allowed));
        }
        runner = runners.get(m.id);
        runners.set(m.id, runner);
        runner.subscribe(ws);
        touchWeb(m.id);
        if (ws.visible !== false) clearUnread(m.id);
        log('open', m.id.slice(0, 8), info.cwd, 'history ' + histMs + 'ms');
        send({
          t: 'session.opened', id: m.id, title: info.customTitle || info.summary, cwd: info.cwd,
          cwdShort: relPath(info.cwd || '', null), branch: info.gitBranch === 'HEAD' ? '' : info.gitBranch || '', mode: runner.mode, modes: runner.allowedModes, busy: runner.busy,
          history: pg.items, historyStart: pg.start, historyTotal: hist.total, historyMore: pg.more,
          busyFor: runner.busy && runner.busySince ? Date.now() - runner.busySince : 0,
          pending: [...runner.pending.values()].map(p => p.req),
          suggestion: runner.busy ? null : runner.suggestion || null,
          commands: runner.commands || null,
        });
      } else if (!runner) {
        send({ t: 'error', message: '还没有打开会话' });
      } else if (m.t === 'message.send') {
        const text = String(m.text || '').trim();
        const images = Array.isArray(m.images) ? m.images : [];
        if (images.length > MAX_IMAGES) return send({ t: 'error', message: '一次最多 ' + MAX_IMAGES + ' 张图片' });
        for (const i of images) {
          if (!IMAGE_TYPES.includes(i?.media_type) || typeof i.data !== 'string' || !/^[A-Za-z0-9+/=]+$/.test(i.data)) return send({ t: 'error', message: '图片格式不支持（只支持 JPEG / PNG / GIF / WebP）' });
          if (i.data.length > MAX_IMAGE_B64) return send({ t: 'error', message: '图片太大了' });
        }
        if (!text && !images.length) return;
        const acp = runner instanceof DsRunner || runner instanceof OpRunner;
        const sent = runner.send(text, images);
        if (!sent) send({ t: 'error', busy: runner.busy || undefined, message: acp && runner.busy ? '这一轮结束前只能排队普通消息（命令要等这一轮结束，最多排 10 条）' : '上一条还在处理中' });
        else runner.emit({ t: 'user', text, images: images.map(i => 'data:' + i.media_type + ';base64,' + i.data), queued: sent === 'queued' || undefined });
      } else if (m.t === 'permission.reply') {
        runner.replyPermission(m.requestId, m.decision, m.answers);
      } else if (m.t === 'interrupt') {
        await runner.interrupt();
      } else if (m.t === 'mode.set') {
        if (m.mode === 'bypassPermissions' && runner instanceof Runner && !runner.allowedModes.includes('bypassPermissions')) {
          // 「跳过确认」要在进程启动时就允许：这一轮结束后重启这个会话的进程，并记住（以后再打开也是跳过确认）
          if (runner.busy || runner.pending.size) return send({ t: 'error', message: '这一轮结束后再切到「跳过确认」（要重启这个会话的进程）' });
          runner = switchToBypass(runner);
        } else {
          await runner.setMode(m.mode);
          if (runner instanceof Runner && webSessions()[runner.id]?.force) rememberWebSession(runner.id, m.mode);   // 切回别的模式：不再强制
        }
      }
    } catch (e) {
      log('ws error', e?.message);
      send({ t: 'error', message: String(e?.message || e) });
    }
  }

  // 心跳：手机断网后连接会半开着，watched() 一直为真，于是不再推送通知、会话也不会空闲关闭。
  // 每 30 秒 ping 一轮，连续两轮没收到 pong 就判定连接已死，terminate 掉（close 回调照常清理）。
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('error', () => { try { ws.terminate(); } catch {} });

  ws.on('close', () => runner?.unsubscribe(ws));
});

// 每 30 秒 ping 一轮；连续两轮没有 pong 的连接直接 terminate
const WS_PING_MS = 30 * 1000;
setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) { try { ws.terminate(); } catch {} continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, WS_PING_MS).unref?.();

// 原处重新打开了这个会话 → 以用户在原处的操作为准，网页端立刻退出
setInterval(() => {
  if (!runners.size) return;
  const live = liveRegistry();
  for (const r of runners.values()) {
    if (r.closed) continue;
    const other = foreignHolders(r.id, live);
    if (other.length) {
      log('reclaimed by', other[0].entrypoint, other[0].pid, r.id.slice(0, 8));
      r.closeReason = 'reclaimed';
      r.emit({ t: 'session.reclaimed', entrypoint: other[0].entrypoint, name: other[0].name });
      r.dispose('reclaimed');
    }
  }
}, WATCH_MS);

skills.setupLocal(PORT, log);
skills.syncInstalled(log);
for (const host of HOSTS) {
  const srv = http.createServer(handler);
  srv.on('upgrade', onUpgrade);
  srv.on('error', e => log(`listen ${host}:${PORT} failed:`, e.code || e.message));
  srv.listen(PORT, host, () => log(`claclaw listening on http://${host}:${PORT}`));
}

function shutdown() {
  log('shutting down');
  for (const r of [...runners.values()]) r.dispose();
  for (const r of [...dsRunners.values()]) r.dispose();
  for (const r of [...opRunners.values()]) r.dispose();
  setTimeout(dsShutdown, 300);
  setTimeout(opShutdown, 300);
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
