// Kimi Code CLI 适配（Moonshot 的 `kimi`，装在 ~/.kimi-code/bin/kimi）。
// 全部走 ACP：claclaw 起一个 `kimi acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：`kimi session list --all --json`（kimi 自己的逻辑，不读它的内部文件）
// - 历史：ACP session/load 会把整段历史用 session/update 重放一遍，收下来转成网页条目；接上之后的新消息也记进去
// - 发消息 session/prompt、中断 session/cancel、删除 session/delete（删前 kimi export 存一份 zip 到回收站）
// - 改名：ACP 里没有改名（/title 只在终端界面里有），按 kimi 自己 /title 的做法改会话目录里的 state.json：
//   title + titleKind 'custom'（isCustomTitle: true），之后自动起的标题不会盖掉它。kimi 进程会拿内存里的元数据整个写回，
//   所以 claclaw 自己的 kimi 接着这个会话时先 session/close，下次发消息再接上
// - 模型：claclaw「模型管理」里的模型写进 ~/.kimi-code/config.toml（claclaw- 开头的供应商，key 只走环境变量），
//   不登录 Kimi 账号也能用；登录过的 Kimi 自带模型照样在

// 网页里 Kimi 会话的 id = 'km:' + kimi 会话 id。
// 没做「终端里正开着」的检测：同一个会话别在终端和网页里同时发消息。
import fs from 'node:fs';
import path from 'node:path';
import { storeNow, kimiInject, kimiConfigMerge } from '../modelpick.mjs';
import { AcpAgent, AcpLoadRunner, commandsWith, toolTarget, stampTimes, validSid, listItem, readDir, eachRec, writeFileAtomic, trashPath, assertInside, busyRename } from './acp.mjs';
import { HOME, oneLine, tms, findBin, runBin as run } from '../util.mjs';

export const KM_PREFIX = 'km:';
export const isKm = id => typeof id === 'string' && id.startsWith(KM_PREFIX);
const sidOf = id => id.slice(KM_PREFIX.length);

export const kmBin = () => findBin('kimi', [process.env.KIMI_CODE_HOME && path.join(process.env.KIMI_CODE_HOME, 'bin'), path.join(HOME, '.kimi-code', 'bin')]);
export const kmInstalled = () => !!kmBin();
const runBin = (args, ms) => run(kmBin(), args, ms, { missing: '没找到 kimi 命令，先装好 Kimi Code CLI' });

// ---------- 会话列表 ----------
let listCache = { sig: '', rows: null, p: null };
const pick = (o, ...ks) => { for (const k of ks) if (o?.[k] != null && o[k] !== '') return o[k]; return undefined; };
function normRow(s) {
  const id = String(pick(s, 'id', 'sessionId', 'session_id') || '');
  if (!validSid(id)) return null;
  return {
    id,
    title: oneLine(pick(s, 'title', 'name', 'summary', 'lastPrompt') || '').slice(0, 100),
    cwd: String(pick(s, 'cwd', 'workDir', 'work_dir', 'workspace', 'directory') || ''),
    updated: tms(pick(s, 'updatedAt', 'updated_at', 'lastUpdated', 'mtime', 'createdAt', 'created_at'), 0),
    model: String(pick(s, 'model', 'modelAlias') || ''),
    dir: String(s.sessionDir || ''),
  };
}
// 列表要跑 kimi session list（起一次 CLI 将近 1 秒），「最近」每次都要它。列表内容都来自各会话的 state.json，
// 所以按「索引文件 + 各目录 + 各 state.json 的修改时间」做签名：没变就用上次的结果，几个 stat 而已
const KHOME = process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code');
function listSig() {
  const st = f => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
  const root = path.join(KHOME, 'sessions'), parts = [st(path.join(KHOME, 'session_index.jsonl')), st(root)];
  for (const wd of readDir(root)) {
    if (wd === '.index-cache') continue;   // kimi 自己列会话时会重写它，算进去签名就永远对不上
    const d = path.join(root, wd);
    parts.push(wd, st(d));
    for (const x of readDir(d)) parts.push(x, st(path.join(d, x, 'state.json')));
  }
  return parts.join(',');
}
async function listRows() {
  const sig = listSig();
  if (listCache.rows && listCache.sig === sig) return listCache.rows;
  if (listCache.p) return listCache.p;
  listCache.p = runBin(['session', 'list', '--all', '--json'], 20000).then(out => {
    let arr = [];
    try { const j = JSON.parse(out.slice(Math.max(0, out.indexOf('[')))); arr = Array.isArray(j) ? j : j?.sessions || []; } catch {}
    const rows = arr.map(normRow).filter(Boolean).sort((a, b) => b.updated - a.updated);
    listCache = { sig, rows, p: null };
    return rows;
  }).catch(e => { listCache.p = null; throw e; });
  return listCache.p;
}
const dropListCache = () => { listCache.sig = ''; };

