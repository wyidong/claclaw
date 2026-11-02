// CodeBuddy Code 适配（腾讯云的 `codebuddy`，npm 包 @tencent-ai/codebuddy-code）。
// 全部走 ACP：claclaw 起一个 `codebuddy --acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读 ~/.codebuddy/projects/<目录>/<id>.jsonl（Claude Code 式记录，见 cclike.mjs）；子代理记录在 <id>/subagents/ 里，不列
// - 历史：先按 ACP session/load 重放收；agent 不重放就从记录文件转
// - 模型：模型库写进 ~/.codebuddy/models.json（CodeBuddy 的自定义模型文件：只认 OpenAI 兼容接口，key 只能写进文件，文件 600）；
//   只碰 vendor 带「claclaw ·」的条目，用户自己的原样保留
// - 要先在电脑终端登录过 CodeBuddy（微信 / Google / 企业域），ACP 不提供登录
// - 改名：名字记在 claclaw 这边；删除：会话文件挪进回收站
// 网页里 CodeBuddy 会话的 id = 'cb:' + 会话 id（UUID）。
// 这台电脑上登不了 CodeBuddy，这一块没跑过真机：记录格式按 CodeBuddy 源码里的字段名（session_id / cwd / message）推断
import fs from 'node:fs';
import path from 'node:path';
import { AcpAgent, AcpRunner, localNames, stampTimes, stripTags } from './acp.mjs';
import { HOME, tilde, oneLine, findBin } from './util.mjs';
import { storeNow, codebuddyInject, codebuddyMerge } from './modelpick.mjs';
import { makeStore } from './cclike.mjs';

export const CB_PREFIX = 'cb:';
export const isCb = id => typeof id === 'string' && id.startsWith(CB_PREFIX);
const sidOf = id => id.slice(CB_PREFIX.length);

const CHOME = process.env.CODEBUDDY_CONFIG_DIR || path.join(HOME, '.codebuddy');
const MODELS = path.join(CHOME, 'models.json');
const store = makeStore({ root: CHOME });

export const cbBin = () => findBin('codebuddy');
export const cbInstalled = () => !!cbBin() || fs.existsSync(store.PROJECTS);

export function cbSessionList({ busy = () => false } = {}) {
  return store.listRows().map(s => ({
    id: CB_PREFIX + s.id,
    title: localNames.get(CB_PREFIX + s.id) || s.title || 'CodeBuddy 会话',
    cwd: s.cwd, cwdShort: tilde(s.cwd || ''), branch: s.model,
    lastModified: s.updated,
    openInWeb: false, busyElsewhere: null, unread: 0, webActive: 0,
    claw: 'codebuddy', busy: busy(CB_PREFIX + s.id),
  }));
}
export const cbInfo = id => isCb(id) ? store.info(sidOf(id)) : null;
export const cbExists = id => !!cbInfo(id);

