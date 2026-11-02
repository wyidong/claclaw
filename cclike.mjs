// Claude Code 式会话记录的通用读取：<根>/projects/<目录名>/<会话 id>.jsonl，一行一条 JSON
// （CodeBuddy Code、Qoder CLI 都是这个样子：type user / assistant，message.content 是字符串或 [{type:text…}]，带 cwd、timestamp）。
// 每个文件按大小 + 修改时间缓存，没变不重读；大文件只读头尾各 512KB（第一句在头部，最后的模型在尾部）
import fs from 'node:fs';
import path from 'node:path';
import { oneLine } from './util.mjs';
import { stripTags } from './acp.mjs';

const READ_ALL = 4 << 20, PART = 512 << 10;
function readLines(f, size) {
  if (size <= READ_ALL) return fs.readFileSync(f, 'utf8').split('\n');
  const fd = fs.openSync(f, 'r');
  try {
    const head = Buffer.alloc(PART), tail = Buffer.alloc(PART);
    fs.readSync(fd, head, 0, PART, 0); fs.readSync(fd, tail, 0, PART, size - PART);
    return [...head.toString('utf8').split('\n').slice(0, -1), ...tail.toString('utf8').split('\n').slice(1)];
  } finally { fs.closeSync(fd); }
}
// message.content 里的文字（字符串，或 text 块拼起来）；只有 tool_result 的不算
export const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.type === 'text' && typeof x.text === 'string' ? x.text : '').join('') : '';
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);
const sidIn = o => o.sessionId || o.session_id || o.sessionID || '';

// root：projects 的上一级（~/.codebuddy、~/.qoder）；skip(name)：目录里哪些 .jsonl 不算（Qoder 的 agent-*.jsonl 是子代理）
export function makeStore({ root, skip = () => false, defaultTitle }) {
  const PROJECTS = path.join(root, 'projects');
  const fileCache = new Map();   // 文件路径 → { key, row }

  function parseFile(f, st) {
    let sid = '', cwd = '', first = '', custom = '', model = '', ts = 0;
    for (const l of readLines(f, st.size)) {
      if (!l || l[0] !== '{') continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.isSidechain || o.is_sidechain) continue;
      sid ||= String(sidIn(o)); cwd ||= o.cwd || '';
      const t = Date.parse(o.timestamp); if (t > ts) ts = t;
      if (o.type === 'user' && !first) { const txt = stripTags(textOf(o.message?.content)); if (txt && !/^<[a-z_-]+>/i.test(txt)) first = txt; }
      else if (o.type === 'assistant') { if (o.message?.model) model = o.message.model; }
      else if ((o.type === 'summary' || o.type === 'custom_title' || o.type === 'custom-title') && (o.summary || o.title || o.customTitle)) custom = String(o.summary || o.title || o.customTitle);
    }
    sid ||= path.basename(f, '.jsonl');
    if (!validSid(sid)) return null;
    return { id: sid, title: oneLine(custom || first).slice(0, 100), cwd, model, updated: Math.max(st.mtimeMs, ts || 0), file: f };
  }
  function listRows() {
    const rows = [], seen = new Set();
    let dirs = [];
    try { dirs = fs.readdirSync(PROJECTS); } catch {}
    for (const d of dirs) {
      const dir = path.join(PROJECTS, d);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const n of names) {
        if (!n.endsWith('.jsonl') || skip(n)) continue;
        const f = path.join(dir, n);
        let st; try { st = fs.statSync(f); } catch { continue; }
        if (!st.isFile() || !st.size) continue;
        seen.add(f);
        const key = st.size + ':' + st.mtimeMs;
        let c = fileCache.get(f);
        if (c?.key !== key) { let row = null; try { row = parseFile(f, st); } catch {} c = { key, row }; fileCache.set(f, c); }
        if (c.row) rows.push(c.row);
      }
    }
    for (const f of fileCache.keys()) if (!seen.has(f)) fileCache.delete(f);
    return rows.sort((a, b) => b.updated - a.updated);
  }
  const info = sid => listRows().find(s => s.id === sid) || null;

  // 消息时间（重放历史不带时间）：用户打的字 / 有文字的回复
  function timesOf(f) {
    const recs = [];
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return recs; }
    for (const l of txt.split('\n')) {
      if (!l || !(l.includes('"user"') || l.includes('"assistant"'))) continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.isSidechain) continue;
      const at = Date.parse(o.timestamp) || 0;
      if (o.type === 'user') { const t = stripTags(textOf(o.message?.content)); if (t) recs.push({ kind: 'user', text: t, at }); }
      else if (o.type === 'assistant' && textOf(o.message?.content).trim()) recs.push({ kind: 'ai', at });
    }
    return recs;
  }
  // 整段历史转成网页条目（agent 的 session/load 不重放时用）：用户 / 回复 / 工具（tool_use → tool_result 对上）
  function historyOf(f) {
    const items = [], tools = new Map();
    let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return items; }
    for (const l of txt.split('\n')) {
      if (!l || l[0] !== '{') continue;
      let o; try { o = JSON.parse(l); } catch { continue; }
      if (o.isSidechain || (o.type !== 'user' && o.type !== 'assistant')) continue;
      const at = Date.parse(o.timestamp) || undefined, c = o.message?.content;
      if (o.type === 'user') {
        const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
        const images = blocks.filter(b => b?.type === 'image' && b.source?.data).map(b => ({ media_type: b.source.media_type || 'image/png', data: b.source.data }));
        for (const b of blocks) if (b?.type === 'tool_result') { const t = tools.get(b.tool_use_id); if (t) { t.output = textOf(b.content).slice(0, 4000); if (b.is_error) t.status = 'no'; } }
        const text = stripTags(textOf(c));
        if (text || images.length) items.push({ kind: 'user', text, images: images.length ? images : undefined, at });
      } else {
        const blocks = Array.isArray(c) ? c : [{ type: 'text', text: String(c ?? '') }];
        for (const b of blocks) {
          if (b?.type === 'text' && b.text) { const last = items[items.length - 1]; if (last?.kind === 'ai' && last._open) last.text += b.text; else items.push({ kind: 'ai', text: b.text, at, _open: true }); }
          else if (b?.type === 'tool_use') {
            const last = items[items.length - 1]; if (last?.kind === 'ai') last._open = false;
            const a = b.input || {}, target = String(a.command ?? a.file_path ?? a.path ?? a.pattern ?? a.url ?? a.query ?? a.description ?? '').replace(/\s+/g, ' ').slice(0, 160);
            const it = { kind: 'tool', id: b.id, name: b.name || 'tool', target, status: 'ok', output: '' };
            tools.set(b.id, it); items.push(it);
          }
        }
      }
    }
    for (const it of items) delete it._open;
    return items;
  }
  return { PROJECTS, listRows, info, timesOf, historyOf, fileCache, defaultTitle };
}
