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
import { storeNow, qwenInject, qwenSettingsMerge } from '../modelpick.mjs';
import { AcpAgent, AcpLoadRunner, commandsWith, flatOptions, stampTimes, validSid, listItem, readDir, readLines, eachRec, fileRows, syncJsonConfig, notFound, busyRename, assertInside, toTrash } from './acp.mjs';
import { HOME, oneLine, findBin } from '../util.mjs';

export const QW_PREFIX = 'qw:';
export const isQw = id => typeof id === 'string' && id.startsWith(QW_PREFIX);
const sidOf = id => id.slice(QW_PREFIX.length);

const QHOME = process.env.QWEN_HOME || path.join(HOME, '.qwen');
const QDATA = process.env.QWEN_RUNTIME_DIR || QHOME;   // 会话记录放在这里（默认和设置同一个目录）
const PROJECTS = path.join(QDATA, 'projects');
const SETTINGS = path.join(QHOME, 'settings.json');

export const qwBin = () => findBin('qwen');
export const qwInstalled = () => !!qwBin();

// ---------- 会话列表 ----------
// 记录一行一条 JSON：user（provenance real_user 是用户打的字）/ assistant（带 model）/ tool_result / system；
// system 里 subtype custom_title 是改过的名字。文件大的只读头尾（名字、最后的模型都在尾部）
const fileCache = new Map();
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
const listRows = () => fileRows(fileCache, readDir(PROJECTS).flatMap(d => {
  const chats = path.join(PROJECTS, d, 'chats');
  return readDir(chats).filter(n => n.endsWith('.jsonl')).map(n => path.join(chats, n));
}), parseFile);
export const qwSessionList = ({ busy = () => false } = {}) => listRows().map(s => listItem('qwen', QW_PREFIX + s.id, busy, { ...s, title: s.title || 'Qwen 会话', branch: s.model }));
// 消息时间（重放历史不带时间）：用户打的字（real_user）、回复（assistant 带文字）
function timesOf(f) {
  const recs = [];
  eachRec(f, ['"user"', '"assistant"'], o => {
    const at = Date.parse(o.timestamp) || 0;
    if (o.type === 'user' && o.provenance === 'real_user') recs.push({ kind: 'user', text: stripReminder(textOf(o.message)), at });
    else if (o.type === 'assistant' && textOf(o.message).trim()) recs.push({ kind: 'ai', at });
  });
  return recs;
}
export const qwInfo = id => isQw(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const qwExists = id => !!qwInfo(id);

// ---------- 模型库 → settings.json ----------
function syncSettings(log) {
  const inj = qwenInject(storeNow());
  syncJsonConfig(SETTINGS, { tag: 'qwen', count: inj.list.length, merge: cur => qwenSettingsMerge(cur, inj), log });
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

// ---------- 打开的 Qwen 会话 ----------
export const qwRunners = new Map();

export class QwRunner extends AcpLoadRunner {
  static agent = agent; static prefix = QW_PREFIX; static runners = qwRunners; static label = 'Qwen';
  static commands = commandsWith('审批模式');
  static waitArgs = true;

  ctxNow() { return this.ctx ?? qwInfo(this.id)?.ctx; }   // 刚打开还没新一轮：用会话记录里最后一次的输入量
  sessionInfo() { return this.cwd ? null : qwInfo(this.id); }
  cleanUser(text) { return stripReminder(text); }
  afterReplay() { const f = qwInfo(this.id)?.file; if (f) stampTimes(this.items, timesOf(f)); }

  modelNameOf(cfg) {
    const o = cfg?.find(x => x.id === 'model');
    const hit = flatOptions(o).find(x => x.value === o.currentValue);
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
  if (!s?.file) throw notFound();
  assertInside(s.file, PROJECTS);
  const dest = toTrash(trashDir, 'qwen', id, s, { ext: '.jsonl' });
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
  if (!s) throw notFound();
  if (qwRunners.get(id)?.busy) throw busyRename();
  await agent.use(log);
  try { await agent.rpc('renameSession', { sessionId: s.id, title, cwd: s.cwd || HOME }); } finally { agent.idleCheck(); }
  log?.('qwen renamed', s.id.slice(0, 12));
  return title;
}
