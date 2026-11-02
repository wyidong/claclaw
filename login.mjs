// 各 Claw 的登录：它们的登录命令都是「打印一个网址（有的还带一次性代码）→ 等用户在浏览器里授权 → 命令自己收尾」，
// 网址在哪个设备上打开都行。claclaw 在电脑上用伪终端（script）起这个命令，把网址 / 代码推给手机，手机打开网址完成授权。
// - 一个 Claw 同一时间只跑一个登录；谁打开登录页都能看到同一份进度（login.update）
// - 要填 key 的（GLM Agent：glm-acp-agent --setup；iFlow：写 settings.json）：手机上先填 key，再喂给命令 / 写进文件
// - CodeBuddy 没有单独的登录命令，只能起它的终端界面：自动按掉「信任目录」、选「国内站」，拿到网址；登录成功它就进聊天界面，这时把它关掉
// - 推给手机的文字里把 sk- 开头的串打码（Claude 的 setup-token 这类会把令牌打出来）
// 登没登录（loggedIn）：按各家留在磁盘上的凭据文件判断，判断不了的返回 null
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HOME, findBin, binEnv, readJson } from './util.mjs';
import { DATA } from './auth.mjs';
import { storeNow, libModels } from './modelpick.mjs';

const stripAnsi = s => String(s).replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r/g, '');
const redact = s => String(s).replace(/sk-[A-Za-z0-9_-]{12,}/g, 'sk-…');
const exists = f => { try { return fs.existsSync(f); } catch { return false; } };
const anyFile = (d, skip) => { try { return fs.readdirSync(d, { withFileTypes: true }).some(e => e.isFile() ? !e.name.startsWith('.') && !(skip && skip.test(e.name)) : anyFile(path.join(d, e.name), skip)); } catch { return false; } };
const LOGIN_WS = path.join(DATA, 'login-ws');
const PTYWRAP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'ptywrap.py');   // 伪终端包装（见文件头）
const QD_DIRS = [path.join(HOME, '.qoder', 'entry')], MM_DIRS = [path.join(HOME, '.minimax-code', 'bin')];
const KM_DIRS = [process.env.KIMI_CODE_HOME && path.join(process.env.KIMI_CODE_HOME, 'bin'), path.join(HOME, '.kimi-code', 'bin')].filter(Boolean);   // 起终端界面型登录（CodeBuddy）用的空目录：它要先「信任目录」，别让它信任用户的目录

// qodercli status 要起一次 node（约 1 秒）：结果缓存 60 秒，登录成功后主动清掉
let qoderCache = { at: 0, ok: null };
function qoderLoggedIn() {
  if (Date.now() - qoderCache.at < 60000) return qoderCache.ok;
  const bin = findBin('qodercli', QD_DIRS);
  let ok = null;
  if (bin) { try { ok = !!JSON.parse(execFileSync(bin, ['status', '-o', 'json'], { encoding: 'utf8', timeout: 15000, env: binEnv(), stdio: ['ignore', 'pipe', 'ignore'] })).logged_in; } catch {} }
  qoderCache = { at: Date.now(), ok };
  return ok;
}
const iflowSettings = () => readJson(path.join(process.env.IFLOW_HOME || path.join(HOME, '.iflow'), 'settings.json'), {});

