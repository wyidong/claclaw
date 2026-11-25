// Gemini CLI 适配（Google 的 `gemini`，npm 包 @google/gemini-cli；Qwen Code、iFlow 都是它的分支）。
// 全部走 ACP：claclaw 起一个 `gemini --acp`（旧版叫 --experimental-acp，按装的版本选），多个会话共用。
// - 会话列表：读 ~/.gemini/tmp/<项目>/chats/session-*.jsonl（一行一条：第一行是会话信息，之后是消息和 {"$set":…} 补丁）；
//   项目目录在同级的 .project_root 里。没有用户真说过的话的不列（gemini 每次起进程会在进程目录留一个只有 <session_context> 的空会话）
// - 历史：session/load 会把整段历史用 session/update 重放一遍（第一条是它塞的 <session_context>，去掉）；时间从记录文件对回去
// - 改名：没有接口。追加一条 {"$set":{"summary":…}}（gemini 自己的 /resume 列表也显示它；已有 summary 时它不会再自动生成），
//   名字同时记在 claclaw 这边；删除：会话文件挪进 claclaw 回收站
// - 登录：Google 账号（手机上打开网址、把授权码粘回来，见 login.mjs）或 Gemini API key（模型库里 Gemini 格式的 key 都能选）。
//   用哪种由 gemini 设置里的 security.auth.selectedType 决定，claclaw 起进程前按选择写好；key 只走环境变量 GEMINI_API_KEY，不落盘
// - 网络：Google 的接口国内要走代理。claclaw 自己有 HTTPS_PROXY 就照传；没有时本机 7890 / 7897（Clash）开着就替它带上
// 网页里 Gemini 会话的 id = 'gm:' + gemini 会话 id（UUID）。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { AcpAgent, AcpLoadRunner, commandsWith, localNames, stampTimes, validSid, listItem, readDir, readLines, fileRows, envSig, libGroup, notFound, busyRename, assertInside, toTrash, writeFileAtomic } from './acp.mjs';
import { HOME, tilde, oneLine, findBin, readJson, writeJsonAtomic } from '../util.mjs';
import { DATA } from '../auth.mjs';
import { storeNow, STORE_GROUP, LIB, libModels } from '../modelpick.mjs';

export const GM_PREFIX = 'gm:';
export const isGm = id => typeof id === 'string' && id.startsWith(GM_PREFIX);
const sidOf = id => id.slice(GM_PREFIX.length);

const GHOME = path.join(process.env.GEMINI_CLI_HOME || HOME, '.gemini');
const TMP = path.join(GHOME, 'tmp');
const SETTINGS = path.join(GHOME, 'settings.json');
const OAUTH = path.join(GHOME, 'oauth_creds.json');
const ENV_FILE = path.join(GHOME, '.env');

export const gmBin = () => findBin('gemini');
export const gmInstalled = () => !!gmBin();
// 装的版本：顺着程序的真实路径往上找 @google/gemini-cli 的 package.json（不用起进程）
export function gmVersion(bin = gmBin()) {
  let d; try { d = path.dirname(fs.realpathSync(bin)); } catch { return ''; }
  for (let i = 0; i < 4; i++, d = path.dirname(d)) { const p = readJson(path.join(d, 'package.json'), null); if (p?.name === '@google/gemini-cli') return String(p.version || ''); }
  return '';
}

// ACP 开关：新版 --acp，旧版只有 --experimental-acp。看装的这份代码里有没有 option("acp"（按程序路径和修改时间缓存）
let flagCache = { key: '', flag: '--acp' };
export function acpFlag(bin = gmBin()) {
  let real; try { real = fs.realpathSync(bin); } catch { return '--acp'; }
  let st; try { st = fs.statSync(real); } catch { return '--acp'; }
  const key = real + ':' + st.mtimeMs;
  if (flagCache.key === key) return flagCache.flag;
  let flag = '--experimental-acp';
  const dir = path.dirname(real);
  for (const n of [path.basename(real), ...readDir(dir).filter(n => /^gemini[-\w]*\.js$/.test(n))]) {
    try { if (fs.readFileSync(path.join(dir, n), 'utf8').includes('option("acp"')) { flag = '--acp'; break; } } catch {}
  }
  flagCache = { key, flag };
  return flag;
}