export async function kmSessionList({ busy = () => false } = {}) {
  return (await listRows()).map(s => listItem('kimi', KM_PREFIX + s.id, busy, { ...s, title: s.title || 'Kimi 会话', branch: s.model }));
}
// 消息时间（重放历史不带时间）：sessions/<工作区>/<会话>/agents/main/wire.jsonl 里
// turn.prompt / turn.steer（origin 是 user 的才是用户打的字）、content.part 的文字（回复）
function wireOf(sid) {
  const root = path.join(KHOME, 'sessions');
  for (const d of readDir(root)) for (const s of [sid, 'session_' + sid]) { const f = path.join(root, d, s, 'agents', 'main', 'wire.jsonl'); if (fs.existsSync(f)) return f; }
  return '';
}
function timesOf(sid) {
  const recs = [], f = wireOf(sid);
  if (f) eachRec(f, ['"turn.prompt"', '"turn.steer"', '"content.part"'], o => {
    if ((o.type === 'turn.prompt' || o.type === 'turn.steer') && o.origin?.kind === 'user') recs.push({ kind: 'user', text: (o.input || []).map(x => x?.type === 'text' ? x.text : '').join(''), at: o.time });
    else if (o.event?.type === 'content.part' && o.event.part?.type === 'text' && o.event.part.text?.trim()) recs.push({ kind: 'ai', at: o.time });
  });
  return recs;
}
export async function kmInfo(id) {
  if (!isKm(id)) return null;
  return (await listRows()).find(s => s.id === sidOf(id)) || null;
}

// ---------- 模型库 → config.toml ----------
const CONFIG = path.join(KHOME, 'config.toml');
// 把模型库同步进 config.toml（内容没变就不写）；返回要给 kimi 进程的环境变量（key）
function syncConfig(log) {
  const inj = kimiInject(storeNow());
  let cur = '';
  try { cur = fs.readFileSync(CONFIG, 'utf8'); } catch {}
  const next = kimiConfigMerge(cur, inj);
  if (next !== cur && (cur || inj.tables)) {
    // 权限沿用原文件的（没有就 600）
    let mode = 0o600; try { mode = fs.statSync(CONFIG).mode & 0o777; } catch {}
    try { writeFileAtomic(CONFIG, next, mode); log?.('kimi config synced', inj.aliases.length, 'models'); }
    catch (e) { log?.('kimi config write failed', e.message); }
  }
  return inj;
}
// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'kimi', bin: kmBin, missing: '没找到 kimi 命令，先装好 Kimi Code CLI',
  command: bin => [bin, ['acp']],
  prepare: log => { const inj = syncConfig(log); return { env: inj.env, sig: inj.sig }; },
  rpcError: e => e.code === -32000 ? 'Kimi 没有可用的模型：在 claclaw 的「模型管理」里加一个模型，或在电脑终端运行 kimi login 登录 Kimi 账号' : '',
});
// 模型库改了：写好 config.toml；kimi 进程要重启才看得到，没有会话接着就马上关，有就等它们都关掉
export function kmModelsChanged(log) {
  if (!kmInstalled()) return;
  agent.modelsChanged(syncConfig(log).sig, log);
}
export const kmShutdown = () => agent.stop();
export const kmAcpRunning = () => agent.running;

// kimi 的工具参数是流式的：in_progress 的 content 里是正在拼的参数 JSON，拼完整了才解析得出来
const argsOf = u => { const t = u.content?.[0]?.content?.text; if (typeof t !== 'string' || t[0] !== '{') return null; try { return JSON.parse(t); } catch { return null; } };
const stripReminder = t => String(t || '')
  .replace(/^\s*Skill tool loaded instructions[^\n]*\n*/, '')   // Kimi 加载技能时插进来的「用户消息」，不是用户发的
  .replace(/\s*<skill-loaded[\s\S]*?<\/skill-loaded>\s*/g, '\n')
  .replace(/\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/g, '\n').trim();

