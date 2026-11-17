// GLM Agent 适配（社区做的 ACP agent，npm 包 glm-acp-agent，默认用智谱 Z.AI 的 GLM Coding Plan）。
// 全部走 ACP：claclaw 起一个 `glm-acp-agent`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：读会话目录（默认 ~/.local/state/glm-acp-agent/sessions/<id>.json，整个会话一个 JSON：title / cwd / model / messages）
// - 历史：ACP session/load 会把整段历史用 session/update 重放一遍，收下来转成网页条目（和 Kimi 一样）；记录里没有时间
// - 模型：GLM Agent 说的是 OpenAI 兼容接口，接口地址、key、模型清单都从环境变量给（ACP_GLM_BASE_URL / Z_AI_API_KEY /
//   ACP_GLM_AVAILABLE_MODELS），一个进程只能用一个供应商：选模型库的模型时 claclaw 按那家供应商起进程（它的几个模型在进程里随便换），
//   换到别家要重启进程（所有 GLM 会话一起换）；走哪家记在 data/glm-route.json。GLM 自带（Z.AI）要有 Z_AI_API_KEY 或 glm-acp-agent --setup 存过 key
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：把会话文件挪进回收站
// 网页里 GLM 会话的 id = 'gl:' + 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import { AcpAgent, AcpLoadRunner, localNames, validSid, listItem, localRename, readDir, fileRows, envSig, v1, libGroup, notFound, toTrash } from './acp.mjs';
import { HOME, oneLine, findBin, readJson } from '../util.mjs';
import { DATA } from '../auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels, routeNow } from '../modelpick.mjs';

export const GL_PREFIX = 'gl:';
export const isGl = id => typeof id === 'string' && id.startsWith(GL_PREFIX);
const sidOf = id => id.slice(GL_PREFIX.length);

const STATE = process.env.XDG_STATE_HOME || path.join(HOME, '.local', 'state');
const SESSIONS = process.env.ACP_GLM_SESSION_DIR || path.join(STATE, 'glm-acp-agent', 'sessions');
const CREDS = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'glm-acp-agent', 'credentials.json');

export const glBin = () => findBin('glm-acp-agent');
export const glInstalled = () => !!glBin();
export function glVersion() {
  const bin = glBin();
  if (!bin) return '';
  try { return JSON.parse(fs.readFileSync(path.resolve(path.dirname(fs.realpathSync(bin)), '..', 'package.json'), 'utf8')).version || ''; } catch { return ''; }
}

// ---------- 会话列表 ----------
const fileCache = new Map();
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => x?.type === 'text' ? x.text : '').join('') : '';
function parseFile(f, st) {
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  const sid = String(o.sessionId || path.basename(f, '.json'));
  if (!validSid(sid)) return null;
  const first = (o.messages || []).find(m => m?.role === 'user');
  return { id: sid, title: oneLine(o.title || textOf(first?.content)).slice(0, 100), cwd: String(o.cwd || ''), model: String(o.model || ''), updated: Date.parse(o.updatedAt) || st.mtimeMs, file: f };
}
const listRows = () => fileRows(fileCache, readDir(SESSIONS).filter(n => n.endsWith('.json')).map(n => path.join(SESSIONS, n)), parseFile)
  .map(r => ({ ...r, title: localNames.get(GL_PREFIX + r.id) || r.title }));
export const glSessionList = ({ busy = () => false } = {}) => listRows().map(s => listItem('glm', GL_PREFIX + s.id, busy, { ...s, title: s.title || 'GLM 会话', branch: s.model }));
export const glInfo = id => isGl(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const glExists = id => !!glInfo(id);

// ---------- 模型走法（见文件开头） ----------
const ROUTE_FILE = path.join(DATA, 'glm-route.json');
const FMTS = ['openai'];
const ownUsable = () => !!process.env.Z_AI_API_KEY || fs.existsSync(CREDS);
const OWN_MODELS = ['glm-5.3', 'glm-5.3-flash', 'glm-5-turbo', 'glm-4.7'];   // Z.AI Coding Plan 的模型（进程在用别家时列不出来，先写死）
const OWN_LOGIN = 'GLM 自带的模型要 Z.AI 的 key：在电脑终端运行 glm-acp-agent --setup（或设环境变量 Z_AI_API_KEY）';
const route = (store = storeNow()) => routeNow(readJson(ROUTE_FILE, {}), store, FMTS, ownUsable, true);
function routeEnv() {
  const hit = route(), env = {};
  if (hit) {
    env.Z_AI_API_KEY = hit.p.key || 'none';
    env.ACP_GLM_BASE_URL = v1(hit.p.endpoints.openai);
    env.ACP_GLM_AVAILABLE_MODELS = hit.p.models.map(m => m.id).join(',');
    env.ACP_GLM_MODEL = hit.m.id;
  }
  return { env, sig: envSig(env) };
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'glm', bin: glBin, missing: '没找到 glm-acp-agent 命令，先装好 GLM Agent（npm i -g glm-acp-agent）',
  command: bin => [bin, []],
  prepare: () => routeEnv(),
  rpcError: e => /authenticat|api key|credential/i.test(e.message || '') ? OWN_LOGIN : '',
});
export const glShutdown = () => agent.stop();
export function glModelsChanged(log) { if (glInstalled()) agent.modelsChanged(routeEnv().sig, log); }
export const glAcpRunning = () => agent.running;

