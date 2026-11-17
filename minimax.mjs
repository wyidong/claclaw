// MiniMax Code 适配（MiniMax 的 `mcode`，npm 包 @minimax-ai/code，开源）。
// 全部走 ACP：claclaw 起一个 `mcode acp`（stdin/stdout 一行一条 JSON-RPC），多个会话共用。
// - 会话列表：只读打开 ~/.minimax/v2/sqlite/runtime-state.sqlite（node:sqlite）的 local_runtime_sessions（标题、目录、时间）
// - 历史：ACP session/load 会把整段历史重放一遍（和 Kimi 一样）；时间从 local_runtime_message_rows 对回去
// - 模型：mcode 的供应商配置在 ~/.minimax/config.yaml，claclaw 不直接改它，用 mcode 自己的命令（`mcode provider add / remove`）
//   把模型库写成 claclaw-<供应商> 的自定义供应商（key 经环境变量交给命令，mcode 会把它写进 config.yaml，文件 600）；
//   进程起来时同步一次，模型库改了要重启 mcode 才看得到
// - 改名：agent 没有接口，名字记在 claclaw 这边；删除：经 mcode 自己的 app-server（`mcode app-server --stdio`）把会话归档，
//   和它界面里 /sessions 的「归档」一样，在那里可以恢复；claclaw 不直接改它的数据库
// 网页里 MiniMax 会话的 id = 'mm:' + mcode 会话 id（mvs_…）。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { AcpAgent, AcpLoadRunner, localNames, stampTimes, stripTags, validSid, listItem, localRename, envSig, v1, notFound } from './acp.mjs';
import { HOME, oneLine, findBin, binEnv, binCall } from './util.mjs';
import { storeNow, envName } from './modelpick.mjs';

export const MM_PREFIX = 'mm:';
export const isMm = id => typeof id === 'string' && id.startsWith(MM_PREFIX);
const sidOf = id => id.slice(MM_PREFIX.length);

const MHOME = process.env.MINIMAX_DATA_DIR || process.env.MAVIS_DATA_DIR || path.join(HOME, '.minimax');
const DB = path.join(MHOME, 'v2', 'sqlite', 'runtime-state.sqlite');

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
// findBin 的第二个参数是「先找的目录」（不是文件）
export const mmBin = () => findBin('mcode', [path.join(HOME, '.minimax-code', 'bin')]);
export const mmInstalled = () => !!mmBin();
export const mmSupported = () => !!sqlite;
export const mmUnsupportedReason = () => '当前 Node 没有 node:sqlite（需要 Node 22.13 以上），读不了 MiniMax Code 的会话';

// 每次查询单独开一个只读连接，用完就关
function query(fn) {
  if (!sqlite) throw new Error(mmUnsupportedReason());
  if (!fs.existsSync(DB)) return null;
  const db = new sqlite.DatabaseSync(DB, { readOnly: true });
  try { return fn(db); } finally { db.close(); }
}

// ---------- 会话列表 ----------
function listRows() {
  const rows = query(db => db.prepare(
    "select session_id, title, workspace_dir, created_at_ms, updated_at_ms, status from local_runtime_sessions where archived = 0 and visibility = 'visible' and session_kind = 'conversation' order by updated_at_ms desc"
  ).all()) || [];
  return rows.filter(r => validSid(String(r.session_id))).map(r => ({
    id: String(r.session_id), title: localNames.get(MM_PREFIX + r.session_id) || oneLine(r.title || '').slice(0, 100),
    cwd: String(r.workspace_dir || ''), updated: Number(r.updated_at_ms || r.created_at_ms || 0), status: r.status,
  }));
}
export function mmSessionList({ busy = () => false } = {}) {
  let rows = [];
  try { rows = listRows(); } catch {}
  return rows.map(s => listItem('minimax', MM_PREFIX + s.id, busy, { ...s, title: s.title || 'MiniMax 会话' }));
}
export const mmInfo = id => { if (!isMm(id)) return null; try { return listRows().find(s => s.id === sidOf(id)) || null; } catch { return null; } };
export const mmExists = id => !!mmInfo(id);
// 消息时间：local_runtime_message_rows（role、created_at_ms、data_json.msg_content）
function timesOf(sid) {
  let rows = [];
  try { rows = query(db => db.prepare('select role, created_at_ms, data_json from local_runtime_message_rows where session_id = ? order by id').all(sid)) || []; } catch {}
  const recs = [];
  for (const r of rows) {
    let d = {}; try { d = JSON.parse(r.data_json); } catch {}
    const text = typeof d.msg_content === 'string' ? d.msg_content : '';
    if (r.role === 'user') recs.push({ kind: 'user', text: stripTags(text), at: Number(r.created_at_ms) || 0 });
    else if (r.role === 'assistant' && text.trim()) recs.push({ kind: 'ai', at: Number(r.created_at_ms) || 0 });
  }
  return recs;
}

