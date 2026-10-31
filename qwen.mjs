// Qwen Code 适配（阿里的 `qwen`，npm 包 @qwen-code/qwen-code）。
// 全部走 ACP：claclaw 起一个 `qwen --acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读 ~/.qwen/projects/<目录>/chats/<id>.jsonl（ACP 的 session/list 只能按目录问，拿不到全部）；
//   每个文件按大小 + 修改时间缓存，没变不重读
// - 历史：ACP session/load 会把整段历史用 session/update 重放一遍，收下来转成网页条目（和 Kimi 一样）
// - 改名 / 删除：qwen 自己的扩展方法 renameSession / deleteSession（删前把会话文件复制一份到 claclaw 回收站）
// - 模型：claclaw「模型管理」里的模型写进 ~/.qwen/settings.json 的 modelProviders（key 只走环境变量，见 modelpick.mjs）；
//   Qwen 账号登录（Qwen OAuth）已经停了，没配模型的话 qwen 会要求认证
// 网页里 Qwen 会话的 id = 'qw:' + qwen 会话 id（UUID）。
// 没做「终端里正开着」的检测：同一个会话别在终端和网页里同时发消息。
import fs from 'node:fs';
import path from 'node:path';
import { storeNow, qwenInject, qwenSettingsMerge } from './modelpick.mjs';
import { AcpAgent, AcpRunner } from './acp.mjs';
import { HOME, tilde, oneLine, findBin } from './util.mjs';

export const QW_PREFIX = 'qw:';
export const isQw = id => typeof id === 'string' && id.startsWith(QW_PREFIX);
const sidOf = id => id.slice(QW_PREFIX.length);
const validSid = sid => /^[A-Za-z0-9_.-]{4,128}$/.test(sid);

const QHOME = process.env.QWEN_HOME || path.join(HOME, '.qwen');
const QDATA = process.env.QWEN_RUNTIME_DIR || QHOME;   // 会话记录放在这里（默认和设置同一个目录）
const PROJECTS = path.join(QDATA, 'projects');
const SETTINGS = path.join(QHOME, 'settings.json');

export const qwBin = () => findBin('qwen');
export const qwInstalled = () => !!qwBin();

