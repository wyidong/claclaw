// claclaw —— 手机浏览器连本机 Claude Code 会话（阶段 1 最小原型）
// 现在只监听 127.0.0.1、没有认证；远程访问和密码等功能验证完再加。
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { query, listSessions, getSessionMessages, renameSession, createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import * as push from './push.mjs';
import { isOc, OcRunner, ocRunners, ocSessionList, ocRename, ocDelete, ocGatewayUp, ocCreate } from './openclaw.mjs';
import { hostInfo, slowInfo } from './host.mjs';
import { ttsVoices, ttsSynth, ttsWarm } from './tts.mjs';
import { loadPeer, savePeer, myName, newToken, hashToken, newId, findPeerByToken, lanIp, ourBase, PAIR_TTL, pendingList, addPending, getPending, dropPending, applyListener, peerStatus, callPeer, PEER_BASE } from './peer.mjs';
import { isDs, DsRunner, dsRunners, dsSessionList, dsNewSession, dsShutdown, dsSessionDir, dsAcpRunning } from './dsh.mjs';
const STARTED_AT = Date.now();
setTimeout(() => slowInfo(path.dirname(fileURLToPath(import.meta.url))).catch(() => {}), 3000);
import { DATA, verify, verifyMaster, setLastSet, setupMaster, isSetUp, describeCredential, issueToken, checkToken, revokeToken, TOKEN_TTL_MS } from './auth.mjs';

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

function isOurChild(pid) {
  try { return Number(execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)]).toString().trim()) === process.pid; } catch { return false; }
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
  const h = holders[0];
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
// 所以按「文件大小 + 修改时间」缓存，没变就直接用；列表刷新时顺手把最近几个会话预读好
const historyCache = new Map();
async function loadHistoryCached(sessionId, cwd) {
  let key = null;
  try { const st = fs.statSync(jsonlPathOf({ sessionId, cwd })); key = st.size + ':' + st.mtimeMs; } catch {}
  const hit = historyCache.get(sessionId);
  if (key && hit && hit.key === key) return hit.items;
  const items = await loadHistory(sessionId, cwd);
  if (key) {
    historyCache.delete(sessionId); historyCache.set(sessionId, { key, items });
    while (historyCache.size > 40) historyCache.delete(historyCache.keys().next().value);
  }
  return items;
}
let prewarming = false;
async function prewarmHistory(list) {
  if (prewarming) return;
  prewarming = true;
  try { for (const s of list.slice(0, 6)) if (s.cwd && !s.unsent) await loadHistoryCached(s.id, s.cwd); } catch {} finally { prewarming = false; }
}