// ---------- 代理 ----------
// 有 HTTPS_PROXY / HTTP_PROXY 就不管（gemini 自己认）；没有时探本机 Clash 的端口，开着就带上（结果缓存 60 秒）。
// 只有 ALL_PROXY=socks5 的不算：gemini 的请求库不走 socks
const hasHttpProxy = (env = process.env) => !!(env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy);
const portOpen = port => new Promise(ok => {
  const s = net.connect({ host: '127.0.0.1', port });
  s.once('connect', () => { s.destroy(); ok(true); }); s.once('error', () => ok(false)); s.setTimeout(400, () => { s.destroy(); ok(false); });
});
let pxCache = { at: 0, env: {} };
export async function gmProxyEnv(ports = [7890, 7897]) {
  if (hasHttpProxy()) return {};
  if (Date.now() - pxCache.at < 60000) return pxCache.env;
  let env = {};
  for (const p of ports) if (await portOpen(p)) { const u = 'http://127.0.0.1:' + p; env = { HTTPS_PROXY: u, HTTP_PROXY: u }; break; }
  const no = (process.env.NO_PROXY || process.env.no_proxy || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const h of ['localhost', '127.0.0.1', '::1']) if (!no.includes(h)) no.push(h);
  if (env.HTTPS_PROXY) env.NO_PROXY = no.join(',');
  pxCache = { at: Date.now(), env };
  return env;
}
export const gmProxyCached = () => hasHttpProxy() ? {} : pxCache.env;   // 登录命令是同步起的：用上次探到的

// ---------- 登录情况 ----------
const exists = f => { try { return fs.statSync(f).size > 0; } catch { return false; } };
const userType = () => String(readJson(SETTINGS, {})?.security?.auth?.selectedType || '');
export const gmGoogleOk = () => exists(OAUTH);   // Google 账号登录过（gemini 把凭据存在这里；开了加密存储的在钥匙串里，认不出）
const envKey = () => {
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return true;
  try { return /^\s*(export\s+)?(GEMINI_API_KEY|GOOGLE_API_KEY)\s*=\s*\S/m.test(fs.readFileSync(ENV_FILE, 'utf8')); } catch { return false; }
};
// 不靠模型库也能用：Google 登录过、自己配了 key、或者选的是 Vertex / 网关这类 claclaw 不管的认证
const ownUsable = () => gmGoogleOk() || envKey() || ['vertex-ai', 'gateway', 'compute-default-credentials', 'cloud-shell'].includes(userType());
export function gmLoggedIn() { try { return ownUsable(); } catch { return false; } }