// ---------- 模型库 → models.json ----------
// 内容没变就不写；models.json 读不懂就不动它，只记日志
function syncModels(log) {
  const inj = codebuddyInject(storeNow());
  let text = '', cur = {};
  try { text = fs.readFileSync(MODELS, 'utf8'); } catch {}
  if (text.trim()) { try { cur = JSON.parse(text); } catch { log?.('codebuddy models.json 不是标准 JSON，没有写入模型库'); return inj; } }
  if (!text.trim() && !inj.models.length) return inj;
  const next = codebuddyMerge(cur, inj);
  if (JSON.stringify(next) !== JSON.stringify(cur)) {
    try {
      fs.mkdirSync(CHOME, { recursive: true });
      const tmp = MODELS + '.claclaw-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, MODELS);
      log?.('codebuddy models.json synced', inj.models.length, 'models');
    } catch (e) { log?.('codebuddy models.json write failed', e.message); }
  }
  return inj;
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const LOGIN = 'CodeBuddy 还没登录：在电脑终端运行 codebuddy，按提示登录后再来';
const agent = new AcpAgent({
  name: 'codebuddy', bin: cbBin, missing: '没找到 codebuddy 命令，先装好 CodeBuddy Code（npm i -g @tencent-ai/codebuddy-code）',
  command: bin => [bin, ['--acp']],
  prepare: log => ({ env: {}, sig: syncModels(log).sig }),
  rpcError: e => /authenticat|login/i.test(e.message || '') ? LOGIN : '',
});
export function cbModelsChanged(log) { if (cbBin()) agent.modelsChanged(syncModels(log).sig, log); }
export const cbShutdown = () => agent.stop();
export const cbAcpRunning = () => agent.running;

export const COMMANDS = [
  { name: 'model', description: '切换模型（不带参数：列出可选模型）', hint: '<模型>', builtin: true },
  { name: 'mode', description: '权限模式（不带参数：列出可选项）', hint: '<模式>', builtin: true },
];

// ---------- 打开的 CodeBuddy 会话 ----------
export const cbRunners = new Map();

export class CbRunner extends AcpRunner {
  static agent = agent; static prefix = CB_PREFIX; static runners = cbRunners;
  static label = 'CodeBuddy'; static group = 'CodeBuddy'; static permPrefix = 'cb-'; static commands = COMMANDS;
  static cfgIds = { model: 'model', mode: 'mode' };
  static cfgNames = { model: '模型', mode: '模式' };
  static ctxFromUsage = true; static titleFromAgent = true;

  constructor(id, opts) { super(id, opts); this.items = []; }
  get openMethod() { return 'session/load'; }

  async prepareAttach() {
    const s = cbInfo(this.id);
    if (s) { if (!this.cwd) { this.cwd = s.cwd; this.info.cwd = s.cwd; } this.title = localNames.get(this.id) || this.title || s.title; this.model = this.model || s.model; }
    this.items = []; this.tools.clear(); this.replayOpen = null;
    this.replaying = true;
  }
  attachDone(ok) {
    this.replaying = false; this.replayOpen = null;
    if (!ok) return;
    const f = cbInfo(this.id)?.file;
    for (const it of this.items) if (it.kind === 'user') it.text = stripTags(it.text);
    this.items = this.items.filter(it => it.kind !== 'user' || it.text || it.images?.length);
    if (!this.items.length && f) this.items = store.historyOf(f);   // agent 没重放：从记录文件转
    else if (f) stampTimes(this.items, store.timesOf(f));
    if (!this.title) this.title = oneLine(this.items.find(x => x.kind === 'user')?.text || '').slice(0, 60) || 'CodeBuddy 会话';
  }
  beforePrompt(text, images) { this.items.push({ kind: 'user', text, images: images.length ? images : undefined, at: Date.now() }); }

  // 模型选项的 value 形如 custom-local:<模型 ID>（models.json 里的）或内置模型名；按模型 ID 对回模型库
  ownModel(o, store) {
    const v = String(o.value), id = v.replace(/^custom-local:/, '');
    const sp = /^custom-local:/.test(v) ? store.providers.find(p => p.endpoints?.openai && p.models.some(m => m.id === id)) : null;
    return { value: v, label: String(o.name || id), id, base: sp ? sp.endpoints.openai : '' };
  }
}

export const cbNewSession = (cwd, opts) => CbRunner.create(cwd, opts);

// 删除：会话文件（和它的子代理目录）挪进回收站
export function cbDelete(id, trashDir) {
  const s = cbInfo(id);
  if (!s?.file) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  if (!fs.realpathSync(s.file).startsWith(fs.realpathSync(store.PROJECTS) + path.sep)) throw new Error('会话目录不对');
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(trashDir, stamp + '_codebuddy_' + s.id + '.jsonl');
  fs.renameSync(s.file, dest);
  const sub = s.file.slice(0, -'.jsonl'.length);
  if (fs.existsSync(sub)) fs.renameSync(sub, path.join(trashDir, stamp + '_codebuddy_' + s.id));
  fs.writeFileSync(dest + '.origin.json', JSON.stringify({ sessionId: id, from: s.file, cwd: s.cwd, deletedAt: new Date().toISOString() }, null, 2));
  store.fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export function cbRename(id, title) {
  if (!cbInfo(id)) throw Object.assign(new Error('找不到这个会话'), { code: 404 });
  localNames.set(id, title);
  const r = cbRunners.get(id); if (r) r.title = title;
  return title;
}