// ---------- 模型库 → mcode provider ----------
// 模型库里能给 mcode 用的：OpenAI 兼容地址优先（试过通的），其次 Anthropic（mcode 两种都说）
function wanted(store) {
  const out = [];
  for (const p of store.providers) {
    const ep = p.endpoints || {};
    if (!p.models.length) continue;
    const [format, base] = ep.openai ? ['openai-completions', v1(ep.openai)] : ep.anthropic ? ['anthropic-messages', ep.anthropic] : [];
    if (!format) continue;
    const ctx = p.models.map(m => Number(m.context) || 0);
    out.push({ p, name: 'claclaw-' + p.id, format, base, models: p.models.map(m => m.id), image: p.models.every(m => m.vision), context: ctx.every(Boolean) ? Math.min(...ctx) : 0 });
  }
  return out;
}
// 签名：模型库里给 mcode 的部分（连同 key）变了才要重新同步、重启
const wantSig = want => want.length ? envSig(want.map(w => [w.name, w.format, w.base, w.models, w.image, w.context, w.p.key || ''])) : '';
const mask = k => k ? k.slice(0, 4) + '****' + k.slice(-4) : '';
const execFileP = promisify(execFile);
// 异步跑（每次最多 60 秒，一次同步要跑好几回）：同步跑会把整个 claclaw 卡住
const mcode = async (args, env = {}, log) => {
  const bin = mmBin();
  const c = binCall(bin, args);
  try { const run = execFileP(c.cmd, c.args, { encoding: 'utf8', timeout: 60000, env: { ...binEnv(), ...env } }); run.child.stdin?.end(); return (await run).stdout; }   // stdin 关掉：不让它等输入
  catch (e) { log?.('mcode ' + args.slice(0, 2).join(' ') + ' failed:', String(e.stderr || e.message).trim().split('\n').pop()); return null; }
};
let syncedSig = null;   // 上次完整同步成功时模型库的签名：没变就不再跑 mcode
// 进程起来前同步一次：现有的 claclaw- 供应商和模型库对不上就删了重加；模型库里没了的删掉。只碰 claclaw- 开头的
async function syncProviders(log) {
  const want = wanted(storeNow()), sig = wantSig(want);
  if (!mmBin()) return { env: {}, sig };
  if (syncedSig === sig) return { env: {}, sig };
  let cur = null;
  try { cur = JSON.parse(await mcode(['provider', 'list', '--json'], {}, log) || 'null'); } catch {}
  if (!cur?.providers) return { env: {}, sig };   // 命令跑不了（没装好）：不动
  const have = cur.providers.filter(x => x.kind === 'custom' && /^claclaw-/.test(x.name || ''));
  const same = (h, w) => h.baseUrl === w.base && h.apiFormat === w.format && (h.models || []).map(m => m.modelId).join(',') === w.models.join(',') && (!w.p.key || h.maskedApiKey === mask(w.p.key))
    && (!w.context || (h.models || []).every(m => m.contextLimit === w.context));
  let changed = false, ok = true;
  for (const h of have) {
    const w = want.find(x => x.name === h.name);
    if (w && same(h, w)) continue;
    if (await mcode(['provider', 'remove', h.providerId, '--yes'], {}, log) == null) ok = false;
    changed = true;
  }
  const noDefault = !cur.providers.some(x => x.active && x.kind !== 'custom' && (x.hasApiKey || x.kind === 'minimax-oauth' && x.models?.length));
  for (const w of want) {
    const h = have.find(x => x.name === w.name);
    if (h && same(h, w)) continue;
    const ek = envName(w.p.id), env = w.p.key ? { [ek]: w.p.key } : {};
    const args = ['provider', 'add', '--name', w.name, '--base-url', w.base, '--api-format', w.format, ...w.models.flatMap(m => ['--model', m]), ...(w.p.key ? ['--api-key-env', ek] : []),
      ...(w.context ? ['--context-limit', String(w.context), '--output-limit', String(Math.min(65536, w.context))] : []), ...(w.image ? ['--support-image'] : [])];
    // mcode 自己没登录、也没别的默认模型：第一家加完就选成默认（--use 会先试连一次；试不通就不带 --use 再加一次）
    let r = null;
    if (noDefault && w === want[0]) r = await mcode([...args, '--use'], env, log);
    if (r == null) r = await mcode(args, env, log);
    if (r != null) { changed = true; log?.('mcode provider added', w.name); } else ok = false;
  }
  if (changed) log?.('mcode providers synced', want.length);
  if (ok) syncedSig = sig;
  return { env: {}, sig };
}

// ---------- ACP 进程（底座见 acp.mjs） ----------
const agent = new AcpAgent({
  name: 'mcode', bin: mmBin, missing: '没找到 mcode 命令，先装好 MiniMax Code（npm i -g @minimax-ai/code）',
  command: bin => [bin, ['acp']],
  prepare: log => syncProviders(log),
  rpcError: e => /authenticat|mcode login/i.test(e.message || '') ? 'MiniMax Code 没有可用的模型：在 claclaw 的「模型管理」里加一个模型，或在电脑终端运行 mcode login' : '',
});
export const mmShutdown = () => agent.stop();
export function mmModelsChanged(log) { if (mmInstalled()) agent.modelsChanged(wantSig(wanted(storeNow())), log); }
export const mmAcpRunning = () => agent.running;