// ---------- 用哪把 key（data/gemini-route.json） ----------
// { provider, model? }：模型库里的某家（model：在模型库那组里选的模型，起进程时设成默认）；
// { keyHash }：网页上新填的 key（存进模型库前还不知道供应商 id，按 key 的哈希认）；{ own: true }：用 Google 账号 / 自己配的认证
const ROUTE_FILE = path.join(DATA, 'gemini-route.json');
const FMTS = ['gemini'];
export const keyHash = k => crypto.createHash('sha256').update(String(k || '')).digest('hex').slice(0, 16);
export const gmKeys = (store = storeNow()) => store.providers.filter(p => p.endpoints?.gemini && p.key);
const OWN_LOGIN = 'Gemini 还没登录：在 Claw 页 Gemini 卡片上点「登录」（Google 账号或 API key），或在模型管理里加一个 Gemini 的 key';
export function route(store = storeNow(), r = readJson(ROUTE_FILE, {})) {
  const keys = gmKeys(store);
  if (r.own && ownUsable()) return null;
  const p = (r.provider && keys.find(x => x.id === r.provider)) || (r.keyHash && keys.find(x => keyHash(x.key) === r.keyHash)) || (!ownUsable() ? keys[0] : null);
  return p ? { p, model: r.provider === p.id ? String(r.model || '') : '' } : null;
}
export const gmRouteSet = r => writeJsonAtomic(ROUTE_FILE, r);
// 网页上重新登录 Google（换账号）：旧凭据先挪开，登录成功就丢进回收站，失败 / 取消就放回去
const OAUTH_BAK = OAUTH + '.claclaw-bak';
export function gmLoginBegin(log) {
  gmSetType('oauth-personal', log);   // 认证方式先设成 Google：它一起来就打网址，不弹选择框
  if (exists(OAUTH)) { fs.renameSync(OAUTH, OAUTH_BAK); log?.('gemini: old google creds set aside'); }
}
export function gmLoginEnd(ok, log, trashDir = path.join(DATA, 'trash')) {
  if (!fs.existsSync(OAUTH_BAK)) return;
  try {
    if (ok || exists(OAUTH)) { fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 }); fs.renameSync(OAUTH_BAK, path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_gemini_oauth_creds.json')); }
    else { fs.renameSync(OAUTH_BAK, OAUTH); log?.('gemini: old google creds restored'); }
  } catch (e) { log?.('gemini creds restore failed', e.message); }
}
// 网页上换了登录方式（login.mjs 调）：key → 记哈希；模型库的 → 记供应商；Google → own
export function gmUse({ key = '', provider = '', google = false } = {}, log) {
  if (google) gmRouteSet({ own: true });
  else if (provider) { if (!gmKeys().some(p => p.id === provider)) throw new Error('模型库里没有这把 Gemini key'); gmRouteSet({ provider }); }
  else if (key) gmRouteSet({ keyHash: keyHash(key) });
  gmModelsChanged(log);   // 进程按新的认证重起（有会话接着就等它们关了再重起）
}
// 模型库里能选的 key（登录面板列出来；只给名字和后 4 位）
export const gmKeyChoices = () => { const hit = route(); return gmKeys().map(p => ({ id: p.id, label: p.name + (p.label ? ' · ' + p.label : ''), last4: String(p.key).slice(-4), on: hit?.p.id === p.id })); };

// gemini 设置里的认证方式：按这次的走法写好（用模型库的 key → gemini-api-key；用 Google → oauth-personal），别的设置原样留着。
// 只在要变的时候写；写之前备份一份到 claclaw 回收站
export function wantType(hit, cur = userType()) {
  if (hit) return 'gemini-api-key';
  if (gmGoogleOk() && (readJson(ROUTE_FILE, {}).own || !cur || (cur === 'gemini-api-key' && !envKey()))) return 'oauth-personal';
  return cur || (envKey() ? 'gemini-api-key' : '');
}
export function gmSetType(type, log, trashDir = path.join(DATA, 'trash')) {
  if (!type) return false;
  let text = '', cur = {};
  try { text = fs.readFileSync(SETTINGS, 'utf8'); } catch {}
  if (text.trim()) { try { cur = JSON.parse(text); } catch { log?.('gemini settings.json 不是标准 JSON，没有改认证方式'); return false; } }
  if (cur?.security?.auth?.selectedType === type) return false;
  if (text.trim()) { try { fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 }); fs.copyFileSync(SETTINGS, path.join(trashDir, new Date().toISOString().replace(/[:.]/g, '-') + '_gemini_settings.json')); } catch {} }
  const next = { ...cur, security: { ...(cur.security || {}), auth: { ...(cur.security?.auth || {}), selectedType: type } } };
  writeFileAtomic(SETTINGS, JSON.stringify(next, null, 2) + '\n', 0o600);
  log?.('gemini auth type →', type);
  return true;
}
// 起进程用的环境变量：代理 + 用模型库的 key 时的 GEMINI_API_KEY（自建转发地址给 GOOGLE_GEMINI_BASE_URL，模型库那组选过的模型给 GEMINI_MODEL）
function envFor(hit, px) {
  const env = { ...px };
  if (hit) {
    env.GEMINI_API_KEY = hit.p.key;
    const base = String(hit.p.endpoints.gemini).replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');
    if (!/^https:\/\/generativelanguage\.googleapis\.com$/i.test(base)) env.GOOGLE_GEMINI_BASE_URL = base;
    if (hit.model) env.GEMINI_MODEL = hit.model;
  }
  return env;
}
const sigOf = (env, hit) => envSig({ ...env, type: wantType(hit) });
async function prepare(log) {
  const hit = route(), env = envFor(hit, await gmProxyEnv());
  gmSetType(wantType(hit), log);
  return { env, sig: sigOf(env, hit) };
}

