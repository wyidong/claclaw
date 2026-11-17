// Claude 会话记录（~/.claude/projects/<目录>/<id>.jsonl）的读取，server.mjs 用：
// 列表要的（最后一条消息 / 时间、累计用量、上下文大小、原处的权限模式）、打开时的历史（按「轮」增量解析）、工具卡片的显示。
// 只读文件，不改；不碰网页、进程这些（那些在 server.mjs）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { getSessionMessages } from '@anthropic-ai/claude-agent-sdk';
import { userTextOf } from './dissect.mjs';
import { relPath } from './util.mjs';

const HOME = os.homedir();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
// 打开会话时服务器最多保留最近这么多条历史
const HISTORY_KEEP = 600;

// 原会话在原处（VS Code / 终端）最后一次用的权限模式（modes 里有的）：从会话记录末尾往前找 user 记录的 permissionMode，
// 跳过网页（entrypoint=sdk-ts）自己写的，否则网页用过一次就把原来的模式盖掉了
export function originalMode(file, modes) {
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
          if (o.type === 'user' && o.permissionMode && o.entrypoint !== 'sdk-ts' && modes.includes(o.permissionMode)) return o.permissionMode;
        } catch {}
      }
    }
  } finally { fs.closeSync(fd); }
  return null;
}
const OUT_MAX = 4000;

export const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