// 每个能登录的 Claw：label；cmd()：[程序, 参数]（程序找不到返回 null）；cwd；
// steps：看到什么就自动输什么（终端界面型）；keyPrompt：要先填 key（看到这个提示就把 key 喂进去）；paste：要用户粘贴授权码的提示；
// doneWhen(text)：进程不会自己退出的（CodeBuddy）怎么算成功；write(key)：不起命令、直接写文件的
// loggedIn()：true / false / null（判断不了）；libOk()：模型库能顶上、不登录也能用
const QD_BIN = () => findBin('qodercli', QD_DIRS);
export const SPECS = {
  qoder: {
    label: 'Qoder', cmd: () => { const b = QD_BIN(); return b && [b, ['login']]; },
    loggedIn: qoderLoggedIn, libOk: () => false,
    hint: '打开网址，用 Qoder 账号登录；授权后电脑上的命令会自己完成',
  },
  codebuddy: {
    label: 'CodeBuddy', cmd: () => { const b = findBin('codebuddy'); return b && [b, []]; }, cwd: LOGIN_WS,
    steps: [{ when: /Do you trust the files/i, send: '\r' }, { when: /Select login method/i, send: '\r' }],
    doneWhen: (text, s) => s.url && !/Waiting for auth|Select login method|Generating login URL/i.test(text) && /Shift \+ Enter|Tips for getting started|Recent activity/i.test(text),
    loggedIn: () => null, libOk: () => false,
    hint: '打开网址，用腾讯云 CodeBuddy 账号登录（国内站）；授权后电脑上的 CodeBuddy 会自己完成',
  },
  minimax: {
    label: 'MiniMax Code', cmd: () => { const b = findBin('mcode', MM_DIRS); return b && [b, ['login', '--no-browser']]; },
    // 登录状态在 auth/<env>/<区域>/<client>/auth-state.json 的 status 里（没登完是 authorizing）
    loggedIn: () => { const root = path.join(process.env.MINIMAX_DATA_DIR || path.join(HOME, '.minimax'), 'auth'); let ok = false; const walk = d => { let es = []; try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; } for (const e of es) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name === 'auth-state.json') { const st = String(readJson(path.join(d, e.name), {}).status || ''); if (st && !/authoriz(ing|e_pending)|unauth|signed_out|logged_out|expired|none|pending/i.test(st)) ok = true; } } }; walk(root); return ok; }, libOk: () => libModels(storeNow(), ['openai', 'anthropic']).length > 0,
    hint: '打开网址，登录 MiniMax 账号，把下面的一次性代码填进去',
  },
  kimi: {
    label: 'Kimi Code', cmd: () => { const b = findBin('kimi', KM_DIRS); return b && [b, ['login']]; },
    loggedIn: () => exists(path.join(process.env.KIMI_CODE_HOME || path.join(HOME, '.kimi-code'), 'credentials.json')), libOk: () => libModels(storeNow(), ['openai', 'anthropic']).length > 0,
    hint: '打开网址，登录 Kimi 账号，把下面的一次性代码填进去',
  },
  codex: {
    label: 'Codex', cmd: () => { const b = findBin('codex'); return b && [b, ['login', '--device-auth']]; },
    loggedIn: () => exists(path.join(process.env.CODEX_HOME || path.join(HOME, '.codex'), 'auth.json')), libOk: () => libModels(storeNow(), ['openai']).length > 0,
    hint: '打开网址，登录 ChatGPT 账号，把下面的一次性代码填进去',
  },
  glm: {
    label: 'GLM Agent', cmd: () => { const b = findBin('glm-acp-agent'); return b && [b, ['--setup']]; },
    keyPrompt: /Z_AI_API_KEY/i, keyLabel: 'Z.AI 的 API key（z.ai → API Keys）',
    loggedIn: () => !!process.env.Z_AI_API_KEY || exists(path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'glm-acp-agent', 'credentials.json')), libOk: () => libModels(storeNow(), ['openai']).length > 0,
    hint: '填入 Z.AI 的 API key，claclaw 替你存进 glm-acp-agent',
  },
  iflow: {
    label: 'iFlow CLI', keyLabel: '心流平台的 API key（platform.iflow.cn）',
    write: key => {
      const f = path.join(process.env.IFLOW_HOME || path.join(HOME, '.iflow'), 'settings.json');
      const s = readJson(f, {}); s.selectedAuthType = 'iflow'; s.apiKey = key;
      fs.mkdirSync(path.dirname(f), { recursive: true });
      const tmp = f + '.claclaw-' + process.pid; fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 }); fs.renameSync(tmp, f);
    },
    loggedIn: () => { const s = iflowSettings(); return !!(s.selectedAuthType && s.selectedAuthType !== 'openai-compatible' ? (s.apiKey || exists(path.join(process.env.IFLOW_HOME || path.join(HOME, '.iflow'), 'oauth_creds.json'))) : s.apiKey); },
    libOk: () => libModels(storeNow(), ['openai']).length > 0,
    hint: '填入心流平台的 API key，claclaw 写进 iFlow 的设置',
  },
};

