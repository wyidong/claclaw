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
import { AcpAgent, AcpLoadRunner, localNames, stripTags, listItem, localRename, syncJsonConfig, notFound, assertInside, toTrash } from './acp.mjs';
import { HOME, findBin } from '../util.mjs';
import { storeNow, codebuddyInject, codebuddyMerge } from '../modelpick.mjs';
import { makeStore } from './cclike.mjs';

export const CB_PREFIX = 'cb:';
export const isCb = id => typeof id === 'string' && id.startsWith(CB_PREFIX);
const sidOf = id => id.slice(CB_PREFIX.length);

const CHOME = process.env.CODEBUDDY_CONFIG_DIR || path.join(HOME, '.codebuddy');
const MODELS = path.join(CHOME, 'models.json');
const store = makeStore({ root: CHOME });

export const cbBin = () => findBin('codebuddy');
export const cbInstalled = () => !!cbBin() || fs.existsSync(store.PROJECTS);

export const cbSessionList = ({ busy = () => false } = {}) => store.listRows().map(s => {
  const id = CB_PREFIX + s.id;
  return listItem('codebuddy', id, busy, { ...s, title: localNames.get(id) || s.title || 'CodeBuddy 会话', branch: s.model });
});
export const cbInfo = id => isCb(id) ? store.info(sidOf(id)) : null;
export const cbExists = id => !!cbInfo(id);

// ---------- 模型库 → models.json ----------
function syncModels(log) {
  const inj = codebuddyInject(storeNow());
  syncJsonConfig(MODELS, { tag: 'codebuddy', count: inj.models.length, merge: cur => codebuddyMerge(cur, inj), log });
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

// ---------- 打开的 CodeBuddy 会话 ----------
export const cbRunners = new Map();

export class CbRunner extends AcpLoadRunner {
  static agent = agent; static prefix = CB_PREFIX; static runners = cbRunners; static label = 'CodeBuddy';

  sessionInfo() { return cbInfo(this.id); }
  cleanUser(text) { return stripTags(text); }
  afterReplay() { this.items = store.afterReplay(this.items, cbInfo(this.id)?.file); }

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
  if (!s?.file) throw notFound();
  assertInside(s.file, store.PROJECTS);
  const dest = toTrash(trashDir, 'codebuddy', id, s, { ext: '.jsonl', move: true });
  const sub = s.file.slice(0, -'.jsonl'.length);
  if (fs.existsSync(sub)) fs.renameSync(sub, dest.slice(0, -'.jsonl'.length));
  store.fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export const cbRename = localRename(cbInfo, cbRunners);