// ---------- 打开的 GLM 会话 ----------
export const glRunners = new Map();

export class GlRunner extends AcpLoadRunner {
  static agent = agent; static prefix = GL_PREFIX; static runners = glRunners;
  static label = 'GLM'; static group = 'GLM Agent';

  sessionInfo() { return glInfo(this.id); }

  // 进程里的模型清单：走模型库时就是那家供应商的模型（按模型 ID 对回模型库）
  ownModel(o, store) {
    const v = String(o.value), hit = route(store);
    const sp = hit ? store.providers.find(p => p.id === hit.p.id && p.models.some(m => m.id === v)) : null;
    return { value: v, label: String(o.name || v), id: v, base: sp ? sp.endpoints.openai : '' };
  }
  // 模型选择：模型库一组（所有有 OpenAI 兼容地址的）+ GLM 自带一组。走模型库时勾模型库里当前这条
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libModels(store, FMTS), hit = route(store);
    const curId = this.config ? String(this.config.find(o => o.id === 'model')?.currentValue || '') : '';
    const libItems = libGroup(lib, x => hit && x.p.id !== hit.p.id ? '（换供应商会重启 GLM Agent，所有 GLM 会话一起换）' : '');
    const usable = ownUsable();
    const ownItems = hit
      ? OWN_MODELS.map(id => ({ value: id, label: id, sub: usable ? '用 Z.AI Coding Plan（会重启 GLM Agent，所有 GLM 会话一起换）' : '要先运行 glm-acp-agent --setup', disabled: !usable }))
      : (base.groups || []).filter(g => g.name !== STORE_GROUP).flatMap(g => g.items).map(it => usable ? it : { ...it, disabled: true, sub: '要先运行 glm-acp-agent --setup' });
    if (!libItems.length && !hit) return base;
    const cur = hit ? (lib.find(x => x.p.id === hit.p.id && x.m.id === (curId || hit.m.id)) || hit).value : base.current;
    return { ...base, current: cur, label: hit ? (lib.find(x => x.value === cur)?.m.name || curId || hit.m.id) : base.label, groups: [...libItems, ...(ownItems.length ? [{ name: 'GLM 自带', items: ownItems }] : [])] };
  }
  // 同一家供应商里换模型：进程里直接换；换供应商 / 换回 Z.AI：记下走法、重启进程（所有 GLM 会话一起换），再接上。
  // 刚新建、还没发过消息的会话 agent 还没存下来，新进程里接不上：在同一个目录重建一个，返回 { runner, label } 让网页换过去
  async pickModel(value) {
    const store = storeNow(), hit = route(store), toLib = value.startsWith(LIB);
    const next = toLib ? libModels(store, FMTS).find(x => x.value === value) : null;
    if (toLib && !next) throw new Error('没有这个模型');
    if (!toLib && !ownUsable()) throw new Error(OWN_LOGIN);
    const model = toLib ? next.m.id : value;
    if ((toLib && hit && next.p.id === hit.p.id) || (!toLib && !hit)) return super.pickModel(model);
    if (this.busy) throw new Error('这一轮结束后再换模型');
    const empty = !glInfo(this.id);
    this.reroute(ROUTE_FILE, next ? { provider: next.p.id } : { own: true }, next ? next.p.id : 'Z.AI', '一个进程');
    if (empty) {
      const r = await GlRunner.create(this.cwd || HOME, this.opts);
      return { runner: r, label: await r.pickModel(model) };
    }
    await this.attach();
    return super.pickModel(model);
  }
}

export const glNewSession = (cwd, opts) => GlRunner.create(cwd, opts);

// 删除：会话文件挪进回收站（agent 没有删除接口）
export function glDelete(id, trashDir) {
  const s = glInfo(id);
  if (!s?.file) throw notFound();
  const dest = toTrash(trashDir, 'glm', id, s, { ext: '.json', move: true });
  fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}
export const glRename = localRename(glInfo, glRunners);