// /api/claws 里每个 Claw 的登录情况：can（claclaw 能替它登）、key（要先填 key）、loggedIn、need（没登录、模型库也顶不上：用不了）、hint
export function loginInfo(claw) {
  const s = SPECS[claw];
  if (!s) return null;
  let loggedIn = null; try { loggedIn = s.loggedIn(); } catch {}
  const can = !!(s.write || s.cmd?.());
  return { can, key: !!(s.keyPrompt || s.write), keyLabel: s.keyLabel || '', loggedIn, need: loggedIn !== true && !s.libOk(), hint: s.hint, running: jobs.has(claw) };
}

// ---------- 正在进行的登录 ----------
const jobs = new Map();   // claw → job
const URL_RE = /https?:\/\/[^\s'"<>)\]]+/g;
const CODE_RE = /\b([A-Z0-9]{4,5}-[A-Z0-9]{4,5})\b/;
// 伪终端输出的最后两句（给手机看进度）：终端界面重画的几帧没有换行、会连成一行，所以除了换行还按转圈字符切开；网址单独给了，不要；重复的只留一句
export function tailOf(text) {
  // 转圈字符：✢…❋ 一段、盲文点阵一段；其它控制字符去掉
  const lines = String(text).replace(/[\x00-\x09\x0b\x0c\x0e-\x1f\x7f]/g, '').split(/[\r\n]|[\u2722-\u274b\u2800-\u28ff]/).map(x => x.trim()).filter(l => l && !/https?:\/\//.test(l) && !/^[·\s]+$/.test(l));
  const uniq = []; for (const l of lines.slice(-6).reverse()) if (!uniq.includes(l)) uniq.unshift(l);   // 去重留最后一次出现的位置
  return uniq.slice(-2).join(' · ').slice(0, 200);
}
const view = j => ({ t: 'login.update', claw: j.claw, label: j.label, status: j.status, url: j.url, code: j.code, prompt: j.prompt, tail: redact(j.tail), error: j.error ? redact(j.error) : '' });
function push(j) { const s = JSON.stringify(view(j)); for (const w of j.subs) if (w.readyState === 1) w.send(s); }

export function loginState(claw) { const j = jobs.get(claw); return j ? view(j) : null; }
export function loginWatch(claw, ws) { const j = jobs.get(claw); if (j) { j.subs.add(ws); push(j); return true; } return false; }

// 开始登录（已经在跑就接上看进度）。key：要先填 key 的 Claw 这里带上
export function loginStart(claw, ws, { key = '', log } = {}) {
  const s = SPECS[claw];
  if (!s) throw new Error('这个 Claw 不能在这里登录');
  let j = jobs.get(claw);
  if (j?.status === 'running') { j.subs.add(ws); push(j); return j; }   // 正在跑：接上看进度
  if (j) jobs.delete(claw);   // 上次的结果：清掉，重新来
  j = { claw, label: s.label, status: 'running', url: '', code: '', prompt: '', tail: '', error: '', text: '', subs: new Set([ws]), startedAt: Date.now(), done: new Set(), key, proc: null, timer: null };
  jobs.set(claw, j);
  if (s.write) {   // 直接写文件
    try { if (!key) throw new Error('要先填 key'); s.write(key); finish(j, true, log); } catch (e) { finish(j, false, log, e.message); }
    return j;
  }
  const c = s.cmd?.();
  if (!c) { finish(j, false, log, '没找到 ' + s.label + ' 的程序'); return j; }
  if (s.keyPrompt && !key) { finish(j, false, log, '要先填 key'); return j; }
  if (s.cwd) fs.mkdirSync(s.cwd, { recursive: true, mode: 0o700 });
  // 套上伪终端（这些命令在管道里不打网址或直接退出）；BROWSER 指向 true：别在电脑上开浏览器
  const p = spawn('python3', [PTYWRAP, c[0], ...c[1]], { cwd: s.cwd || HOME, env: { ...binEnv(), BROWSER: '/usr/bin/true', TERM: 'xterm-256color', NO_BROWSER: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  j.proc = p;
  log?.('login start', claw, c[0], c[1].join(' '));
  const onData = d => {
    const chunk = stripAnsi(d);
    j.text = (j.text + chunk).slice(-20000);
    // 网址：第一个不是文档 / 帮助页的；代码：XXXX-XXXX 形式的
    if (!j.url) { const urls = (j.text.match(URL_RE) || []).filter(u => !/docs\.|\/docs\b|vibex\.iflow|manage-apikey|github\.com|localhost|127\.0\.0\.1/i.test(u)); if (urls.length) j.url = urls[0].replace(/[.,;:!?]+$/, ''); }
    if (!j.code) { const m = j.text.match(CODE_RE); if (m) j.code = m[1]; }
    j.raw = tailOf(j.text);
    j.tail = (j.url || j.code) && !j.prompt ? '等你在网页上完成授权…' : j.raw;   // 网址 / 代码已经给出去了：命令那边刷的「Waiting for auth…」不用再看，给一句明白话
    // 要用户粘贴授权码的提示（Claude 那种）
    if (s.paste && !j.prompt && s.paste.test(j.text)) { j.prompt = s.pasteLabel || '把网页上给的授权码粘到这里'; }
    // 要 key 的：看到提示就把 key 喂进去（只一次）
    if (s.keyPrompt && j.key && !j.done.has('key') && s.keyPrompt.test(j.text)) { j.done.add('key'); p.stdin.write(j.key + '\n'); j.tail = '已填入 key，等它保存…'; }
    // 终端界面型：按步骤自动输入（每步只一次）
    for (const [i, st] of (s.steps || []).entries()) if (!j.done.has(i) && st.when.test(j.text)) { j.done.add(i); setTimeout(() => p.stdin.write(st.send), 400); }
    if (s.doneWhen && s.doneWhen(j.text.slice(-3000), j)) { if (!j.timer) j.timer = setTimeout(() => { if (s.doneWhen(j.text.slice(-3000), j)) finish(j, true, log); else j.timer = null; }, 2500); }
    push(j);
  };
  p.stdout.on('data', onData); p.stderr.on('data', onData);
  p.on('error', e => finish(j, false, log, s.label + ' 启动失败：' + e.message));
  p.on('exit', code => { if (j.status !== 'running') return; const ok = code === 0 && (s.doneWhen ? true : s.loggedIn() !== false); finish(j, ok, log, ok ? '' : '命令退出了（' + code + '）：' + (j.raw || j.tail)); });
  // 最多等 15 分钟
  setTimeout(() => { if (j.status === 'running') finish(j, false, log, '15 分钟没有完成，已停止'); }, 15 * 60 * 1000).unref?.();
  push(j);
  return j;
}
export function loginInput(claw, text) {
  const j = jobs.get(claw);
  if (!j?.proc || j.status !== 'running') throw new Error('没有正在进行的登录');
  j.proc.stdin.write(String(text).trim() + '\n');
  j.prompt = ''; j.tail = '已发送，等它确认…'; push(j);
}
export function loginCancel(claw, log) { const j = jobs.get(claw); if (j && j.status === 'running') finish(j, false, log, '已取消'); }
function finish(j, ok, log, error = '') {
  if (j.status !== 'running') return;
  j.status = ok ? 'ok' : 'fail'; j.error = ok ? '' : error; j.prompt = '';
  if (ok) { j.tail = '登录完成'; qoderCache.at = 0; }
  clearTimeout(j.timer);
  if (j.proc) { try { j.proc.stdin.end(); } catch {} setTimeout(() => { try { j.proc.kill(); } catch {} }, ok ? 800 : 0); }
  log?.('login', j.claw, ok ? 'ok' : 'fail', error.slice(0, 120));
  push(j);
  // 结果留 2 分钟给后来打开的页面看，然后清掉（下次再点就是重新登）
  setTimeout(() => { if (jobs.get(j.claw) === j) jobs.delete(j.claw); }, 2 * 60 * 1000).unref?.();
}
export function loginUnsubscribe(ws) { for (const j of jobs.values()) j.subs.delete(ws); }
