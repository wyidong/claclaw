// 会话解剖：把一个会话按「轮」拆开（一轮 = 用户发的一句话，到下一句话之前），
// 每轮里有几步（模型调用）、调了哪些工具、花了多少 token / 时间，给用户看每句提示词让 AI 花了多少力气。
// Claude 读 ~/.claude/projects 下的会话文件（jsonl）；DeepSeek 读 dsh 的会话记录。只读，不估算：拿不到的就不给。
import fs from 'node:fs';
import readline from 'node:readline';

const TEXT_MAX = 3000, SNIP = 160, BRIEF = 110;
const snip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

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

function newTurn(at, text, extra) {
  return { i: 0, at, endAt: at, durMs: 0, text: snip(text, TEXT_MAX), chars: String(text || '').length, images: 0, steps: [], nSteps: 0, nTools: 0, in: 0, out: 0, think: 0, ctx: 0, errors: 0, asks: 0, retries: 0, interrupted: false, subagents: 0, reply: '', replyChars: 0, compact: null, ...extra };
}
function newStep(at, model) { return { at, model: model || '', in: 0, out: 0, think: 0, latMs: 0, text: '', chars: 0, tools: [], stop: '' }; }

// 各轮算完后的汇总；轮的序号、每轮小计也在这里补
function finish(turns, extra) {
  const toolsBy = new Map(); const models = new Set();
  let steps = 0, tools = 0, tin = 0, tout = 0, think = 0, dur = 0, longest = null, errors = 0, interrupted = 0, subagents = 0, maxCtx = 0, ctxLast = null, compactions = 0;
  turns.forEach((t, i) => {
    t.i = i + 1;
    t.nSteps = t.steps.length; t.nTools = 0; t.in = 0; t.out = 0; t.think = 0; t.ctx = 0; t.errors = 0; t.subagents = 0;
    for (const s of t.steps) {
      t.in += s.in; t.out += s.out; t.think += s.think; if (s.in > t.ctx) t.ctx = s.in;
      if (s.model) models.add(s.model);
      for (const u of s.tools) { delete u.at; t.nTools++; toolsBy.set(u.name, (toolsBy.get(u.name) || 0) + 1); if (u.err) t.errors++; if (/^(agent|task)$/i.test(u.name)) t.subagents++; }
      s.text = snip(s.text, SNIP);
    }
    const last = t.steps[t.steps.length - 1];
    if (last) { t.reply = last.text; t.replyChars = last.chars; ctxLast = last.in || ctxLast; }
    t.durMs = Math.max(0, (t.endAt || t.at) - t.at);
    steps += t.nSteps; tools += t.nTools; tin += t.in; tout += t.out; think += t.think; dur += t.durMs; errors += t.errors; subagents += t.subagents;
    if (t.interrupted) interrupted++; if (t.compact) compactions++;
    if (t.ctx > maxCtx) maxCtx = t.ctx;
    if (!longest || t.durMs > longest.durMs) longest = t;
  });
  const summary = {
    turns: turns.length, steps, tools, toolsBy: [...toolsBy.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    in: tin, out: tout, think, durMs: dur, longestMs: longest ? longest.durMs : 0, longestTurn: longest ? longest.i : 0,
    compactions, models: [...models], subagents, errors, interrupted, maxCtx, ctxLast,
    firstAt: turns.length ? turns[0].at : null, lastAt: turns.length ? turns[turns.length - 1].endAt : null,
    ...extra,
  };
  return { summary, turns };
}

const sizeOf = (c) => {
  if (typeof c === 'string') return c.length;
  if (!Array.isArray(c)) return c == null ? 0 : JSON.stringify(c).length;
  let n = 0; for (const x of c) { if (!x) continue; if (x.type === 'text') n += (x.text || '').length; else if (x.type === 'image') n += 0; else n += JSON.stringify(x).length; }
  return n;
};

// ---------- Claude：逐行读会话文件 ----------
export async function dissectClaude(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  const st = { turns: [], cur: null, step: null, stepId: null, lastTs: 0, pending: new Map(), compactions: [] };
  for await (const line of rl) {
    if (line[0] !== '{') continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    claudeLine(st, e);
  }
  return finish(st.turns, {});
}

// 一行记录（同步版，测试和 dsh 共用结构）
export function dissectClaudeLines(lines) {
  const st = { turns: [], cur: null, step: null, stepId: null, lastTs: 0, pending: new Map(), compactions: [] };
  for (const e of lines) claudeLine(st, e);
  return finish(st.turns, {});
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
    if (u) { s.in = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0); s.out = u.output_tokens || 0; s.think = (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0; }
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
}

// ---------- DeepSeek：dsh 的会话记录（已解析成数组） ----------
export function dissectDs(recs) {
  const st = { turns: [], cur: null, step: null, stepId: null, lastTs: 0, pending: new Map() };
  let model = '';
  const txt = (content) => (Array.isArray(content) ? content.filter((x) => x && x.type === 'text').map((x) => x.text || '').join(' ') : typeof content === 'string' ? content : '');
  for (const r of recs || []) {
    if (!r || typeof r !== 'object') continue;
    const d = r.data || {}, ts = Number(r.time) || 0;
    if (ts) st.lastTs = Math.max(st.lastTs, ts);
    switch (r.type) {
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
        s.in = (Number(u.inputTokens) || 0) + (Number(u.cacheReadTokens) || 0) + (Number(u.cacheWriteTokens) || 0);
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
  return finish(st.turns, { model });
}