// 协同 / 本机会话发来的消息，列表里的缩略不显示给 AI 看的那段说明，改成「对方别名· 正文 / 👉🏻会话名· 正文（正文只取前 20 个字）
export function peerPreview(t) {
  const m = /^【claclaw (协同|本机) · 来自(?:对方|会话)：([\s\S]*?)（你的会话 ID[^】]*）】\n?/.exec(t || '');
  if (!m) return t;
  const who = m[1] === '协同' ? m[2].split(' · ')[0] : m[2].replace(/（[^（）]*）\s*$/, '');
  return (m[1] === '协同' ? '「' : '👉🏻') + who.trim() + '· ' + t.slice(m[0].length).replace(/\s+/g, ' ').trim().slice(0, 20);
}
// 读文件末尾 n 字节（不到 n 就整个），按行拆开；size 不给就现查
function tailLines(file, n, size) {
  const fd = fs.openSync(file, 'r');
  try {
    size ??= fs.fstatSync(fd).size;
    const len = Math.min(size, n), buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } finally { fs.closeSync(fd); }
}
// 「读会话文件最后 512KB 算出一个值」按文件大小 + 修改时间缓存（文件没变就不再读）；文件读不了算 empty
function tailMemo(calc, empty) {
  const cache = new Map();
  return file => {
    let st; try { st = fs.statSync(file); } catch { return empty; }
    const key = st.size + ':' + st.mtimeMs, c = cache.get(file);
    if (c && c.key === key) return c.v;
    let lines = []; try { lines = tailLines(file, 512 * 1024, st.size); } catch {}
    const v = calc(lines);
    cache.set(file, { key, v });
    if (cache.size > 3000) cache.delete(cache.keys().next().value);
    return v;
  };
}
// 会话最后一条用户消息：Claude Code 每轮都往会话文件末尾写 {"type":"last-prompt"}，只读文件尾部找最后一条
// 优先取最后一条真正的用户消息（刚发出去、还在处理中的也算）；last-prompt 记录要等进程退出才写，会落后
export const lastPromptOf = tailMemo(lines => {
  let text = '', meta = '';
  for (let i = lines.length - 1; i >= 0 && !text; i--) {
    const l = lines[i];
    if (!meta && l.includes('"type":"last-prompt"')) { try { meta = String(JSON.parse(l).lastPrompt || ''); } catch {} continue; }
    if (l[0] !== '{' || !l.includes('"type":"user"')) continue;
    try { text = userTextOf(JSON.parse(l)); } catch {}
  }
  return peerPreview(text || meta).replace(/\s+/g, ' ').trim().slice(0, 200);
}, '');
// 会话累计用量：所有 AI 回复的 usage 相加。↑ 输入 = input + 缓存写入 + 缓存读取（每次调用都把整个上下文送一遍，所以很大），↓ 输出 = output。
// 同一条回复流式写好几行（message.id 相同），只算最后一行。会话文件只会追加：记住读到哪，下次只读新增部分
const usageCache = new Map();
export function usageOf(file) {
  let st; try { st = fs.statSync(file); } catch { return null; }
  let c = usageCache.get(file);
  if (!c || st.size < c.size) c = { size: 0, in: 0, out: 0, lastId: null, last: null, rest: '' };
  if (st.size > c.size) {
    const CH = 4 * 1024 * 1024; let pos = c.size, fd;
    try {
      fd = fs.openSync(file, 'r');
      while (pos < st.size) {
        const n = Math.min(CH, st.size - pos), buf = Buffer.alloc(n);
        fs.readSync(fd, buf, 0, n, pos); pos += n;
        const lines = (c.rest + buf.toString('utf8')).split('\n'); c.rest = lines.pop();
        for (const l of lines) {
          if (!l.includes('"usage"') || !l.includes('"type":"assistant"')) continue;
          let e; try { e = JSON.parse(l); } catch { continue; }
          const m = e.message, u = m && m.usage; if (e.type !== 'assistant' || !u) continue;
          const i = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), o = u.output_tokens || 0;
          if (m.id && m.id === c.lastId && c.last) { c.in -= c.last[0]; c.out -= c.last[1]; }
          c.in += i; c.out += o; c.lastId = m.id || null; c.last = [i, o];
        }
      }
    } catch { return null; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch {} }
    c.size = st.size;
    if (c.rest.length > 1048576) c.rest = '';
    usageCache.set(file, c);
  }
  return c.in || c.out ? { in: c.in, out: c.out } : null;
}
// 会话最后一条真正的消息（用户 / AI / 工具结果）的时间。不能用文件修改时间：Claude Code 进程退出、重启时会往文件末尾补
// cost-state、last-prompt 这类记录，文件时间变了但没有新消息（重启 claclaw 后一批会话会被顶到「最近」最上面）
export const lastMsgAt = tailMemo(lines => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{') || !(l.includes('"type":"user"') || l.includes('"type":"assistant"'))) continue;
    try { const e = JSON.parse(l); if ((e.type === 'user' || e.type === 'assistant') && e.timestamp) { const at = Date.parse(e.timestamp) || 0; if (at) return at; } } catch {}
  }
  return 0;
}, 0);
// 会话的 git 分支；HEAD = 不是 git 目录（或没在任何分支上），不显示
export const branchOf = info => info.gitBranch === 'HEAD' ? '' : info.gitBranch || '';
export function jsonlPathOf(info) {
  // ~/.claude/projects/<cwd 中非字母数字换成 -> /<id>.jsonl
  return path.join(HOME, '.claude', 'projects', String(info.cwd || '').replace(/[^A-Za-z0-9]/g, '-'), info.sessionId + '.jsonl');
}

// ---------- 把工具调用整理成卡片要显示的东西 ----------


const LOGIN_TOOL = 'mcp__claclaw__set_web_login';

