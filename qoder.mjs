// Qoder CLI 适配（阿里云的 `qodercli`，npm 包 @qoder-ai/qodercli）。
// 全部走 ACP：claclaw 起一个 `qodercli --acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读 ~/.qoder/projects/<目录>/<id>.jsonl（Claude Code 式记录，见 cclike.mjs）；agent-*.jsonl 是子代理，不列
// - 历史：先按 ACP session/load 重放收；agent 不重放就从记录文件转
// - 模型：模型库写进 ~/.qoder/settings.json 的 customModels（Qoder 的 BYOK：key 只能写进文件，文件 600；要 Qoder 个人付费订阅才认）；
//   只碰 key 带 claclaw- 前缀的条目，用户自己的原样保留
// - 要先在电脑终端 qodercli login，ACP 不提供登录
// - 删除：ACP session/delete（Qoder 有这个能力），删前把记录文件复制一份到回收站；改名：名字记在 claclaw 这边
// 网页里 Qoder 会话的 id = 'qd:' + 会话 id。
// 这台电脑上登不了 Qoder，这一块没跑过真机：记录格式按 Qoder 源码里的路径（projects/<目录>/<id>.jsonl）推断
import fs from 'node:fs';
import path from 'node:path';
import { AcpAgent, AcpRunner, localNames, stampTimes, stripTags } from './acp.mjs';
import { HOME, tilde, oneLine, findBin } from './util.mjs';
import { storeNow, qoderInject, qoderSettingsMerge } from './modelpick.mjs';
import { makeStore } from './cclike.mjs';

export const QD_PREFIX = 'qd:';
export const isQd = id => typeof id === 'string' && id.startsWith(QD_PREFIX);
const sidOf = id => id.slice(QD_PREFIX.length);

const QHOME = process.env.QODER_CONFIG_DIR || path.join(HOME, '.qoder');
const SETTINGS = path.join(QHOME, 'settings.json');
const store = makeStore({ root: QHOME, skip: n => /^agent-/.test(n) });

// findBin 的第二个参数是「先找的目录」（不是文件）。官方安装脚本把 qodercli 放在 ~/.qoder/bin/qodercli/ 下（~/.local/bin 已在默认目录里）
export const qdBin = () => findBin('qodercli', [path.join(HOME, '.qoder', 'bin', 'qodercli')]);
export const qdInstalled = () => !!qdBin() || fs.existsSync(store.PROJECTS);

export function qdSessionList({ busy = () => false } = {}) {
  return store.listRows().map(s => ({
    id: QD_PREFIX + s.id,
    title: localNames.get(QD_PREFIX + s.id) || s.title || 'Qoder 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'qoder', busy: busy(QD_PREFIX + s.id),
  }));
}
export const qdInfo = id => isQd(id) ? store.info(sidOf(id)) : null;
export const qdExists = id => !!qdInfo(id);

// ---------- 模型库 → settings.json 的 customModels ----------
function syncSettings(log) {
  const inj = qoderInject(storeNow());
  let text = '', cur = {};
  try { text = fs.readFileSync(SETTINGS, 'utf8'); } catch {}
  if (text.trim()) { try { cur = JSON.parse(text); } catch { log?.('qoder settings.json 不是标准 JSON，没有写入模型库'); return inj; } }
  if (!text.trim() && !inj.list.length) return inj;
  const next = qoderSettingsMerge(cur, inj);
  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    try {
      fs.mkdirSync(QHOME, { recursive: true });
      const tmp = SETTINGS + '.claclaw-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, SETTINGS);
      log?.('qoder settings synced', inj.list.length, 'models');
    } catch (e) { log?.('qoder settings write failed', e.message); }
  }
  return inj;
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const LOGIN = 'Qoder 还没登录：在电脑终端运行 qodercli login';
const agent = new AcpAgent({
  name: 'qoder', bin: qdBin, missing: '没找到 qodercli 命令，先装好 Qoder CLI（npm i -g @qoder-ai/qodercli）',
  command: bin => [bin, ['--acp']],
  prepare: log => ({ env: {}, sig: syncSettings(log).sig }),
  rpcError: e => /authenticat|login/i.test(e.message || '') ? LOGIN : '',
});
export function qdModelsChanged(log) { if (qdBin()) agent.modelsChanged(syncSettings(log).sig, log); }
export const qdShutdown = () => agent.stop();
export const qdAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '权限模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// ---------- 打开的 Qoder 会话 ----------
export const qdRunners = new Map();

export class QdRunner extends AcpRunner {
  static agent = agent; static prefix = QD_PREFIX; static runners = qdRunners;
  static label = 'Qoder'; static group = 'Qoder'; static permPrefix = 'qd-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = qdInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; this.model = this.model || s.model; }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    const f = qdInfo(this.id)?.file;
    for (const it of this.items) if (it.kind === 'user') it.text = stripTags(it.text);
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.items.length && f) this.items = store.historyOf(f);
    else if (f) stampTimes(this.items, store.timesOf(f));
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'Qoder 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }

  // 模型库写进去的条目 key 形如 claclaw-<供应商 id>/<模型 id>；按它对回模型库
  ownModel(o, store) {
    const v = String(o.value), m = v.match(/^claclaw-([^/]+)\/(.+)$/);
    const sp = m ? store.providers.find(p => p.id === m[1]) : null;
    return { value: v, label: String(o.name || (m ? m[2] : v)), id: m ? m[2] : v, base: sp ? (sp.endpoints.openai || sp.endpoints.anthropic) : '' };
  }
}

export const qdNewSession = (cwd, opts) => QdRunner.create(cwd, opts);

// 删除：先把记录文件复制一份到回收站，再让 Qoder 自己删（ACP session/delete）；它删不了就自己挪走文件
export async function qdDelete(id, trashDir, log) {
  const s = qdInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  if (!fs.realpathSync(s.file).startsWith(fs.realpathSync(store.PROJECTS) + path.sep)) throw new Error('会话目录不对');
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const dest = path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_qoder_' + s.id + '.jsonl');
  fs.copyFileSync(s.file, dest);
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  try {
    await agent.use(log);
    try { await agent.rpc('session/delete', { sessionId: s.id, cwd: s.cwd || HOME }); } finally { agent.idleCheck(); }
  } catch (e) { log?.('qoder session/delete failed, removing file:', e.message); }
  if (fs.existsSync(s.file)) fs.unlinkSync(s.file);
  store.fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export function qdRename(id, title) {
  if (!qdInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = qdRunners.get(id); if (r) r.title = title;
  return title;
}
