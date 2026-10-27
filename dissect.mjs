// 会话解剖：把一个会话按「轮」拆开（一轮 = 用户发的一句话，到下一句话之前），
// 每轮里有几步（模型调用）、调了哪些工具、花了多少 token / 时间，给用户看每句提示词让 AI 花了多少力气。
// Claude 读 ~/.claude/projects 下的会话文件（jsonl）；DeepSeek 读 dsh 的会话记录。
// 数字纪律：只用记录里实报的数；拿不到的不补 0、不估、不摊（缓存读 / 缓存写全程没上报过就标 known=false，页面显示 --）。
// 四桶：inp 未命中输入 · cr 缓存读 · cw 缓存写 · out 输出（含思考 think）。合计 = 四桶相加；上下文大小 = inp + cr + cw。
import fs from 'node:fs';
import os from 'node:os';
import readline from 'node:readline';

const TEXT_MAX = 3000, SNIP = 400, BRIEF = 110, FILES_MAX = 30;
const snip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const num = (v) => (v == null || v === '' ? null : Number(v) || 0);
const HOME = os.homedir();
// 文件路径显示：会话目录下的给相对路径，家目录下的 ~/…
const relPath = (p, cwd) => { p = String(p || ''); if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1); if (p === HOME) return '~'; if (p.startsWith(HOME + '/')) return '~' + p.slice(HOME.length); return p; };