export function toolTarget(name, input, cwd) {
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
export function toolDiff(name, input) {
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

export function resultText(content) {
  let s = '';
  if (typeof content === 'string') s = content;
  else if (Array.isArray(content)) s = content.map(b => (b.type === 'text' ? b.text : b.type === 'image' ? '[图片]' : '')).join('\n');
  return s.length > OUT_MAX ? s.slice(0, OUT_MAX) + '\n… 已截断' : s;
}

export function userText(content) {
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
export function peerMessages(text) {
  return [...String(text || '').matchAll(/<cross-session-message\b([^>]*)>([\s\S]*?)<\/cross-session-message>/g)].map(m => {
    const attr = k => (m[1].match(new RegExp(k + '="([^"]*)"')) || [])[1] || '';
    return { from: attr('from-name') || attr('from'), text: m[2].trim() };
  });
}

// 当前上下文大小（tokens）：会话文件里最后一次 API 调用的输入量（输入 + 缓存读 + 缓存写）。
// 只读文件末尾 4MB；先碰到压缩记录就用压缩后的大小（没记就算不知道）。子 Agent 的不算。
export function ctxFromFile(info) {
  let lines; try { lines = tailLines(jsonlPathOf(info), 4 << 20); } catch { return null; }
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.includes('"compact_boundary"')) { const p = l.match(/"postTokens":(\d+)/); return p ? +p[1] : null; }
    if (!l.includes('"type":"assistant"') || !l.includes('"usage"') || l.includes('"isSidechain":true')) continue;
    try { const n = ctxTokens(JSON.parse(l).message?.usage); if (n) return n; } catch {}
  }
  return null;
}
export const kTok = n => (n >= 1000 ? Math.round(n / 1000) + 'k' : String(n ?? '?'));
export function ctxTokens(u) { return u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0; }

// ---------- 打开会话时的历史记录：按「轮」增量解析 ----------
// 会话文件只会追加。每个会话记住「最后一轮从哪个字节开始」和它之前的聊天条目（最多 HISTORY_KEEP 条，图片带 base64）；
// 再打开时只读、只解析最后一轮开头之后的部分：新增里又出现新的轮，前面的轮并进缓存，最后一轮每次重解析（一轮通常很小）。
// 压缩分界也当轮的边界。文件大小 + 修改时间没变时连最后一轮都不用解析，直接给上次的结果。
// 大会话（100MB 级）以前每次打开都要整个读一遍（2～8 秒），现在只有第一次。
const HISTORY_CACHE_MAX = 64 * 1024 * 1024;
const histInc = new Map();   // sessionId → { ino, headEnd, items, dropped, bytes, key, last }
let histIncBytes = 0;
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
// 超过总字节上限 / 会话数上限：从最久没用的开始淘汰，正在用的这个不淘汰
function histIncEvict(keep) {
  while (histInc.size > 40 || histIncBytes > HISTORY_CACHE_MAX) {
    let victim = null;
    for (const k of histInc.keys()) if (k !== keep) { victim = k; break; }
    if (!victim) break;
    histIncBytes -= histInc.get(victim).bytes; histInc.delete(victim);
  }
}
// 读文件 [from, to) 这段，按行解析成记录；每条带起始字节位置和区段内的行号。末尾没换行的半行（可能还在写）不要
function readEntries(file, from, to) {
  const n = to - from; if (n <= 0) return [];
  const buf = Buffer.alloc(n); let fd;
  try { fd = fs.openSync(file, 'r'); fs.readSync(fd, buf, 0, n, from); } finally { if (fd != null) try { fs.closeSync(fd); } catch {} }
  const entries = []; let pos = 0, line = 0;
  while (pos < n) {
    const nl = buf.indexOf(10, pos); if (nl < 0) break;
    if (nl > pos && buf[pos] === 123) { try { entries.push({ e: JSON.parse(buf.toString('utf8', pos, nl)), off: from + pos, line }); } catch {} }
    line++; pos = nl + 1;
  }
  return entries;
}
// 一轮的开头：用户真正说的一句话（工具结果、系统注入、斜杠命令不算），或一次压缩分界
const turnStart = e => (e.type === 'system' && e.subtype === 'compact_boundary') || (e.type === 'user' && !!userTextOf(e));

// 一段记录 → 聊天条目。SDK 顺着 parentUuid 还原对话链（只给它这一段，不让它再读文件）；
// 压缩分界切段、各取一条链再接起来，压缩摘要（isCompactSummary）换成一行「已压缩」；
// 干活中途的插话（attachment queued_command，SDK 不返回）按在文件里的位置插回；每条带时间
async function itemsOf(sessionId, cwd, entries) {
  const opt = cwd ? { dir: cwd } : undefined;
  const cuts = [], hide = new Set(), lineOf = new Map(), timeOf = new Map(), queued = [];
  entries.forEach(({ e, line }, k) => {
    if (e.type === 'system' && e.subtype === 'compact_boundary') cuts.push({ at: k, meta: e.compactMetadata || {} });
    if (e.isCompactSummary && e.uuid) hide.add(e.uuid);
    const t = e.timestamp ? Date.parse(e.timestamp) : 0;
    if (e.uuid) { lineOf.set(e.uuid, line); if (t) timeOf.set(e.uuid, t); }
    if (e.source_uuid && t && !timeOf.has(e.source_uuid)) timeOf.set(e.source_uuid, t);   // 插话被吸收进这一轮时，SDK 用 source_uuid 合成的那条：时间取插话那一刻
    const pr = e.attachment?.prompt;
    if (e.attachment?.type === 'queued_command' && pr) queued.push({ i: line, text: typeof pr === 'string' ? pr : userText(pr), at: t || undefined });
  });
  const msgs = [], seen = new Set(), segs = cuts.map(c => c.at).concat(entries.length);
  for (let i = 0, from = 0; i < segs.length; from = segs[i], i++) {
    const part = entries.slice(from, segs[i]).map(x => x.e);
    if (part.length) {
      let list = [];
      try { list = await getSessionMessages(sessionId, { ...opt, sessionStore: { load: async () => part, append: async () => {} } }); } catch (e) { log('history chain', sessionId.slice(0, 8), e.message); }
      for (const m of list) { if (m.uuid) { if (seen.has(m.uuid) || hide.has(m.uuid)) continue; seen.add(m.uuid); } msgs.push(m); }
    }
    if (i < cuts.length) msgs.push({ type: 'compact', uuid: '', meta: cuts[i].meta });
  }
  const items = [], toolIdx = new Map();
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
    if (m.type === 'compact') {
      const c = m.meta;
      items.push({ kind: 'sys', text: (c.trigger === 'auto' ? '已自动压缩会话历史' : '已压缩会话历史') + (c.preTokens ? '（' + kTok(c.preTokens) + (c.postTokens != null ? ' → ' + kTok(c.postTokens) : '') + ' tokens）' : '') });
      continue;
    }
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
  return items;
}

// 插话没赶上这一轮、变成下一轮的正式消息时，文件里两种记录都有：只留正式的那条（前后 8 条里找）
function dedupQueued(list) {
  return list.filter((x, i) => !(x.queued && list.slice(Math.max(0, i - 8), i + 9).some(y => y !== x && !y.queued && y.kind === 'user' && y.text === x.text)));
}
// 把新解析出来的一段接到已有条目后面：接缝处也去一遍重
const JOIN = 8;
function joinItems(items, add) { return items.slice(0, Math.max(0, items.length - JOIN)).concat(dedupQueued(items.slice(-JOIN).concat(add))); }

async function loadHistory(sessionId, cwd) {
  const T0 = Date.now(), file = jsonlPathOf({ sessionId, cwd });
  let st; try { st = fs.statSync(file); } catch { return { items: [], total: 0 }; }
  let c = histInc.get(sessionId);
  if (c && (c.ino !== st.ino || st.size < c.headEnd)) { histIncBytes -= c.bytes; histInc.delete(sessionId); c = null; }   // 文件换了 / 被截短：从头来
  if (c) { histInc.delete(sessionId); histInc.set(sessionId, c); }   // 挪到最后：最近用过的最后淘汰
  else { c = { ino: st.ino, headEnd: 0, items: [], dropped: 0, bytes: 0, key: '', last: null }; histInc.set(sessionId, c); }
  const entries = readEntries(file, c.headEnd, st.size);
  const T1 = Date.now();
  let k = 0; entries.forEach((x, i) => { if (turnStart(x.e)) k = i; });   // 最后一轮从哪条开始
  let added = 0;
  if (k > 0) {   // 新增部分里有已经过去的轮：并进缓存
    const head = await itemsOf(sessionId, cwd, entries.slice(0, k));
    added = head.length;
    c.items = joinItems(c.items, head); c.headEnd = entries[k].off;
    if (c.items.length > HISTORY_KEEP) { const drop = c.items.length - HISTORY_KEEP; c.dropped += drop; c.items.splice(0, drop); }
    histIncBytes -= c.bytes; c.bytes = historyBytes(c.items); histIncBytes += c.bytes;
    histIncEvict(sessionId);
  }
  const T2 = Date.now();
  const tail = await itemsOf(sessionId, cwd, entries.slice(k));
  const all = joinItems(c.items, tail);
  const out = all.slice(-HISTORY_KEEP).map(x => { if (!x.queued) return x; const y = { ...x }; delete y.queued; return y; });
  const T3 = Date.now();
  return { items: out, total: c.dropped + all.length, timing: 'read ' + (T1 - T0) + ' head ' + (T2 - T1) + '(' + added + ') tail ' + (T3 - T2) + '(' + tail.length + ') total ' + (T3 - T0) };
}

// 文件大小 + 修改时间没变：上次的结果直接用（连最后一轮都不用再解析）
export async function loadHistoryCached(sessionId, cwd) {
  let key = null;
  try { const st = fs.statSync(jsonlPathOf({ sessionId, cwd })); key = st.size + ':' + st.mtimeMs; } catch {}
  const hit = histInc.get(sessionId);
  if (key && hit && hit.key === key && hit.last) return hit.last;
  const hist = await loadHistory(sessionId, cwd);
  const c = histInc.get(sessionId);
  if (c && key) { c.key = key; c.last = hist; }
  return hist;
}

// 历史图片：内容 sha1 当编号（同一张图网址不变，浏览器缓存得住），内存里按总量留最近的；
// k = 网页那边存原图用的 imgKey（同一算法），点开大图时用它找本机存的原图
export const himg = new Map(); let himgBytes = 0;
const HIMG_MAX = 96 * 1024 * 1024;
function imgKeyOf(b64) { let h = 2166136261; for (let i = 0; i < b64.length; i += 7) { h ^= b64.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(36) + '.' + b64.length; }
function himgUrl(src) {
  const id = crypto.createHash('sha1').update(src.data).digest('hex').slice(0, 20);
  if (himg.has(id)) { const v = himg.get(id); himg.delete(id); himg.set(id, v); }
  else {
    const buf = Buffer.from(src.data, 'base64');
    himg.set(id, { type: IMAGE_TYPES.includes(src.media_type) ? src.media_type : 'application/octet-stream', buf }); himgBytes += buf.length;
    for (const [k, v] of himg) { if (himgBytes <= HIMG_MAX) break; himg.delete(k); himgBytes -= v.buf.length; }
  }
  return '/api/himg?id=' + id + '&k=' + encodeURIComponent(imgKeyOf(src.data));
}
// 取一页：before 之前（绝对序号，不含）最多 count 条；图片按页从新到旧分预算，超出的给 null（前端显示占位）
export function historyPage(h, before, count) {
  const base = h.total - h.items.length;
  const end = Math.max(0, Math.min(h.items.length, before - base));
  const start = Math.max(0, end - count);
  const page = h.items.slice(start, end);
  // 图片不再整张塞进消息（截图一张几百 KB，打开会话要等它们传完）：换成网址，网页显示到时再取，浏览器还能缓存
  for (let i = page.length - 1; i >= 0; i--) {
    if (!page[i].images) continue;
    page[i] = { ...page[i], images: page[i].images.map(src => src && typeof src.data === 'string' ? himgUrl(src) : null) };
  }
  return { items: page, start: base + start, more: start > 0 };
}

// 没有对话内容、无法 resume 的「僵尸会话」：比如新开就改了名、一句话没说的会话，
// 文件里只有一条 custom-title。每条真实消息都带 cwd，没有 cwd 就说明从没聊过；
// 小文件再确认一下有没有 user 消息（大文件不可能是空会话，不读）
export function resumable(s) {
  if (!s.cwd) return false;
  if ((s.fileSize ?? Infinity) > 64 * 1024) return true;
  try { return fs.readFileSync(jsonlPathOf(s), 'utf8').includes('"type":"user"'); } catch { return true; }
}

const CLAUDE_MSG = /"type":"(user|assistant)"/;
export function claudeHasMessages(dirs, id) {
  for (const d of dirs) {
    const f = path.join(HOME, '.claude', 'projects', d, id + '.jsonl');
    // 只看开头 1MB：空壳只有几行标题，有消息的文件开头就有；不把几十 MB 的长会话整个读进来
    let fd; try { fd = fs.openSync(f, 'r'); const buf = Buffer.alloc(1 << 20); const n = fs.readSync(fd, buf, 0, buf.length, 0); if (CLAUDE_MSG.test(buf.toString('utf8', 0, n))) return true; } catch {} finally { if (fd != null) fs.closeSync(fd); }
  }
  return false;
}