// ---------- 打开的 MiniMax 会话 ----------
export const mmRunners = new Map();

export class MmRunner extends AcpLoadRunner {
  static agent = agent; static prefix = MM_PREFIX; static runners = mmRunners;
  static label = 'MiniMax'; static group = 'MiniMax Code';
  static cfgIds = { model: 'model', mode: 'permissionMode' };
  static cfgNames = { model: '模型', mode: '权限' };

  sessionInfo() { return mmInfo(this.id); }
  cleanUser(text) { return stripTags(text); }
  afterReplay() { stampTimes(this.items, timesOf(this.sid)); }

  // 模型选项的 value 形如 m:<供应商>:<模型>:v:<变体>（供应商 custom_provider%3Aclaclaw-deepseek 是模型库写进去的）
  ownModel(o, store) {
    const v = String(o.value), m = v.match(/^m:([^:]*):([^:]*):v:(.*)$/);
    const prov = m ? decodeURIComponent(m[1]) : '', id = m ? m[2] : v;
    const pid = prov.match(/^custom_provider:claclaw-(.+)$/)?.[1];
    const sp = pid ? store.providers.find(p => p.id === pid) : null;
    return { value: v, label: String(o.name || id), id, base: sp ? (sp.endpoints.openai || sp.endpoints.anthropic) : '' };
  }
}

export const mmNewSession = (cwd, opts) => MmRunner.create(cwd, opts);

// 删除 = 归档：mcode 的会话在它自己的数据库里，claclaw 不直接改；起一个 `mcode app-server --stdio`，
// 用它的 DesktopService 接口（POST /minimax-desktop/api/v1/session/:id/archive，和 mcode 界面 /sessions 里的「归档」同一个）归档，
// 列表只列没归档的，所以就从 claclaw 里消失了；在 mcode 的 /sessions 里能恢复。
// 协议：initialize（protocolVersion 1、desktopService.transportProtocolVersion 2）→ initialized → desktopService/transport 通知里发 request 帧，
// 回来 response-start（status）/ stream-chunk（base64 的 JSON）/ stream-done 帧
function mmArchive(sid, { timeoutMs = 30000 } = {}) {
  const bin = mmBin();
  if (!bin) return Promise.reject(new Error('没找到 mcode'));
  return new Promise((resolve, reject) => {
    const as = binCall(bin, ['app-server', '--stdio', '--foreground']);
    const p = spawn(as.cmd, as.args, { env: binEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    let buf = '', status = 0, body = '', settled = false;
    const send = m => { if (!settled && p.stdin.writable) p.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n'); };
    const done = (err, v) => { if (settled) return; settled = true; clearTimeout(tm); try { p.kill(); } catch {} err ? reject(err) : resolve(v); };
    const tm = setTimeout(() => done(new Error('mcode 没有响应（30 秒）')), timeoutMs);
    p.on('error', e => done(e));
    // 进程已经退了还往 stdin 写 → EPIPE：没人监听会变成未捕获异常，把整个 claclaw 带崩
    p.stdin.on('error', e => done(new Error('mcode app-server 连接断了（' + (e.code || e.message) + '）')));
    p.stdout.on('error', () => {});
    p.on('exit', code => done(new Error('mcode app-server 退出了（' + code + '）')));
    p.stdout.on('data', d => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) {
          if (m.error) return done(new Error(m.error.message || 'mcode app-server 初始化失败'));
          send({ method: 'initialized', params: {} });
          send({ method: 'desktopService/transport', params: { frame: { type: 'request', id: 'archive', method: 'POST', url: '/minimax-desktop/api/v1/session/' + encodeURIComponent(sid) + '/archive', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ archived: true }) } } });
          continue;
        }
        const f = m.method === 'desktopService/transport' && m.params?.frame;
        if (!f || f.id !== 'archive') continue;
        if (f.type === 'response-start') status = f.status;
        else if (f.type === 'stream-chunk') body += f.payload?.encoding === 'base64' ? Buffer.from(f.payload.data || '', 'base64').toString() : String(f.payload?.data ?? f.payload ?? '');
        else if (f.type === 'stream-error') return done(new Error(f.message || f.code || '归档失败'));
        else if (f.type === 'stream-done') {
          let j = {}; try { j = JSON.parse(body); } catch {}
          if (status >= 200 && status < 300 && j.success !== false) return done(null, true);
          return done(new Error(j.message || j.error?.message || ('归档失败（' + status + '）')));
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: 1, clientInfo: { name: 'claclaw', version: '1' }, capabilities: { desktopService: { transportProtocolVersion: 2 } } } });
  });
}
export async function mmDelete(id) {
  if (!mmInfo(id)) throw notFound();
  await mmArchive(sidOf(id));
}
export const mmRename = localRename(mmInfo, mmRunners);