// ---------- 会话列表 ----------
// 记录一行一条 JSON：user（provenance real_user 是用户打的字）/ assistant（带 model）/ tool_result / system；
// system 里 subtype custom_title 是改过的名字。文件不大就整个读，大的读头尾各 512KB（名字、最后的模型都在尾部）
const fileCache = new Map();   // 文件路径 → { key（大小:修改时间）, row }
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
const textOf = msg => (msg?.parts || []).map(p => typeof p?.text === 'string' && !p.thought ? p.text : '').join('');
const stripReminder = t => String(t || '').replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n').trim();
function parseFile(f, st) {
  let cwd = '', first = '', custom = '', model = '', sid = '', ctx;
  for (const l of readLines(f, st.size)) {
    if (!l || l[0] !== '{') continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    sid ||= o.sessionId || ''; cwd ||= o.cwd || '';
    if (o.type === 'user' && o.provenance === 'real_user' && !first) first = stripReminder(textOf(o.message));
    else if (o.type === 'assistant') { if (o.model) model = o.model; if (o.usageMetadata?.promptTokenCount > 0) ctx = o.usageMetadata.promptTokenCount; }
    else if (o.type === 'system' && o.subtype === 'custom_title' && o.systemPayload?.customTitle) custom = String(o.systemPayload.customTitle);
  }
  sid ||= path.basename(f, '.jsonl');
  if (!validSid(sid)) return null;
  return { id: sid, title: oneLine(custom || first).slice(0, 100), cwd, model, ctx, updated: st.mtimeMs, file: f };
}
function listRows() {
  const rows = [], seen = new Set();
  let dirs = [];
  try { dirs = fs.readdirSync(PROJECTS); } catch {}
  for (const d of dirs) {
    const chats = path.join(PROJECTS, d, 'chats');
    let names = [];
    try { names = fs.readdirSync(chats); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const f = path.join(chats, n);
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
export function qwSessionList({ busy = () => false } = {}) {
  return listRows().map(s => ({
    id: QW_PREFIX + s.id,
    title: s.title || 'Qwen 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'qwen', busy: busy(QW_PREFIX + s.id),
  }));
}
export const qwInfo = id => isQw(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const qwExists = id => !!qwInfo(id);

// ---------- 模型库 → settings.json ----------
// 内容没变就不写；settings.json 读不懂（手写坏了 / 带注释）就不动它，只记日志
function syncSettings(log) {
  const inj = qwenInject(storeNow());
  let text = '', cur = {};
  try { text = fs.readFileSync(SETTINGS, 'utf8'); } catch {}
  if (text.trim()) { try { cur = JSON.parse(text); } catch { log?.('qwen settings.json 不是标准 JSON，没有写入模型库'); return inj; } }
  if (!text.trim() && !inj.list.length) return inj;
  const next = qwenSettingsMerge(cur, inj);
  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    try {
      fs.mkdirSync(QHOME, { recursive: true });
      const tmp = SETTINGS + '.claclaw-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, SETTINGS);
      log?.('qwen settings synced', inj.list.length, 'models');
    } catch (e) { log?.('qwen settings write failed', e.message); }
  }
  return inj;
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'qwen', bin: qwBin, missing: '没找到 qwen 命令，先装好 Qwen Code（npm i -g @qwen-code/qwen-code）',
  command: bin => [bin, ['--acp']],
  prepare: log => { const inj = syncSettings(log); return { env: inj.env, sig: inj.sig }; },
  rpcError: e => /authenticat/i.test(e.message || '') ? 'Qwen Code 没有可用的模型：在 claclaw 的「模型管理」里加一个模型，或在电脑终端运行 qwen 配好模型' : '',
});
// 模型库改了：写好 settings.json；qwen 进程要重启才看得到，没有会话接着就马上关，有就等它们都关掉
export function qwModelsChanged(log) {
  if (!qwInstalled()) return;
  agent.modelsChanged(syncSettings(log).sig, log);
}
export const qwShutdown = () => agent.stop();
export const qwAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '审批模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// ---------- 打开的 Qwen 会话 ----------
// 历史靠 session/load 重放：收下来记在 items 里，之后的新消息也记进去
export const qwRunners = new Map();

export class QwRunner extends AcpRunner {
  static agent = agent; static prefix = QW_PREFIX; static runners = qwRunners;
  static label = 'Qwen'; static group = 'Qwen'; static permPrefix = 'qw-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = true; static waitArgs = true;

  constructor(id, opts) { super(id, opts); this.items = []; }
  get openMethod() { return 'session/load'; }
  ctxNow() { return this.ctx ?? qwInfo(this.id)?.ctx; }   // 刚打开还没新一轮：用会话记录里最后一次的输入量

  async prepareAttach() {
    if (!this.cwd) { const s = qwInfo(this.id); if (s) { this.cwd = s.cwd; this.info.cwd = s.cwd; this.title = this.title || s.title; this.model = this.model || s.model; } }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    for (const it of this.items) if (it.kind === 'user') it.text = stripReminder(it.text);
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Qwen 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }

  modelNameOf(cfg) {
    const o = cfg?.find(x => x.id === 'model');
    const hit = (o?.options || []).flatMap(x => x.options || [x]).find(x => x.value === o.currentValue);
    return hit?.name || modelIdOf(o?.currentValue) || '';
  }
  // 模型库注入的条目：描述是「claclaw · 供应商名」，按供应商名 + 模型 ID 对回模型库
  ownModel(o, store) {
    const v = String(o.value), id = modelIdOf(v) || String(o.name || v);
    const pn = String(o.description || '').match(/^claclaw · (.+)$/)?.[1];
    const sp = pn ? store.providers.find(p => p.name === pn && p.models.some(m => m.id === id)) : null;
    return { value: v, label: String(o.name || id), id, base: sp ? Object.values(sp.endpoints)[0] : '' };
  }
}
// 模型选项的 value 形如「deepseek-flash(openai)」（settings.json 里配的）或「$runtime|openai|deepseek-chat(openai)」（环境变量给的），取出模型 ID
function modelIdOf(v) {
  const parts = String(v || '').split('|');
  return String(parts[0] === '$runtime' ? parts[2] || '' : parts[0]).replace(/\([^)]*\)$/, '');
}

// 新建：在某个目录里开一个新的 qwen 会话
export const qwNewSession = (cwd, opts) => QwRunner.create(cwd, opts);

// 删除：先把会话文件复制一份到 claclaw 回收站，再让 qwen 自己删（deleteSession）
export async function qwDelete(id, trashDir, log) {
  const s = qwInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  if (!fs.realpathSync(s.file).startsWith(fs.realpathSync(PROJECTS) + path.sep)) throw new Error('会话目录不对');
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_qwen_' + s.id + '.jsonl');
  fs.copyFileSync(s.file, dest);
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  await agent.use(log);
  try {
    const r = await agent.rpc('deleteSession', { sessionId: s.id, cwd: s.cwd || HOME });   // 不带 cwd 它按自己进程的目录找，找不到
    if (r && r.success === false) throw new Error('qwen 没有删掉这个会话');
  } finally { agent.idleCheck(); }
  if (fs.existsSync(s.file)) fs.unlinkSync(s.file);   // qwen 删不干净时补一刀（已经备份过）
  fileCache.delete(s.file);
  return dest;
}

// 改名：qwen 的扩展方法 renameSession（写一条 custom_title 记录）
export async function qwRename(id, title, log) {
  const s = qwInfo(id);
  if (!s) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  const r = qwRunners.get(id);
  if (r?.busy) throw Object.assign(new Error('这个会话还在回复，等它结束再改名'), { code: 409 });
  await agent.use(log);
  try { await agent.rpc('renameSession', { sessionId: s.id, title, cwd: s.cwd || HOME }); } finally { agent.idleCheck(); }
  log?.('qwen renamed', s.id.slice(0, 12));
  return title;
}