// ---------- 会话列表 ----------
const fileCache = new Map();
const IGNORED = /^\s*(\/|\?|<session_context>|<hook_context>)/;   // gemini 自己也不把这些算成用户说的话
const textOf = c => typeof c === 'string' ? c : Array.isArray(c) ? c.map(p => typeof p === 'string' ? p : typeof p?.text === 'string' && !p.thought ? p.text : '').join('') : '';
// 重放时工具结果也当用户消息发来（「[Function Response: 工具名]」），一并去掉
export const stripCtx = t => String(t || '').replace(/\s*<(session_context|hook_context)>[\s\S]*?<\/\1>\s*/g, '\n').replace(/^\s*\[Function (Response|Call): [^\]\n]*\]\s*$/gm, '').trim();
const rootOf = dir => { try { return fs.readFileSync(path.join(dir, '.project_root'), 'utf8').trim(); } catch { return ''; } };
export function parseFile(f, st) {
  let meta = {}, first = '', model = '', summary = '', ctx, real = false;
  for (const l of readLines(f, st.size)) {
    if (!l || l[0] !== '{') continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.$set) { if (typeof o.$set.summary === 'string') summary = o.$set.summary; continue; }
    if (o.sessionId && !o.type) { meta = o; if (typeof o.summary === 'string') summary = o.summary; continue; }
    if (o.type === 'user') { const t = textOf(o.content); if (!IGNORED.test(t) && t.trim()) { real = true; if (!first) first = stripCtx(t); } }
    else if (o.type === 'gemini') { if (o.model) model = o.model; if (o.tokens?.input > 0) ctx = o.tokens.input; }
  }
  const sid = String(meta.sessionId || '');
  if (!real || !validSid(sid) || meta.kind === 'subagent') return null;
  return { id: sid, title: oneLine(summary || first).slice(0, 100), cwd: rootOf(path.dirname(path.dirname(f))), model, ctx, updated: Math.max(Date.parse(meta.lastUpdated) || 0, st.mtimeMs), file: f };
}
const listRows = () => fileRows(fileCache, readDir(TMP).flatMap(d => {
  const chats = path.join(TMP, d, 'chats');
  return readDir(chats).filter(n => /^session-.*\.jsonl?$/.test(n)).map(n => path.join(chats, n));
}), parseFile).map(r => ({ ...r, title: localNames.get(GM_PREFIX + r.id) || r.title }));
export function gmSessionList({ busy = () => false } = {}) {
  return listRows().map(s => listItem('gemini', GM_PREFIX + s.id, busy, { ...s, title: s.title || 'Gemini 会话', branch: s.model }));
}
export const gmInfo = id => isGm(id) ? listRows().find(s => s.id === sidOf(id)) || null : null;
export const gmExists = id => !!gmInfo(id);
// 消息时间（重放历史不带时间）：用户说的话、带文字的回复
export function timesOf(f) {
  const recs = [];
  let txt; try { txt = fs.readFileSync(f, 'utf8'); } catch { return recs; }
  for (const l of txt.split('\n')) {
    if (!l.includes('"type"')) continue;
    let o; try { o = JSON.parse(l); } catch { continue; }
    const at = Date.parse(o.timestamp) || 0, t = textOf(o.content);
    if (o.type === 'user' && t.trim() && !IGNORED.test(t)) recs.push({ kind: 'user', text: stripCtx(t), at });
    else if (o.type === 'gemini' && t.trim()) recs.push({ kind: 'ai', at });
  }
  return recs;
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'gemini', bin: gmBin, missing: '没找到 gemini 命令，先装好 Gemini CLI（npm i -g @google/gemini-cli，或在 Claw 页点「安装」）',
  command: bin => [bin, [acpFlag(bin)]],
  prepare,
  rpcError: e => {
    const m = String(e.data?.details || e.data?.message || e.message || '');
    if (/auth(entication)? required|api key is missing|not configured|authenticat|login|credential/i.test(m)) return OWN_LOGIN;
    if (/quota|RESOURCE_EXHAUSTED|429/i.test(m)) return 'Gemini 额度用完了（免费额度按分钟、按天限次），过一会儿再试，或换个模型 / key：' + m.slice(0, 160);
    if (/fetch failed|ETIMEDOUT|ECONNRESET|ENOTFOUND|network/i.test(m)) return '连不上 Google 的接口（国内要开代理）：' + m.slice(0, 160);
    return '';
  },
});
// 模型库 / 登录方式变了：签名不同就等会话都关了重启进程（代理只看上次探到的，不现探）
export function gmModelsChanged(log) { if (gmInstalled()) { const hit = route(); agent.modelsChanged(sigOf(envFor(hit, gmProxyCached()), hit), log); } }
export const gmShutdown = () => agent.stop();
export const gmAcpRunning = () => agent.running;