async function loadHistory(sessionId, cwd) {
  const msgs = await getSessionMessages(sessionId, cwd ? { dir: cwd } : undefined);
  const items = [];
  const toolIdx = new Map();
  for (const m of msgs) {
    if (m.parent_tool_use_id) continue; // 子 Agent 内部的消息不展开
    const content = m.message?.content;
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
      if (peers.length) { for (const p of peers) items.push({ kind: 'peer', from: p.from, text: p.text }); continue; }
      const imgs = Array.isArray(content) ? content.filter(b => b.type === 'image' && b.source?.type === 'base64') : [];
      if (imgs.length && !/<command-name>/.test(t)) {
        items.push({ kind: 'user', text: isNoise(t) ? '' : t, images: imgs.map(b => b.source) });
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
  }
  return { items: items.slice(-HISTORY_KEEP), total: items.length };
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
        '查看协同对方（局域网里另一台电脑上、已经和我们配对的 claclaw 或兼容服务）有哪些会话可以对话。只在用户要你和「对方 / 另一台电脑的会话」沟通时使用。不填 peer 就列出所有已配对的对方。',
        { peer: z.string().optional().describe('对方名字（已配对列表里的名字），可省略') },
        async ({ peer }) => {
          const c = loadPeer();
          if (!c.enabled || !c.sessions.includes(sessionId)) return { content: [{ type: 'text', text: '这个会话没有加入 claclaw 协同' }], isError: true };
          const list = c.peers.filter(p => p.inbox && p.theirToken && (!peer || p.name === peer));
          if (!list.length) return { content: [{ type: 'text', text: peer ? '没有叫「' + peer + '」的已配对对方' : '还没有可以联系的已配对对方（对方配对时没有提供收件地址的话，只能由对方来找我们）' }], isError: true };
          const out = [];
          for (const p of list) {
            try { const j = await callPeer(p.inbox, '/sessions', { token: p.theirToken, ms: 15000 }); out.push({ peer: p.name, ok: j.ok, sessions: j.sessions, error: j.error }); }
            catch (e) { out.push({ peer: p.name, ok: false, error: e.message }); }
          }
          return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
        },
        { alwaysLoad: true },
      ),
      tool(
        'peer_send',
        '给协同对方（局域网里另一台电脑上、已配对的 AI 会话）发一条消息，等对方这一轮回复完，返回对方的回复原文（最多等 10 分钟）。' +
        '用于和对方的会话沟通、提问、交付结果。不要在消息里发送密码、令牌、密钥。' +
        '有多个已配对对方时用 peer 指定名字；对方有多个会话时用 session 指定（peer_sessions 列出的 id），只有一个时可以不填。',
        { text: z.string().describe('消息正文，4000 字以内'), peer: z.string().optional().describe('对方名字，只配对了一个时可省略'), session: z.string().optional().describe('对方会话 id，可省略') },
        async ({ text, peer, session }) => {
          const c = loadPeer();
          if (!c.enabled || !c.sessions.includes(sessionId)) return { content: [{ type: 'text', text: '这个会话没有加入 claclaw 协同' }], isError: true };
          const can = c.peers.filter(p => p.inbox && p.theirToken);
          const p = peer ? can.find(x => x.name === peer) : can.length === 1 ? can[0] : null;
          if (!p) return { content: [{ type: 'text', text: peer ? '没有叫「' + peer + '」的已配对对方' : can.length ? '有多个已配对对方，用 peer 指定：' + can.map(x => x.name).join('、') : '还没有可以联系的已配对对方' }], isError: true };
          const r = runners.get(sessionId);
          const from = (r?.info?.customTitle || r?.info?.summary || '会话') + ' · ' + myName(c);
          try {
            const j = await callPeer(p.inbox, '', { token: p.theirToken, body: { from, text: String(text).slice(0, 4000), session } });
            log('peer send', sessionId.slice(0, 8), '→', p.name, j.ok ? 'ok' : 'fail');
            return { content: [{ type: 'text', text: j.ok ? (j.reply || '（对方这一轮没有文字回复）') : '对方返回错误：' + (j.error || '未知') }], isError: !j.ok };
          } catch (e) { return { content: [{ type: 'text', text: e.message }], isError: true }; }
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
async function peerSessionInfos(c) {
  const list = await listSessions({ includeProgrammatic: true, limit: 2000 });
  return c.sessions.map(id => list.find(s => s.sessionId === id)).filter(Boolean);
}
// 把对方的消息送进会话，收集这一轮的回复
async function peerDeliver(info, text, from) {
  const id = info.sessionId;
  if (!runners.has(id)) {
    if (info.cwd && !fs.existsSync(info.cwd)) return [410, { ok: false, error: '会话目录已不存在' }];
    if (takeoverInfo(id, jsonlPathOf(info), liveRegistry())) return [409, { ok: false, error: '这个会话正在对方电脑的终端 / VS Code 里使用，暂时收不了消息' }];
    const inherited = inheritedMode(info);
    runners.set(id, new Runner(info, inherited, MODES.includes(inherited) ? MODES : [...MODES, inherited]));
  }
  const r = runners.get(id);
  if (r.busy) return [409, { ok: false, error: '这个会话正在忙，稍后再发' }];
  const msg = '【claclaw 协同 · 来自对方：' + from + '】\n' + text;
  return new Promise(resolve => {
    let reply = '', cur = '', done = false;
    const sub = { readyState: 1, visible: false, send(raw) {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'ai.start') cur = '';
      else if (m.t === 'ai.delta') cur += m.text || '';
      else if (m.t === 'ai.end') { if (cur.trim()) reply = cur; cur = ''; }
      else if (m.t === 'ai.full') { if (m.text?.trim()) reply = m.text; }
      else if (m.t === 'turn.done') end(200, { ok: m.subtype === 'success', reply: (cur.trim() || reply).trim(), error: m.error });
    } };
    const end = (code, obj) => { if (done) return; done = true; clearTimeout(timer); r.unsubscribe(sub); resolve([code, obj]); };
    const timer = setTimeout(() => end(504, { ok: false, error: '10 分钟内没等到回复', partial: (cur || reply).trim() }), 10 * 60 * 1000);
    r.subscribe(sub);
    r.send(msg);
    r.emit({ t: 'user', text: msg, images: [] });
  });
}
const peerBusy = new Set();
const cleanIp = ip => String(ip || '').replace(/^::ffff:/, '');
async function peerHandler(req, res) {
  const out = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const c = loadPeer();
  const u = new URL(req.url, 'http://x');
  const sub = u.pathname.replace(/\/+$/, '');
  if (!c.enabled || (sub !== PEER_BASE && !sub.startsWith(PEER_BASE + '/'))) { res.writeHead(404); return res.end(); }
  const route = sub.slice(PEER_BASE.length) || '/';
  const ip = cleanIp(req.socket.remoteAddress);
  const readJson = async () => { try { return JSON.parse(await readBody(req, 64 * 1024)); } catch { return null; } };
  try {
    // 1. 配对申请：谁都可以申请，但要我们这边的人把两位数配对码告诉对方才能完成
    if (route === '/pair') {
      if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST' });
      const b = await readJson() || {};
      const name = String(b.name || '').replace(/\s+/g, ' ').trim().slice(0, 40) || ip;
      const inbox = /^https?:\/\/\S+$/i.test(String(b.inbox || '')) ? String(b.inbox).slice(0, 2000) : '';
      let p; try { p = addPending(name, ip, inbox); } catch (e) { return out(e.code || 400, { ok: false, error: e.message }); }
      log('peer pair request from', ip, name);
      localSound();
      push.sendAll({ title: 'claclaw 协同', body: name + '（' + ip + '）申请配对，配对码 ' + p.code, tag: 'peer-pair', url: '/?view=peer' }, log).catch(() => {});
      return out(200, { ok: true, requestId: p.id, expiresIn: Math.round(PAIR_TTL / 1000), message: '已提交配对申请：请向对方要两位数配对码，然后调用 pair/confirm' });
    }
    if (route === '/pair/confirm') {
      if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST' });
      const b = await readJson() || {};
      const p = getPending(String(b.requestId || ''));
      if (!p) return out(404, { ok: false, error: '配对申请不存在或已过期，请重新申请' });
      if (String(b.code || '').trim() !== p.code) {
        p.tries++;
        if (p.tries >= 3) { dropPending(p.id); return out(403, { ok: false, error: '配对码错了 3 次，这次申请作废，请重新申请' }); }
        return out(403, { ok: false, error: '配对码不对，还能试 ' + (3 - p.tries) + ' 次' });
      }
      dropPending(p.id);
      const token = newToken();
      const theirToken = typeof b.token === 'string' && b.token.length >= 16 ? b.token.slice(0, 200) : '';
      const c2 = loadPeer();
      c2.peers = c2.peers.filter(x => !(x.inbox && x.inbox === p.inbox && p.inbox));   // 同一个对方地址重新配对：替换旧的
      c2.peers.push({ id: newId(), name: p.name, ip: p.ip, inbox: p.inbox, tokenHash: hashToken(token), theirToken, pairedAt: Date.now(), lastSeen: Date.now() });
      savePeer(c2);
      log('peer paired', p.ip, p.name, theirToken ? 'two-way' : 'one-way');
      return out(200, { ok: true, token, name: myName(c2), inbox: ourBase(c2) });
    }
    // 2. 配对后的正常收发：请求头带钥匙
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    const peer = findPeerByToken(c, auth);
    if (!peer) return out(401, { ok: false, error: '还没配对，或钥匙不对：先 POST ' + PEER_BASE + '/pair 申请配对' });
    if (peer.ip !== ip || Date.now() - (peer.lastSeen || 0) > 60000) { peer.ip = ip; peer.lastSeen = Date.now(); savePeer(c); }
    const infos = await peerSessionInfos(c);
    const brief = infos.map(s => ({ id: s.sessionId.slice(0, 8), title: s.customTitle || s.summary || '', busy: !!runners.get(s.sessionId)?.busy }));
    if (route === '/sessions') return out(200, { ok: true, name: myName(c), sessions: brief });
    if (route !== '/') return out(404, { ok: false, error: '没有这个接口' });
    if (req.method !== 'POST') return out(405, { ok: false, error: '用 POST 发消息' });
    let body = ''; try { body = await readBody(req, 64 * 1024); } catch { return out(413, { ok: false, error: '消息太长' }); }
    let text = body, from = '', want = '';
    try { const j = JSON.parse(body); text = j.text; from = String(j.from || '').replace(/\s+/g, ' ').slice(0, 60); want = String(j.session || ''); } catch {}
    text = String(text || '').trim();
    if (!text) return out(400, { ok: false, error: '消息是空的' });
    if (text.length > 4000) return out(413, { ok: false, error: '消息太长（最多 4000 字）' });
    const info = want ? infos.find(s => s.sessionId.startsWith(want.toLowerCase())) : infos.length === 1 ? infos[0] : null;
    if (!info) return out(400, { ok: false, error: want ? '没有这个会话' : '有多个会话，用 session 指定一个', sessions: brief });
    if (peerBusy.has(info.sessionId)) return out(429, { ok: false, error: '上一条还在处理，稍后再发' });
    peerBusy.add(info.sessionId);
    log('peer in', peer.name, ip, '→', info.sessionId.slice(0, 8), text.length + ' chars');
    try { const [code, obj] = await peerDeliver(info, text, peer.name + (from && from !== peer.name ? ' · ' + from : '')); out(code, obj); }
    finally { peerBusy.delete(info.sessionId); }
  } catch (e) { out(500, { ok: false, error: e.message }); }
}
// 我们向对方发起的配对（只放内存）
let outPair = null;   // {base, requestId, token, expiresAt}
function peerPublic(c, local) {
  return {
    local, enabled: c.enabled, port: c.port, dir: c.dir, sessions: c.sessions, name: myName(c),
    ip: lanIp(), base: ourBase(c), ...peerStatus(),
    pending: pendingList().map(p => ({ id: p.id, name: p.name, ip: p.ip, two: !!p.inbox, expiresAt: p.expiresAt, code: local ? p.code : undefined })),
    peers: c.peers.map(p => ({ id: p.id, name: p.name, ip: p.ip, inbox: local ? p.inbox : undefined, canCall: !!(p.inbox && p.theirToken), pairedAt: p.pairedAt, lastSeen: p.lastSeen })),
    outPair: outPair && outPair.expiresAt > Date.now() ? { base: outPair.base, expiresAt: outPair.expiresAt } : null,
  };
}
setTimeout(() => applyListener(loadPeer(), peerHandler, log), 1000);

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
          else if (m.state === 'idle' && this.busy) { this.busy = false; this.emit({ t: 'busy', on: false }); this.maybeScheduleClose(); }
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
  fs.writeFileSync(SETTINGS, JSON.stringify(next, null, 2), { mode: 0o600 });
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
  push.sendAll({ title: r.title || (isDs(r.id) ? 'DeepSeek' : 'OpenClaw'), body: ok ? snippet(text, '回复完了') : '这一轮出错结束了', tag: 'done-' + r.id, url: '/?s=' + encodeURIComponent(r.id), badge }, log).catch(() => {});
}
// DeepSeek 会话要你确认操作：没人看着就推送
function dsAsk(r, body) {
  if (r.watched()) return;
  localSound();
  const badge = markUnread(r.id);
  push.sendAll({ title: r.title || 'DeepSeek', body, tag: 'perm-' + r.id, url: '/?s=' + encodeURIComponent(r.id), badge }, log).catch(() => {});
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
  return [
    { id: 'claude', installed: fs.existsSync(path.join(HOME, '.claude', 'projects')), supported: true },
    { id: 'openclaw', installed: fs.existsSync(path.join(HOME, '.openclaw', 'openclaw.json')) || inPath('openclaw'), supported: true },
    { id: 'deepseek', installed: fs.existsSync(path.join(HOME, '.dsh')) || inPath('dsh'), supported: true },
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
  fs.writeFileSync(UNREAD_FILE, JSON.stringify(u), { mode: 0o600 });
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
    try { fs.writeFileSync(WEB_ACTIVE_FILE, JSON.stringify(webActive), { mode: 0o600 }); } catch {}
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
function rememberWebSession(id, mode) {
  const all = webSessions();
  all[id] = { mode };
  fs.mkdirSync(DATA, { recursive: true, mode: 0o700 });
  const tmp = WEB_SESSIONS + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, WEB_SESSIONS);
}
// 会话该继承的模式：原处（VS Code / 终端）最后用的优先；网页新建的会话用新建时记下的
function inheritedMode(info) {
  const m = originalMode(jsonlPathOf(info)) || webSessions()[info.sessionId]?.mode;
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
  return list.filter(resumable).map(s => {
    const ours = runners.has(s.sessionId);
    const elsewhere = ours ? null : takeoverInfo(s.sessionId, jsonlPathOf(s), live);
    return {
      id: s.sessionId,
      title: s.customTitle || s.summary || s.firstPrompt || '(无标题)',
      cwd: s.cwd || '',
      cwdShort: relPath(s.cwd || '', null),
      branch: s.gitBranch === 'HEAD' ? '' : s.gitBranch || '',   // HEAD：不是 git 目录（或没在任何分支上），不显示
      // 没有分支的会话：列表里标题下面显示最后一条用户消息
      lastPrompt: s.gitBranch && s.gitBranch !== 'HEAD' ? undefined : lastPromptOf(jsonlPathOf(s)) || s.firstPrompt || undefined,
      lastModified: s.lastModified,
      openInWeb: ours,
      busyElsewhere: elsewhere,
      unread: unread[s.sessionId] || 0,
      webActive: webActive[s.sessionId] || 0,
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
const fails = new Map(); // ip -> { n, until }
const MAX_FAILS = 5, LOCK_MS = 10 * 60 * 1000;

function cookieToken(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)claclaw_sid=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const authed = req => checkToken(cookieToken(req));

function readBody(req, max = 4096) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > max) { reject(new Error('too large')); req.destroy(); } });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

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
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return sendJson(res, 429, { error: '失败次数太多，请 ' + Math.ceil((f.until - Date.now()) / 60000) + ' 分钟后再试' });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  const via = verify(body.username, body.password);
  if (!via) {
    const n = (f && f.until > Date.now() ? f.n : (f?.n || 0)) + 1;
    fails.set(ip, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    log('login failed from', ip);
    return sendJson(res, 401, { error: n >= MAX_FAILS ? '失败次数太多，10 分钟内不能再试' : '用户名或密码不对' });
  }
  fails.delete(ip);
  const token = issueToken(via, ip);
  log('login ok from', ip, 'via', via);
  sendJson(res, 200, { ok: true }, { 'set-cookie': loginCookie(token) });
}

// ---------- 删除会话：要求再次输入初始账号；文件挪进 data/trash/，不直接删 ----------

const TRASH = path.join(DATA, 'trash');

async function handleDelete(req, res) {
  const ip = req.socket.remoteAddress;
  const f = fails.get(ip);
  if (f && f.until > Date.now()) return sendJson(res, 429, { error: '失败次数太多，请 ' + Math.ceil((f.until - Date.now()) / 60000) + ' 分钟后再试' });
  if (!/application\/json/.test(req.headers['content-type'] || '')) return sendJson(res, 415, { error: 'bad request' });
  let body = {};
  try { body = JSON.parse(await readBody(req)); } catch {}
  if (!verifyMaster(body.username, body.password)) {
    const n = (f?.n || 0) + 1;
    fails.set(ip, { n: n >= MAX_FAILS ? 0 : n, until: n >= MAX_FAILS ? Date.now() + LOCK_MS : 0 });
    log('delete: wrong initial credentials from', ip);
    return sendJson(res, 401, { error: n >= MAX_FAILS ? '失败次数太多，10 分钟内不能再试' : '初始用户名或密码不对' });
  }
  fails.delete(ip);
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
  if (isDs(body.id)) return sendJson(res, 400, { error: 'DeepSeek 会话暂不支持改名' });
  const list = await listSessions({ includeProgrammatic: true, limit: 2000 });
  const info = list.find(s => s.sessionId === body.id);
  if (!info) return sendJson(res, 404, { error: '找不到这个会话' });
  await renameSession(info.sessionId, title, info.cwd ? { dir: info.cwd } : undefined);
  runners.get(info.sessionId)?.emit({ t: 'session.renamed', title });
  log('renamed session', info.sessionId.slice(0, 8));
  sendJson(res, 200, { ok: true, title });
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
    if (url.pathname === '/api/claws') return sendJson(res, 200, detectClaws());
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
      try { return sendJson(res, 200, await ocSessionList(log), { 'cache-control': 'no-store' }); }
      catch (e) { return sendJson(res, 502, { error: e.message }); }
    }
    if (url.pathname === '/api/peer' || url.pathname.startsWith('/api/peer/')) {
      const local = isLocalReq(req), c = loadPeer();
      if (req.method === 'GET' && url.pathname === '/api/peer') return sendJson(res, 200, peerPublic(c, local));
      if (!local) return sendJson(res, 403, { error: '只能在这台电脑上用 127.0.0.1 打开网页时设置协同' });
      let b = {}; try { b = JSON.parse(await readBody(req, 16 * 1024) || '{}'); } catch {}
      const act = url.pathname.slice('/api/peer'.length);
      if (act === '/reject') { dropPending(String(b.id || '')); return sendJson(res, 200, peerPublic(loadPeer(), true)); }
      if (act === '/revoke') { c.peers = c.peers.filter(p => p.id !== b.id); savePeer(c); log('peer revoked', b.id); return sendJson(res, 200, peerPublic(c, true)); }
      if (act === '/check') {
        // 已配对的对方在不在线：能用钥匙列出对方的会话就算在线
        const out = await Promise.all(c.peers.map(async p => {
          if (!p.inbox || !p.theirToken) return { id: p.id, online: null };
          try { const j = await callPeer(p.inbox, '/sessions', { token: p.theirToken, ms: 6000 }); return { id: p.id, online: !!j.ok, sessions: j.sessions || [], error: j.ok ? undefined : j.error }; }
          catch (e) { return { id: p.id, online: false, error: e.message }; }
        }));
        return sendJson(res, 200, out);
      }
      if (act === '/pair-start') {
        // 我们向对方申请配对：对方页面会出现申请和两位数配对码，对方的人把码告诉你
        const base = String(b.url || '').trim().replace(/\/+$/, '');
        if (!/^https?:\/\/\S+$/i.test(base)) return sendJson(res, 400, { error: '对方地址要以 http:// 开头，例如 http://192.168.1.x:8788/claclaw-peer' });
        if (!c.enabled) return sendJson(res, 400, { error: '先开启我们这边的协同（对方要能回连我们）' });
        try {
          const j = await callPeer(base, '/pair', { body: { name: myName(c), inbox: ourBase(c) }, ms: 8000 });
          if (!j.ok || !j.requestId) return sendJson(res, 200, { error: '对方没有接受申请：' + (j.error || 'HTTP ' + j.status) });
          outPair = { base, requestId: j.requestId, token: newToken(), expiresAt: Date.now() + (Number(j.expiresIn) || 300) * 1000 };
          return sendJson(res, 200, peerPublic(c, true));
        } catch (e) { return sendJson(res, 200, { error: e.message }); }
      }
      if (act === '/pair-finish') {
        if (!outPair || outPair.expiresAt < Date.now()) return sendJson(res, 400, { error: '配对申请已过期，请重新发起' });
        try {
          const j = await callPeer(outPair.base, '/pair/confirm', { body: { requestId: outPair.requestId, code: String(b.code || '').trim(), token: outPair.token }, ms: 8000 });
          if (!j.ok || !j.token) { if (/作废|过期|不存在/.test(j.error || '')) outPair = null; return sendJson(res, 200, { error: j.error || '配对失败' }); }
          const c2 = loadPeer();
          c2.peers = c2.peers.filter(p => p.inbox !== outPair.base);
          c2.peers.push({ id: newId(), name: String(j.name || '').slice(0, 40) || new URL(outPair.base).hostname, ip: new URL(outPair.base).hostname, inbox: outPair.base, tokenHash: hashToken(outPair.token), theirToken: j.token, pairedAt: Date.now(), lastSeen: Date.now() });
          savePeer(c2); outPair = null;
          log('peer paired (we asked)', c2.peers.at(-1).name);
          return sendJson(res, 200, { ...peerPublic(c2, true), paired: c2.peers.at(-1).name });
        } catch (e) { return sendJson(res, 200, { error: e.message }); }
      }
      if (act === '/pair-cancel') { outPair = null; return sendJson(res, 200, peerPublic(c, true)); }
      if (act !== '') return sendJson(res, 404, { error: 'not found' });
      if (b.port != null) { const p = Number(b.port); if (!Number.isInteger(p) || p < 1024 || p > 65535 || p === PORT) return sendJson(res, 400, { error: '端口要在 1024–65535 之间，且不能和 claclaw 自己的端口相同' }); c.port = p; }
      if (typeof b.dir === 'string') c.dir = b.dir;
      if (typeof b.name === 'string') c.name = b.name.replace(/\s+/g, ' ').trim().slice(0, 40);
      if (Array.isArray(b.sessions)) c.sessions = b.sessions.filter(x => typeof x === 'string' && /^[0-9a-f-]{36}$/.test(x)).slice(0, 50);
      if (typeof b.enabled === 'boolean') c.enabled = b.enabled;
      if (c.enabled && !c.sessions.length) return sendJson(res, 400, { error: '先选至少一个会话加入协同' });
      savePeer(c);
      applyListener(c, peerHandler, log);
      await new Promise(ok => setTimeout(ok, 300));   // 等监听结果（端口被占用会马上报错）
      log('peer config saved', c.enabled ? 'on' : 'off', c.sessions.length, 'sessions');
      return sendJson(res, 200, peerPublic(c, true));
    }
    // 电脑合成语音：手机网页拿去播放（登录后才能用）
    if (url.pathname === '/api/tts/voices') return sendJson(res, 200, await ttsVoices());
    if (url.pathname === '/api/tts/warm' && req.method === 'POST') { ttsWarm(); return sendJson(res, 200, { ok: true }); }
    if (url.pathname === '/api/tts' && req.method === 'POST') {
      let b = {}; try { b = JSON.parse(await readBody(req, 8192)); } catch {}
      try {
        const { buf, type } = await ttsSynth(b.text, String(b.voice || ''), b.rate);
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
      const info = await hostInfo({
        root: ROOT, port: PORT, hosts: HOSTS, https: getHttpsUrl(), startedAt: STARTED_AT,
        sessions: { claude: count(runners), openclaw: count(ocRunners), deepseek: count(dsRunners), push: push.subscriptionCount() },
        claws: { claude: { ...claws.claude, ...count(runners) }, openclaw: { ...claws.openclaw, ...count(ocRunners) }, deepseek: { ...claws.deepseek, ...count(dsRunners) } },
      });
      return sendJson(res, 200, info, { 'cache-control': 'no-store' });
    }
    if (url.pathname === '/api/sessions' && url.searchParams.get('claw') === 'deepseek') {
      try { return sendJson(res, 200, dsSessionList({ busy: id => !!dsRunners.get(id)?.busy }), { 'cache-control': 'no-store' }); }
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

  ws.on('message', async raw => {
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    try {
      if (m.t === 'visible') { ws.visible = !!m.on; if (ws.visible && runner) clearUnread(runner.id); return; }
      // 手机回到会话列表页：不再看着这个会话（推送、未读、空闲关闭都照常算）
      if (m.t === 'session.leave') { runner?.unsubscribe(ws); runner = null; return; }
      // 往上滑：要 before（绝对序号）之前的一页
      if (m.t === 'history.more') {
        if (!runner) return;
        if (runner instanceof DsRunner) {
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
      if (m.t === 'session.new' && (isDs(m.from) || m.claw === 'deepseek')) {
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
        runner?.unsubscribe(ws);
        let r = dsRunners.get(m.id);
        if (!r) { r = new DsRunner(m.id, dsOpts()); dsRunners.set(m.id, r); }
        const hist = r.history();
        if (!hist.total && !r.attached) { dsRunners.delete(m.id); runner = null; return send({ t: 'error', message: '找不到这个会话' }); }
        runner = r;
        r.subscribe(ws);
        if (ws.visible !== false) clearUnread(m.id);
        const pg = historyPage(hist, hist.total, HISTORY_PAGE);
        log('open dsh', r.sid, hist.total, 'items');
        send({
          t: 'session.opened', id: m.id, title: r.title, cwd: r.cwd, cwdShort: r.metaLine(), claw: 'deepseek',
          mode: 'default', modes: ['default'], busy: r.busy, commands: r.commands,
          history: pg.items, historyStart: pg.start, historyTotal: hist.total, historyMore: pg.more,
          busyFor: r.busy && r.busySince ? Date.now() - r.busySince : 0,
          pending: [...r.pending.values()].map(p => p.req), suggestion: null,
        });
      } else if (m.t === 'session.open' && isOc(m.id)) {
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
        if (!runner.send(text, images)) send({ t: 'error', message: '上一条还在处理中' });
        else runner.emit({ t: 'user', text, images: images.map(i => 'data:' + i.media_type + ';base64,' + i.data) });
      } else if (m.t === 'permission.reply') {
        runner.replyPermission(m.requestId, m.decision, m.answers);
      } else if (m.t === 'interrupt') {
        await runner.interrupt();
      } else if (m.t === 'mode.set') {
        await runner.setMode(m.mode);
      }
    } catch (e) {
      log('ws error', e?.message);
      send({ t: 'error', message: String(e?.message || e) });
    }
  });

  ws.on('close', () => runner?.unsubscribe(ws));
});

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
  setTimeout(dsShutdown, 300);
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