// jsonl 一行用户记录 → 用户真正发的那句话；工具结果、系统注入、斜杠命令（/compact 等）及其输出、打断提示都不算（返回空）
export function userTextOf(e) {
  if (!e || e.type !== 'user' || e.isMeta || e.isCompactSummary || e.isSidechain) return '';
  const c = e.message && e.message.content;
  let t = '', img = false;
  if (typeof c === 'string') t = c;
  else if (Array.isArray(c)) {
    if (c.some((x) => x && x.type === 'tool_result')) return '';
    for (const x of c) { if (x && x.type === 'text') t += (t ? ' ' : '') + (x.text || ''); else if (x && x.type === 'image') img = true; }
  }
  t = t.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
  if (/^<(local-command|command-|bash-|task-notification)/.test(t) || /^\[Request interrupted/.test(t)) return '';
  return t || (img ? '[图片]' : '');
}

// 工具调用的一句话：Bash 给命令，读写文件给路径，子代理给任务，其它给第一个字符串参数
export function toolBrief(name, input) {
  const o = input && typeof input === 'object' ? input : {};
  const n = String(name || '');
  const pick = (...ks) => { for (const k of ks) if (typeof o[k] === 'string' && o[k].trim()) return o[k]; return ''; };
  let s = '';
  if (/^bash$/i.test(n)) s = pick('command');
  else if (/^(read|write|edit|multiedit|notebookedit)$/i.test(n)) s = pick('file_path', 'path', 'notebook_path');
  else if (/^(glob|grep)$/i.test(n)) s = pick('pattern') + (o.path ? '  ' + o.path : '');
  else if (/^(agent|task)$/i.test(n)) s = pick('description', 'prompt');
  else if (/^(webfetch|websearch|toolsearch)$/i.test(n)) s = pick('url', 'query');
  else if (/^(skill)$/i.test(n)) s = pick('skill', 'name');
  if (!s) { for (const k of Object.keys(o)) { const v = o[k]; if (typeof v === 'string' && v.trim()) { s = v; break; } } }
  if (!s && Object.keys(o).length) { try { s = JSON.stringify(o); } catch {} }
  return snip(s, BRIEF);
}
// 工具按用途归类：读文件 / 改文件 / 跑命令 / 子代理 / 其它（给「这一轮做了什么」用）
export function toolKind(name) {
  const n = String(name || '');
  if (/^bash$/i.test(n)) return 'cmd';
  if (/^(read|glob|grep)$/i.test(n)) return 'read';
  if (/^(write|edit|multiedit|notebookedit)$/i.test(n)) return 'write';
  if (/^(agent|task)$/i.test(n)) return 'agent';
  return 'other';
}

function newTurn(at, text, extra) {
  return { i: 0, at, endAt: at, durMs: 0, text: snip(text, TEXT_MAX), chars: String(text || '').length, images: 0, steps: [], asks: 0, retries: 0, interrupted: false, compact: null, ...extra };
}
function newStep(at, model) { return { at, model: model || '', inp: 0, cr: null, cw: null, out: 0, think: 0, latMs: 0, text: '', chars: 0, tools: [], stop: '' }; }

// 各轮算完后的汇总；轮的序号、每轮小计也在这里补
function finish(turns, extra, cwd) {
  const toolsBy = new Map(); const models = new Set();
  const S = { turns: turns.length, steps: 0, tools: 0, inp: 0, cr: 0, cw: 0, out: 0, think: 0, total: 0, crKnown: false, cwKnown: false, durMs: 0, longestMs: 0, longestTurn: 0, compactions: 0, subagents: 0, errors: 0, interrupted: 0, maxCtx: 0, ctxLast: null, reads: 0, writes: 0, cmds: 0, firstAt: null, lastAt: null };
  turns.forEach((t, i) => {
    t.i = i + 1;
    t.nSteps = t.steps.length; t.nTools = 0; t.inp = 0; t.cr = 0; t.cw = 0; t.out = 0; t.think = 0; t.ctx = 0; t.crLast = null; t.errors = 0; t.subagents = 0;
    const reads = new Set(), writes = new Set(); let cmds = 0;
    for (const s of t.steps) {
      s.ctx = s.inp + (s.cr || 0) + (s.cw || 0); s.total = s.ctx + s.out;
      t.inp += s.inp; t.out += s.out; t.think += s.think;
      if (s.cr != null) { t.cr += s.cr; S.crKnown = true; t.crLast = s.cr; }
      if (s.cw != null) { t.cw += s.cw; S.cwKnown = true; }
      if (s.ctx > t.ctx) t.ctx = s.ctx;
      if (s.model) models.add(s.model);
      for (const u of s.tools) {
        delete u.at; t.nTools++; toolsBy.set(u.name, (toolsBy.get(u.name) || 0) + 1); if (u.err) t.errors++;
        const k = toolKind(u.name); u.kind = k;
        if ((k === 'read' || k === 'write') && u.brief) u.brief = relPath(u.brief, cwd);
        if (k === 'agent') t.subagents++; else if (k === 'cmd') cmds++; else if (k === 'read' && u.brief) reads.add(u.brief); else if (k === 'write' && u.brief) writes.add(u.brief);
      }
      s.text = snip(s.text, SNIP);
    }
    t.total = t.inp + t.cr + t.cw + t.out;
    t.reads = reads.size; t.writes = writes.size; t.cmds = cmds; t.files = [...writes].slice(0, FILES_MAX).map((f) => relPath(f, cwd));
    const last = t.steps[t.steps.length - 1];
    t.reply = last ? last.text : ''; t.replyChars = last ? last.chars : 0;
    if (last) S.ctxLast = last.ctx;
    t.durMs = Math.max(0, (t.endAt || t.at) - t.at);
    S.steps += t.nSteps; S.tools += t.nTools; S.inp += t.inp; S.cr += t.cr; S.cw += t.cw; S.out += t.out; S.think += t.think; S.durMs += t.durMs;
    S.errors += t.errors; S.subagents += t.subagents; S.reads += t.reads; S.writes += t.writes; S.cmds += t.cmds;
    if (t.interrupted) S.interrupted++; if (t.compact) S.compactions++;
    if (t.ctx > S.maxCtx) S.maxCtx = t.ctx;
    if (t.durMs > S.longestMs) { S.longestMs = t.durMs; S.longestTurn = t.i; }
  });
  S.total = S.inp + S.cr + S.cw + S.out;
  S.toolsBy = [...toolsBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  S.models = [...models];
  S.firstAt = turns.length ? turns[0].at : null; S.lastAt = turns.length ? turns[turns.length - 1].endAt : null;
  return { summary: { ...S, ...extra }, turns };
}

const sizeOf = (c) => {
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return c == null ? 0 : JSON.stringify(c).length;
  let n = 0; for (const x of c) { if (!x) continue; if (x.type === 'text') n += (x.text || '').length; else if (x.type === 'image') n += 0; else n += JSON.stringify(x).length; }
  return n;
};

// ---------- Claude：逐行读会话文件 ----------
function claudeState() { return { turns: [], cur: null, step: null, stepId: null, lastTs: 0, pending: new Map(), bills: new Map() }; }
function claudeExtra(st) {
  // Claude Code 自己记的账（cost-state）：每个进程各自累计、退出时写（同一 startTime 只取最后一条），各进程相加；含子代理；被杀掉的进程没记账
  if (!st.bills.size) return { bill: null };
  const o = { inp: 0, cr: 0, cw: 0, out: 0, total: 0, source: 'Claude Code 记账（' + st.bills.size + ' 个进程相加，含子代理；进程退出时才记，被杀掉的没记）' };
  let la = 0, lr = 0;
  for (const b of st.bills.values()) {
    for (const m of Object.values(b.modelUsage || {})) { o.inp += m.inputTokens || 0; o.cr += m.cacheReadInputTokens || 0; o.cw += m.cacheCreationInputTokens || 0; o.out += m.outputTokens || 0; }
    la += b.totalLinesAdded || 0; lr += b.totalLinesRemoved || 0;
  }
  o.total = o.inp + o.cr + o.cw + o.out;
  return { bill: o, linesAdded: la, linesRemoved: lr };
}
export async function dissectClaude(file, cwd) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const st = claudeState();
  for await (const line of rl) {
    if (line[0] !== '{') continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    claudeLine(st, e);
  }
  return finish(st.turns, claudeExtra(st), cwd);
}

// 同步版（测试用）：传已解析的记录数组
export function dissectClaudeLines(lines, cwd) {
  const st = claudeState();
  for (const e of lines) claudeLine(st, e);
  return finish(st.turns, claudeExtra(st), cwd);
}

// 新开一轮。上一轮的结束时间只由它自己的记录（回复、工具结果……）推进，不算到下一句话之前的空闲
function startTurn(st, at, text, extra) {
  st.cur = newTurn(at, text, extra); st.step = null; st.stepId = null;
  st.lastTs = Math.max(st.lastTs, at);
  st.turns.push(st.cur);
  return st.cur;
}

function claudeLine(st, e) {
  if (!e || typeof e !== 'object' || e.isSidechain) return;
  const ts = e.timestamp ? Date.parse(e.timestamp) || 0 : 0;
  const t = e.type;
  if (t === 'user') {
    const c = e.message && e.message.content;
    if (Array.isArray(c) && c.some((x) => x && x.type === 'tool_result')) {
      if (ts) st.lastTs = Math.max(st.lastTs, ts);
      for (const x of c) {
        if (!x || x.type !== 'tool_result') continue;
        const u = st.pending.get(x.tool_use_id); if (!u) continue;
        u.size = sizeOf(x.content); u.err = !!x.is_error; if (ts && u.at) u.ms = Math.max(0, ts - u.at); delete u.at;
        st.pending.delete(x.tool_use_id);
      }
      const pd = e.permissionDecision; if (pd && st.cur && /^user/.test(String(pd.source || ''))) st.cur.asks++;
      if (st.cur) st.cur.endAt = Math.max(st.cur.endAt, st.lastTs);
      return;
    }
    const raw = typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ') : '';
    if (/^\[Request interrupted/.test(raw.trim())) { if (st.cur) { st.cur.interrupted = true; if (ts) st.lastTs = Math.max(st.lastTs, ts); st.cur.endAt = Math.max(st.cur.endAt, st.lastTs); } return; }
    const text = userTextOf(e);
    if (!text) { if (ts) st.lastTs = Math.max(st.lastTs, ts); return; }
    const tr = startTurn(st, ts || st.lastTs, text, {});
    if (Array.isArray(c)) tr.images = c.filter((x) => x && x.type === 'image').length;
    return;
  }
  if (t === 'attachment') {
    const a = e.attachment;
    if (a && a.type === 'queued_command' && a.prompt) {
      const p = a.prompt, text = typeof p === 'string' ? p : Array.isArray(p) ? p.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ') : '';
      if (text.trim()) { const tr = startTurn(st, ts || st.lastTs, text, { queued: true }); if (Array.isArray(p)) tr.images = p.filter((x) => x && x.type === 'image').length; }
    }
    return;
  }
  if (t === 'assistant') {
    const m = e.message; if (!m) return;
    if (!st.cur) startTurn(st, ts || st.lastTs, '', { implicit: true });   // 文件从半截开始（没有用户那句）
    const prevTs = st.lastTs;
    if (ts) st.lastTs = Math.max(st.lastTs, ts);
    let s = st.step;
    if (!s || (m.id && m.id !== st.stepId)) {
      s = newStep(ts || st.lastTs, m.model); s.latMs = ts && prevTs ? Math.max(0, ts - prevTs) : 0;
      st.cur.steps.push(s); st.step = s; st.stepId = m.id || null;
    }
    const u = m.usage;
    if (u) { s.inp = u.input_tokens || 0; s.cr = num(u.cache_read_input_tokens); s.cw = num(u.cache_creation_input_tokens); s.out = u.output_tokens || 0; s.think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0; }
    if (m.stop_reason) s.stop = m.stop_reason;
    if (m.model && !s.model) s.model = m.model;
    for (const b of Array.isArray(m.content) ? m.content : []) {
      if (!b) continue;
      if (b.type === 'text') { s.text += (s.text ? ' ' : '') + (b.text || ''); s.chars += (b.text || '').length; }
      else if (b.type === 'tool_use') { const tool = { name: b.name || '?', brief: toolBrief(b.name, b.input), ms: 0, size: 0, err: false, at: ts || st.lastTs }; s.tools.push(tool); if (b.id) st.pending.set(b.id, tool); }
    }
    st.cur.endAt = Math.max(st.cur.endAt, st.lastTs);
    return;
  }
  if (t === 'system') {
    // 压缩、重试这些记录不算这一轮的干活时间（用户隔了几天 /compact，不能把上一轮算成几天）
    if (ts) st.lastTs = Math.max(st.lastTs, ts);
    if (e.subtype === 'compact_boundary') {
      const c = e.compactMetadata || {};
      if (!st.cur) startTurn(st, ts || st.lastTs, '', { implicit: true });
      st.cur.compact = { pre: c.preTokens || 0, post: c.postTokens || 0, trigger: c.trigger || '' };
      st.step = null; st.stepId = null;
    } else if (e.subtype === 'api_error' && st.cur) st.cur.retries++;
    return;
  }
  if (t === 'cost-state' && e.modelUsage) st.bills.set(String(e.startTime || 0), e);
}

// ---------- DeepSeek：dsh 的会话记录（已解析成数组） ----------
export function dissectDs(recs) {
  const st = { turns: [], cur: null, step: null, stepId: null, lastTs: 0, pending: new Map() };
  let model = '', cwd = '';
  const txt = (content) => (Array.isArray(content) ? content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ') : typeof content === 'string' ? content : '');
  for (const r of recs || []) {
    if (!r || typeof r !== 'object') continue;
    const d = r.data || {}, ts = Number(r.time) || 0;
    if (ts) st.lastTs = Math.max(st.lastTs, ts);
    switch (r.type) {
      case 'session': { if (r.cwd) cwd = String(r.cwd); break; }
      case 'request/header': { const m = d.header && d.header.config && d.header.config.model; if (m) model = m; break; }
      case 'user/message': {
        if (!d.source || d.source.kind !== 'user') break;
        const text = txt(d.content); if (!text.trim()) break;
        const tr = startTurn(st, ts, text, {});
        tr.images = Array.isArray(d.content) ? d.content.filter((x) => x && /image/.test(x.type || '')).length : 0;
        break;
      }
      case 'assistant/message': {
        if (!st.cur) startTurn(st, ts, '', { implicit: true });
        const prevTs = st.prevTs || 0;
        const s = newStep(ts, (d.message && d.message.source && d.message.source.model) || model);
        s.latMs = ts && prevTs ? Math.max(0, ts - prevTs) : 0;
        const u = d.usage || {};
        s.inp = Number(u.inputTokens) || 0; s.cr = num(u.cacheReadTokens); s.cw = num(u.cacheWriteTokens);
        s.out = Number(u.outputTokens) || 0; s.think = Number(u.reasoningTokens) || 0;
        for (const b of Array.isArray(d.message && d.message.content) ? d.message.content : []) {
          if (!b) continue;
          if (b.type === 'text') { s.text += (s.text ? ' ' : '') + (b.text || ''); s.chars += (b.text || '').length; }
        }
        st.cur.steps.push(s); st.step = s;
        st.cur.endAt = Math.max(st.cur.endAt, ts);
        break;
      }
      case 'tool/call': {
        if (!st.step) break;
        let input = null; try { input = typeof d.arguments === 'string' ? JSON.parse(d.arguments) : d.arguments; } catch {}
        const tool = { name: d.name || '?', brief: toolBrief(d.name, input), ms: 0, size: 0, err: false, at: ts };
        st.step.tools.push(tool); if (d.callId) st.pending.set(d.callId, tool);
        break;
      }
      case 'tool/result': {
        const m = d.message || {}, id = (m.source && m.source.callId) || (Array.isArray(m.content) && m.content[0] && m.content[0].toolCallId);
        const u = id && st.pending.get(id); if (!u) break;
        let size = 0, err = false;
        for (const x of Array.isArray(m.content) ? m.content : []) { if (!x) continue; size += sizeOf(x.content != null ? x.content : x.text); if (x.isError || x.is_error) err = true; }
        u.size = size; u.err = err; if (ts && u.at) u.ms = Math.max(0, ts - u.at); delete u.at;
        st.pending.delete(id);
        if (st.cur) st.cur.endAt = Math.max(st.cur.endAt, ts);
        break;
      }
      case 'turn/end': {
        if (!st.cur) break;
        const k = d.reason && d.reason.kind; if (k && k !== 'completed') st.cur.interrupted = true;
        st.cur.endAt = Math.max(st.cur.endAt, ts);
        break;
      }
      case 'compaction/summary': {
        if (!st.cur) startTurn(st, ts, '', { implicit: true });
        st.cur.compact = { pre: 0, post: Number(d.usage && d.usage.outputTokens) || 0, trigger: '' };
        st.step = null;
        break;
      }
      default: break;
    }
    st.prevTs = ts || st.prevTs;
  }
  return finish(st.turns, { model }, cwd);
}