// 模式（ACP 的 modes）：中文名
const MODE_GM = {
  default: ['每次询问', '改文件、跑命令前先问你'],
  autoedit: ['自动改文件', '改文件不问，跑命令还会问'],
  yolo: ['全部自动', '什么都不问'],
  plan: ['只做计划', '只读，先出方案、不动手'],
};

// ---------- 打开的 Gemini 会话 ----------
export const gmRunners = new Map();

export class GmRunner extends AcpLoadRunner {
  static agent = agent; static prefix = GM_PREFIX; static runners = gmRunners; static label = 'Gemini';
  static commands = commandsWith('审批模式');
  static titleFromAgent = false;

  sessionInfo() { return this.cwd && this.title ? null : gmInfo(this.id); }
  ctxNow() { return this.ctx ?? gmInfo(this.id)?.ctx; }
  cleanUser(text) { return stripCtx(text); }
  afterReplay() {
    const f = gmInfo(this.id)?.file; if (f) stampTimes(this.items, timesOf(f));
    const m = route()?.model;   // 模型库那组选过的模型：接上的老会话也换过去
    if (m) agent.rpc('session/set_model', { sessionId: this.sid, modelId: m }).catch(e => this.log?.('gemini set_model failed', e.message || e));
  }
  metaLine() { return tilde(this.cwd || '') + (this.model ? ' · ' + this.model : ''); }

