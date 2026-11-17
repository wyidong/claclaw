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
import { AcpAgent, AcpLoadRunner, localNames, stripTags, listItem, localRename, syncJsonConfig, notFound, assertInside, toTrash } from './acp.mjs';
import { HOME, findBin } from '../util.mjs';
import { storeNow, qoderInject, qoderSettingsMerge } from '../modelpick.mjs';
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

export const qdSessionList = ({ busy = () => false } = {}) => store.listRows().map(s => {
  const id = QD_PREFIX + s.id;
  return listItem('qoder', id, busy, { ...s, title: localNames.get(id) || s.title || 'Qoder 会话', branch: s.model });
});
export const qdInfo = id => isQd(id) ? store.info(sidOf(id)) : null;
export const qdExists = id => !!qdInfo(id);

// ---------- 模型库 → settings.json 的 customModels ----------
function syncSettings(log) {
  const inj = qoderInject(storeNow());
  syncJsonConfig(SETTINGS, { tag: 'qoder', count: inj.list.length, merge: cur => qoderSettingsMerge(cur, inj), log });
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

// ---------- 打开的 Qoder 会话 ----------
export const qdRunners = new Map();

export class QdRunner extends AcpLoadRunner {
  static agent = agent; static prefix = QD_PREFIX; static runners = qdRunners; static label = 'Qoder';

  sessionInfo() { return qdInfo(this.id); }
  cleanUser(text) { return stripTags(text); }
  afterReplay() { this.items = store.afterReplay(this.items, qdInfo(this.id)?.file); }

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
  if (!s?.file) throw notFound();
  assertInside(s.file, store.PROJECTS);
  const dest = toTrash(trashDir, 'qoder', id, s, { ext: '.jsonl' });
  try {
    await agent.use(log);
    try { await agent.rpc('session/delete', { sessionId: s.id, cwd: s.cwd || HOME }); } finally { agent.idleCheck(); }
  } catch (e) { log?.('qoder session/delete failed, removing file:', e.message); }
  if (fs.existsSync(s.file)) fs.unlinkSync(s.file);
  store.fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export const qdRename = localRename(qdInfo, qdRunners);