// ---------- 打开的 Kimi 会话 ----------
export const kmRunners = new Map();

export class KmRunner extends AcpLoadRunner {
  static agent = agent; static prefix = KM_PREFIX; static runners = kmRunners; static label = 'Kimi';
  static commands = commandsWith('审批模式', { name: 'thinking', description: '思考开关 / 强度（不带参数：列出可选项）', hint: '<选项>', builtin: true });
  static cfgIds = { model: 'model', thinking: 'thinking', mode: 'mode' };
  static cfgNames = { model: '模型', thinking: '思考', mode: '模式' };
  static waitArgs = true;
  static lockedRe = /in use by another/i;   // 刚关掉就重开：kimi 还没放开会话锁
  static onCreated() { dropListCache(); }

  get imageError() { return 'kimi 没有声明图片输入'; }
  ctxNow() { return this.ctx == null ? undefined : this.ctx; }
  streamedArgs(u) { return argsOf(u); }

  sessionInfo() { return this.cwd ? null : kmInfo(this.id).catch(() => null); }
  cleanUser(text) { return stripReminder(text); }
  afterReplay() { stampTimes(this.items, timesOf(this.sid)); }
  afterPrompt() { dropListCache(); }

  // 确认条：参数还没解析出来时，用 kimi 给的提示文字「Requesting approval to Running: echo hi」
  permInfo(tc, known) {
    const r = super.permInfo(tc, known ? { ...known, name: known.name || tc.title } : { name: tc.title || '' });
    const hint = String(tc.content?.[0]?.content?.text || '').replace(/^Requesting approval to\s*/i, '').replace(/^Running:\s*/, '');
    if (!r.target || r.target === String(tc.title || '')) r.target = (toolTarget(r.raw) || hint || String(tc.title || '')).slice(0, 4000);
    return r;
  }

  // 模型库注入的是 claclaw-<供应商>/<模型>
  ownModel(o, store) {
    const v = String(o.value), m = v.match(/^claclaw-([^/]+)\/(.+)$/);
    const sp = m ? store.providers.find(p => p.id === m[1]) : null;
    return { value: v, label: String(o.name || v), id: m ? m[2] : v, base: sp ? Object.values(sp.endpoints)[0] : '' };
  }
}

// 新建：在某个目录里开一个新的 kimi 会话
export const kmNewSession = (cwd, opts) => KmRunner.create(cwd, opts);

// 删除：先 kimi export 存一份 zip 到 claclaw 回收站，再 ACP session/delete
export async function kmDelete(id, trashDir, log) {
  const sid = sidOf(id);
  if (!validSid(sid) || !(await kmInfo(id))) throw new Error('找不到这个会话');
  const file = trashPath(trashDir, 'kimi', sid, '.zip');
  await runBin(['export', sid, '-o', file, '-y', '--no-include-global-log'], 120000);
  if (!fs.existsSync(file)) throw new Error('导出失败，未删除');
  await agent.use(log);
  try { await agent.rpc('session/delete', { sessionId: sid }); } finally { agent.idleCheck(); }
  dropListCache();
  return file;
}

// 改名（见文件开头）。终端里正开着同一个会话的 kimi 之后写元数据时会把名字改回去，要在终端里重开
export async function kmRename(id, title, log) {
  const sid = sidOf(id);
  const s = validSid(sid) ? await kmInfo(id).catch(() => null) : null;
  if (!s?.dir) throw new Error('找不到这个会话');
  const file = path.join(s.dir, 'state.json');
  assertInside(file, path.join(KHOME, 'sessions'));
  const r = kmRunners.get(id);
  if (r?.busy) throw busyRename();
  if (r?.attached || agent.owners.has(sid)) {
    // 先让 kimi 放下这个会话，免得它拿内存里的旧标题写回去；runner 留着（网页里照常显示），下次发消息再 session/load 接上
    if (r) r.attached = false;
    try { await agent.rpc('session/close', { sessionId: sid }); } catch {}
    agent.closedAt.set(sid, Date.now());
    if (agent.owners.get(sid) === r || !r) agent.owners.delete(sid);
    agent.idleCheck();
  }
  await agent.waitClosing(sid);
  const meta = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (meta?.id && meta.id !== sid) throw new Error('会话记录对不上');
  writeFileAtomic(file, JSON.stringify({ ...meta, title, titleKind: 'custom', isCustomTitle: true }));
  dropListCache();
  log?.('kimi renamed', sid.slice(0, 16));
  return title;
}