  // 模型 / 模式在 session/new、session/load 应答的 models / modes 里（不是 configOptions）：合成选项，走 session/set_model / set_mode
  cfgOf(r) {
    const models = r?.models, modes = r?.modes, cfg = [];
    const pick = route()?.model;
    if (models?.availableModels?.length) {
      const opts = models.availableModels.map(m => ({ value: m.modelId, name: m.name || m.modelId, description: m.description || '' }));
      if (pick && !opts.some(o => o.value === pick)) opts.push({ value: pick, name: pick, description: '模型库' });
      cfg.push({ id: 'model', name: '模型', category: 'model', _set: 'model', currentValue: pick || models.currentModelId, options: opts });
    } else { const c = this.agent.cachedModels(); if (c) cfg.push({ ...c, _set: 'model', currentValue: pick || null }); }
    if (modes?.availableModes?.length) cfg.push({ id: 'mode', name: '模式', category: 'mode', _set: 'mode', currentValue: modes.currentModeId, options: modes.availableModes.map(m => { const z = MODE_GM[String(m.id).toLowerCase()]; return { value: m.id, name: z ? z[0] : m.name, description: z ? z[1] : m.description || '' }; }) });
    return cfg;
  }
  // 模型选择：Gemini 自带的一组（Google 账号、API key 都能用）+ 模型库里 Gemini 格式的模型（选了就用那家的 key）
  // + 用着模型库的 key、又登录过 Google 时，一条「换回 Google 账号」
  xmodels() {
    const base = super.xmodels(), store = storeNow(), lib = libModels(store, FMTS), hit = route(store);
    const libItems = libGroup(lib, x => hit?.p.id === x.p.id ? '' : '（换成这把 key，会重启 Gemini，所有 Gemini 会话一起换）');
    const usable = !!hit || ownUsable();
    const own = (base.groups || []).filter(g => g.name !== STORE_GROUP).map(g => ({ ...g, items: g.items.map(it => usable ? it : { ...it, disabled: true, sub: '要先登录 Google 账号或填 API key' }) })).filter(g => g.items.length);
    const back = hit && gmGoogleOk() ? [{ name: 'Google 账号', items: [{ value: 'own', label: '用 Google 账号登录的额度', sub: '不用模型库的 key（会重启 Gemini，所有 Gemini 会话一起换）' }] }] : [];
    if (!base.groups && !libItems.length && !back.length) return base;
    const cur = hit && hit.model ? LIB + hit.p.id + '/' + hit.model : base.current;
    return { ...base, current: lib.some(x => x.value === cur) ? cur : base.current, groups: [...libItems, ...own, ...back] };
  }
  // 模型库的模型：同一把 key 直接 set_model（记下来，新进程默认用它）；换了 key 要重启进程（所有 Gemini 会话一起换）再接上；
  // 刚新建、还没发过消息的会话新进程里接不上：在同一个目录重建一个，返回 { runner, label } 让网页换过去
  async pickModel(value) {
    const store = storeNow(), hit = route(store);
    if (value === 'own') {
      if (!gmGoogleOk()) throw new Error(OWN_LOGIN);
      if (!hit) return this.model || 'Gemini';
      return this.switchRoute({ own: true }, 'Google 账号');
    }
    if (!value.startsWith(LIB)) {
      if (!hit && !ownUsable()) throw new Error(OWN_LOGIN);
      if (hit?.model) gmRouteSet({ provider: hit.p.id });   // 选了 Gemini 自带的：不再默认模型库那个
      return super.pickModel(value);
    }
    const next = libModels(store, FMTS).find(x => x.value === value);
    if (!next) throw new Error('没有这个模型');
    if (this.busy) throw new Error('这一轮结束后再换模型');
    if (hit?.p.id === next.p.id) {
      gmRouteSet({ provider: next.p.id, model: next.m.id });
      if (!this.attached) await this.attach();
      await agent.rpc('session/set_model', { sessionId: this.sid, modelId: next.m.id });
      this.setConfig((this.config || []).map(o => o.id === 'model' ? { ...o, currentValue: next.m.id, options: o.options.some(x => x.value === next.m.id) ? o.options : [...o.options, { value: next.m.id, name: next.m.id }] } : o));
      this.model = next.m.name || next.m.id;
      return this.model;
    }
    return this.switchRoute({ provider: next.p.id, model: next.m.id }, next.m.name || next.m.id);
  }
  async switchRoute(r, label) {
    const empty = !gmInfo(this.id);
    this.reroute(ROUTE_FILE, r, r.own ? 'Google 账号' : r.provider + '/' + r.model, '一个登录方式');
    if (empty) return { runner: await GmRunner.create(this.cwd || HOME, this.opts), label };
    await this.attach();
    if (r.model) this.model = label;
    return label;
  }
}

export const gmNewSession = (cwd, opts) => GmRunner.create(cwd, opts);

// 删除：会话文件挪进 claclaw 回收站（gemini 自己的 --delete-session 也只是删这个文件和日志）
export function gmDelete(id, trashDir) {
  const s = gmInfo(id);
  if (!s?.file) throw notFound();
  assertInside(s.file, TMP);
  const dest = toTrash(trashDir, 'gemini', id, s, { ext: path.extname(s.file), move: true });
  fileCache.delete(s.file); localNames.set(id, '');
  return dest;
}

// 改名：追加一条 {"$set":{"summary":…}}（gemini 自己的格式；追加前备份一份到回收站），名字也记在 claclaw 这边
export function gmRename(id, title, trashDir) {
  const s = gmInfo(id);
  if (!s) throw notFound();
  if (gmRunners.get(id)?.busy) throw busyRename();
  title = oneLine(title).slice(0, 200);
  localNames.set(id, title);
  const r = gmRunners.get(id); if (r) r.title = title;
  if (s.file?.endsWith('.jsonl')) {
    try {
      assertInside(s.file, TMP);
      if (trashDir) toTrash(trashDir, 'gemini-rename', id, s, { ext: '.jsonl' });
      const fd = fs.openSync(s.file, 'a');
      try { fs.writeSync(fd, JSON.stringify({ $set: { summary: title } }) + '\n'); } finally { fs.closeSync(fd); }
    } catch {}   // 写不进去也不要紧：claclaw 这边记着
  }
  return title;
}
