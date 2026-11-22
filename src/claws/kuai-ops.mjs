// kuAi 的只读操作（能力档 L3）：读文件（read）、在目录里搜内容（search）、取网页正文（fetch），外加按 token 截断的小工具。
// 路径碰不碰得由 agent 传进来的 bad(arg, wd) 判断（和简单命令同一套规矩：隐藏文件、~/Library、claclaw 的 data、像密钥的文件不碰）。
// 这里不调模型、不碰会话；kuai-agent.mjs 用。搜索另起一个子进程跑（kuai-search.mjs）：模型给的正则可能很慢，超时能直接杀掉，也不卡住 agent。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------- 按 token 截断 ----------
// token 估算：中文约 1 字 1 token，英文约 3.5 字符 1 token
export const tok = t => { let n = 0; for (const c of String(t)) n += c.charCodeAt(0) > 255 ? 1 : 0.29; return Math.ceil(n); };
// 估到 n 个 token 时的位置（没到就是 -1）
function cutAt(t, n) {
  let x = 0, i = 0;
  for (const c of t) { x += c.charCodeAt(0) > 255 ? 1 : 0.29; if (x > n) return i; i += c.length; }
  return -1;
}
// 截到大约 n 个 token：尽量断在行尾；截了就说还有多少没给
export function capTok(t, n, more = '') {
  t = String(t ?? '');
  const i = cutAt(t, Math.max(1, n));
  if (i < 0) return t;
  const nl = t.lastIndexOf('\n', i), at = nl > i * 0.7 ? nl : i;
  return t.slice(0, at) + '\n…（后面还有 ' + (t.length - at) + ' 字没给出' + (more ? '：' + more : '') + '）';
}

// ---------- 读文件 ----------
const READ_MAX = 8 * 1024 * 1024;   // 再大的不整个读进来
const LINE_MAX = 500;               // 一行最多给多少字
const PAGE_LINES = 400;             // 一次最多给多少行
export const isBinary = buf => buf.subarray(0, 8192).includes(0);
// 文本的编码：UTF-8（去掉 BOM）；不是合法的 UTF-8 就按 GB18030 试（老的中文文件）
export function decodeText(buf) {
  if (buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) buf = buf.subarray(3);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch {}
  try { return new TextDecoder('gb18030', { fatal: true }).decode(buf); } catch {}
  return new TextDecoder('utf-8').decode(buf);
}
// read 后面的参数 → { file, from, to }：read 文件 / read 文件 10-50 / read 文件 10 50 / read 文件:10-50
export function readArgs(a, exists = fs.existsSync) {
  let file = String(a[0] ?? ''), from = 0, to = 0;
  const r = /^(\d+)\s*[-–~,:]\s*(\d+)?$/.exec(String(a[1] ?? '')) || (/^\d+$/.test(a[1] ?? '') ? [0, a[1], /^\d+$/.test(a[2] ?? '') ? a[2] : ''] : null);
  if (r) { from = Number(r[1]); to = Number(r[2]) || 0; }
  else { const m = /^(.+?):(\d+)(?:-(\d+))?$/.exec(file); if (m && !exists(file)) { file = m[1]; from = Number(m[2]); to = Number(m[3]) || 0; } }
  return { file, from, to };
}
// 读一段：{ ok, text }。abs：已经查过能碰的绝对路径；show：给模型看的写法；cap：这次最多给多少 token
export function readFile({ abs, show, from = 0, to = 0, cap = 3000 }) {
  let st;
  const noPerm = e => e.code === 'EACCES' || e.code === 'EPERM';
  try { st = fs.statSync(abs); } catch (e) { return noPerm(e) ? { ok: false, perm: true, text: '读不了 ' + show + '：没有权限' } : { ok: false, text: '没有这个文件：' + show + '。名字拿不准就先用 ls 或 search 找一下。' }; }
  if (st.isDirectory()) return { ok: false, text: show + ' 是个目录，用 ls 看里面有什么。' };
  if (st.size > READ_MAX) return { ok: false, text: show + ' 太大了（' + (st.size / 1048576).toFixed(1) + ' MB），不整个读：用 search 找到要看的地方，或者用 head / tail 看头尾。' };
  let buf;
  try { buf = fs.readFileSync(abs); } catch (e) { return { ok: false, perm: noPerm(e), text: '读不了 ' + show + '：' + (noPerm(e) ? '没有权限' : e.message) }; }
  if (!buf.length) return { ok: true, text: show + ' 是空的。' };
  if (isBinary(buf)) return { ok: false, text: show + ' 不是文本文件（要知道是什么类型，用 file 命令看）。' };
  const lines = decodeText(buf).split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  const total = lines.length, a = Math.max(1, from || 1);
  if (a > total) return { ok: false, text: show + ' 一共只有 ' + total + ' 行，没有第 ' + a + ' 行。' };
  const want = Math.min(total, to >= a ? to : a + PAGE_LINES - 1, a + PAGE_LINES - 1);
  const out = []; let used = 0, b = a - 1;
  for (let i = a; i <= want; i++) {
    const l = lines[i - 1], row = i + '\t' + (l.length > LINE_MAX ? l.slice(0, LINE_MAX) + '…（这一行还有 ' + (l.length - LINE_MAX) + ' 字）' : l);
    const t = tok(row) + 1;
    if (out.length && used + t > cap) break;
    out.push(row); used += t; b = i;
  }
  const left = total - b;
  return { ok: true, text: show + '（第 ' + a + (b > a ? '–' + b : '') + ' 行，共 ' + total + ' 行）\n' + out.join('\n') + (left > 0 ? '\n（后面还有 ' + left + ' 行，要看就：read ' + quote(show) + ' ' + (b + 1) + '-' + Math.min(total, b + PAGE_LINES) + '）' : '') };
}
// 命令行里的一个参数：有空格、引号的加引号
export const quote = a => /^[\w./:@,=+~%-]+$/.test(a) ? a : JSON.stringify(a);

// ---------- 搜内容 ----------
// search 后面的参数 → { pattern, target, glob }：search "文字或正则" [目录或文件] [-g "*.js"]；别的选项（-i、-n、-r，写在哪都一样）不认也不报错。要找的东西以 - 开头时写 -e
export function searchArgs(a) {
  let pattern = null, target = '', glob = '';
  for (let i = 0; i < a.length; i++) {
    const x = String(a[i]);
    if (/^(-g|--glob|--include|--name)$/.test(x)) { glob = String(a[++i] ?? ''); continue; }
    const eq = /^(?:-g|--glob|--include|--name)=(.*)$/.exec(x); if (eq) { glob = eq[1]; continue; }
    if (x === '-e' && pattern == null) { pattern = String(a[++i] ?? ''); continue; }
    if (/^-{1,2}[A-Za-z][\w-]*$/.test(x)) continue;
    if (pattern == null) pattern = x; else if (!target) target = x;
  }
  return { pattern: pattern || '', target: target || '.', glob };
}
const SEARCH_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), 'kuai-search.mjs');
const SEARCH_MS = 20000;
// 在 root（目录或文件）里搜：{ ok, text }。show(abs) 把路径写成给模型看的样子；env：子进程的环境变量（不带 key）
// jail：{ home, keep }——home 下面只搜 keep 里的（会话开在小目录里时，主目录下别的个人文件不搜）
export function searchFiles({ pattern, root, glob = '', noGo = [], secret = '', jail = null, show = p => p, cap = 3000, signal, env = {}, ms = SEARCH_MS }) {
  return new Promise(res => {
    let out = '', err = '', done = false;
    const p = spawn(process.execPath, [SEARCH_JS, JSON.stringify({ pattern, root, glob, noGo, secret, jail })], { stdio: ['ignore', 'pipe', 'pipe'], env });
    const kill = () => { try { p.kill('SIGKILL'); } catch {} };
    const fin = text => { if (done) return; done = true; clearTimeout(to); signal?.removeEventListener?.('abort', kill); res(text); };
    const to = setTimeout(() => { kill(); fin({ ok: false, text: '搜了 ' + ms / 1000 + ' 秒还没搜完，停掉了：把范围缩小些（写具体的目录，或者用 -g 只搜某类文件）。' }); }, ms);
    signal?.addEventListener?.('abort', kill, { once: true });
    p.stdout.on('data', d => { if (out.length < 4e6) out += d; });
    p.stderr.on('data', d => { if (err.length < 2000) err += d; });
    p.on('error', e => fin({ ok: false, text: '搜不了：' + e.message }));
    p.on('close', () => {
      let j = null; try { j = JSON.parse(out); } catch {}
      if (!j) return fin({ ok: false, text: '搜不了' + (err.trim() ? '：' + err.trim().slice(0, 300) : '') });
      if (j.error) return fin({ ok: false, text: j.error });
      const scope = '搜了 ' + j.scanned + ' 个文件' + (j.note ? '，' + j.note : '');
      // 没找到：说清楚搜了多大的范围，好让模型换个找法（实测 Gemini 2.5 Flash 用 -g "*.py" 搜了个没有 py 文件的项目，搜了两次就下结论说没有）
      const pre = j.anyName ? '（这里没有名字符合 -g ' + quote(glob) + ' 的文件，改成不限文件名搜了）\n' : '';
      if (!j.hits.length) return fin({ ok: true, text: pre + (!j.scanned ? '没找到：这个范围里没有能搜的文本文件。先用 ls 看看里面有什么。'
        : '没找到（' + scope + '）。先别下结论：换个词（少写几个字、换成代码里可能用的写法），或者先用 ls 看看有哪些文件再搜。') });
      const rows = j.hits.map(h => show(h[0]) + ':' + h[1] + ': ' + h[2]);
      const body = capTok(rows.join('\n'), cap, '把范围缩小些');
      fin({ ok: true, text: pre + body + '\n（' + (j.more ? '只给出前 ' + j.hits.length + ' 处，还有更多：把范围缩小些；' : '共 ' + j.hits.length + ' 处，在 ' + j.files + ' 个文件里；') + scope + '）' });
    });
  });
}

// ---------- 取网页 ----------
// 本机和内网的地址不取：claclaw 自己、Ollama、路由器这些都在这些地址上，模型不该碰
export function ipPrivate(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (v === 6) {
    const x = ip.toLowerCase().replace(/%.*$/, '');
    const m4 = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/.exec(x); if (m4) return ipPrivate(m4[1]);
    const hx = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(x);
    if (hx) { const n = (parseInt(hx[1], 16) << 16 >>> 0) + parseInt(hx[2], 16); return ipPrivate([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.')); }
    return x === '::' || x === '::1' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || /^ff/.test(x);
  }
  return true;   // 不是 IP：当不能取
}
// 不用查域名就知道不能取的：写的就是本机 / 内网的地址，或者 localhost、路由器这类名字。'' = 看不出来
export function hostLocal(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const no = '是本机或内网的地址，不取';
  if (!h) return '网址里没有主机名';
  if (net.isIP(h)) return ipPrivate(h) ? h + ' ' + no : '';
  return h === 'localhost' || /\.(localhost|local|lan|internal|home|intranet|corp)$/.test(h) || !h.includes('.') ? h + ' ' + no : '';
}
// 这个主机名能不能取：'' 能；不能就是原因。域名解析出来有一个内网地址就不取；
// 解析不了的：走代理时（viaProxy，本机可能解析不了外面的域名）放行、由代理去连，不走代理就不取
// 注意：这里查一次、真正连的时候系统再查一次，两次之间域名可以换地址（DNS 重绑定），这一层挡不住
export async function hostSafe(hostname, lookup = dns.promises.lookup, viaProxy = false) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, ''), local = hostLocal(hostname);
  if (local || net.isIP(h)) return local;
  let list = [];
  try { list = await lookup(h, { all: true }); } catch { return viaProxy ? '' : h + ' 这个域名解析不出来，不取'; }
  return list.some(x => ipPrivate(x.address)) ? h + ' 是本机或内网的地址，不取' : '';
}
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ', middot: '·', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', bull: '•' };
const unent = t => t.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{1,10}\d{0,2});/gi, (m, k) => {
  if (k[0] === '#') { const n = k[1].toLowerCase() === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10); try { return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''; } catch { return ''; } }
  return ENT[k.toLowerCase()] ?? m;
});
// 下面几步都是用 indexOf 一遍扫过去，不用「<tag…>…</tag>」这类正则：
// 网页是别人给的，故意写上几十万个不收尾的 <script 会让那种正则慢到几分钟（期间整个 agent 卡住，停也停不了）
// 去掉 <tag …>…</tag> 整块；没有收尾的，从那里起都不要
function cutBlocks(h, tags) {
  for (const tag of tags) {
    const low = h.toLowerCase(), open = '<' + tag, close = '</' + tag;
    let out = '', pos = 0, i;
    while ((i = low.indexOf(open, pos)) >= 0) {
      const c = low[i + open.length];
      if (c && /[a-z0-9-]/.test(c)) { out += h.slice(pos, i + open.length); pos = i + open.length; continue; }   // <header> 不是 <head>
      out += h.slice(pos, i) + ' ';
      const j = low.indexOf(close, i + open.length), k = j < 0 ? -1 : low.indexOf('>', j);
      pos = k < 0 ? h.length : k + 1;
      if (j < 0) break;
    }
    h = out + h.slice(pos);
  }
  return h;
}
function cutComments(h) {
  let out = '', pos = 0, i;
  while ((i = h.indexOf('<!--', pos)) >= 0) { out += h.slice(pos, i); const j = h.indexOf('-->', i + 4); pos = j < 0 ? h.length : j + 3; if (j < 0) break; }
  return out + h.slice(pos);
}
function titleOf(h) {
  const low = h.slice(0, 200000).toLowerCase(), i = low.indexOf('<title'), a = i < 0 ? -1 : low.indexOf('>', i), b = a < 0 ? -1 : low.indexOf('</title', a);
  return b < 0 ? '' : h.slice(a + 1, Math.min(b, a + 1 + 600));
}
const BLOCK_END = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'aside', 'figure', 'figcaption', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'tr', 'table', 'blockquote', 'pre', 'dd', 'dt']);
// 标签 → 文字里的换行、列表记号；别的标签去掉
function tagsToText(h) {
  let out = '', pos = 0, i;
  while ((i = h.indexOf('<', pos)) >= 0) {
    out += h.slice(pos, i);
    const m = /^<(\/?)([a-zA-Z!?][a-zA-Z0-9]*)/.exec(h.slice(i, i + 32));   // ! ?：<!DOCTYPE>、<?xml ?>
    if (!m) { out += '<'; pos = i + 1; continue; }                 // 「a < b」里的小于号
    const k = h.indexOf('>', i + 1);
    if (k < 0) { pos = h.length; break; }                           // 标签没写完：后面的不要
    const name = m[2].toLowerCase(), end = !!m[1];
    out += !end && /^h[1-6]$/.test(name) ? '\n\n# ' : !end && name === 'li' ? '\n- ' : name === 'br' || name === 'hr' ? '\n' : end && BLOCK_END.has(name) ? '\n' : end && (name === 'td' || name === 'th') ? ' | ' : '';
    pos = k + 1;
  }
  return out + h.slice(pos);
}
// HTML → { title, text }：去掉脚本、样式、导航这些，留正文的文字；有 <article> / <main> 且够长就只取它
export function htmlText(html) {
  let h = cutComments(String(html || ''));
  const title = unent(tagsToText(titleOf(h))).replace(/\s+/g, ' ').trim().slice(0, 200);
  h = cutBlocks(h, ['script', 'style', 'noscript', 'svg', 'template', 'iframe', 'head', 'title', 'nav', 'footer', 'form', 'button', 'select']);
  const low = h.toLowerCase();
  const main = ['article', 'main'].map(t => { const i = low.indexOf('<' + t), j = low.lastIndexOf('</' + t); return i >= 0 && j > i && !/[a-z0-9-]/.test(low[i + t.length + 1] || '') ? h.slice(i, j) : ''; }).sort((a, b) => b.length - a.length)[0];
  const strip = x => unent(tagsToText(x)).replace(/[ \t\r\f\v\u00a0\u3000]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const all = strip(h), part = main ? strip(main) : '';
  return { title, text: part.length >= 400 && part.length >= all.length * 0.3 ? part : all };
}
// 网页的编码：响应头里的 > 网页里 meta 写的 > UTF-8
export function charsetOf(ct, buf) {
  const pick = s => /charset\s*=\s*["']?([\w-]+)/i.exec(String(s || ''))?.[1]?.toLowerCase() || '';
  return pick(ct) || pick(buf.subarray(0, 4096).toString('latin1')) || 'utf-8';
}
function decodeAs(buf, cs) { try { return new TextDecoder(cs).decode(buf); } catch { return new TextDecoder('utf-8').decode(buf); } }
const PAGE_MAX = 2 * 1024 * 1024, FETCH_MS = 20000, UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 claclaw-kuAi';
// 网址对不对：只取 http(s)，不带用户名密码
export function urlOf(v) {
  let u; try { u = new URL(String(v || '').trim()); } catch { return null; }
  return /^https?:$/.test(u.protocol) && !u.username && !u.password ? u : null;
}
// 取一个网页：{ ok, url（跳转后的）, status, title, text } | { ok: false, error }。
// 跳转自己跟（最多 5 次），每一跳都查主机；allowLocal：测试用（假的网页服务在 127.0.0.1）
export async function fetchPage(url, { signal, fetchImpl = fetch, lookup, allowLocal = false, viaProxy = false, ms = FETCH_MS } = {}) {
  let u = urlOf(url);
  if (!u) return { ok: false, error: '这不是能取的网址（只取 http / https 开头的）：' + String(url).slice(0, 200) };
  const timer = AbortSignal.timeout(ms), sig = signal ? AbortSignal.any([signal, timer]) : timer;
  try {
    for (let hop = 0; ; hop++) {
      if (!allowLocal) { const why = await hostSafe(u.hostname, lookup, viaProxy); if (why) return { ok: false, error: why + '。' }; }
      const r = await fetchImpl(u.href, { redirect: 'manual', signal: sig, headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5', 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' } });
      const loc = r.status >= 300 && r.status < 400 ? r.headers.get('location') : '';
      if (loc) {
        try { await r.body?.cancel(); } catch {}
        if (hop >= 5) return { ok: false, error: '跳转太多次，没取成。' };
        const next = urlOf(new URL(loc, u).href);
        if (!next) return { ok: false, error: '网页跳到了不能取的地址：' + String(loc).slice(0, 200) };
        u = next; continue;
      }
      const ct = String(r.headers.get('content-type') || '').toLowerCase(), kind = ct.split(';')[0].trim();
      const texty = !kind || /^text\/|json|xml|javascript|x-www-form-urlencoded/.test(kind);
      if (!texty) { try { await r.body?.cancel(); } catch {} return { ok: false, error: '这个网址给的不是文字（' + kind + '），看不了。' }; }
      const chunks = []; let n = 0, cut = false;
      if (r.body) for await (const c of r.body) { chunks.push(c); n += c.length; if (n >= PAGE_MAX) { cut = true; try { await r.body.cancel(); } catch {} break; } }
      const buf = Buffer.concat(chunks.map(c => Buffer.from(c))), raw = decodeAs(buf, charsetOf(ct, buf));
      const html = /html/.test(kind) || (!kind && /^\s*<(!doctype|html)/i.test(raw));
      const page = html ? htmlText(raw) : { title: '', text: raw.trim() };
      if (r.status >= 400) return { ok: false, url: u.href, status: r.status, error: '网页返回 ' + r.status + (page.title ? '（' + page.title.slice(0, 80) + '）' : '') + '。' };
      if (!page.text) return { ok: false, url: u.href, status: r.status, error: '网页取到了，但里面没有文字（多半是靠脚本显示内容的页面）。' };
      return { ok: true, url: u.href, status: r.status, title: page.title, text: page.text, cut };
    }
  } catch (e) {
    if (signal?.aborted) throw e;
    return { ok: false, error: timer.aborted ? '网页 ' + ms / 1000 + ' 秒没取下来，停掉了。' : '网页取不下来（' + (e.cause?.code || e.code || e.message) + '）。' };
  }
}
// 从第 from 个字起取大约 cap 个 token（尽量断在行尾）：{ text, next（下一截从哪个字起；到头了就是总字数）}
export function sliceTok(t, from, cap) {
  t = String(t || ''); from = Math.max(0, Math.min(Math.floor(from) || 0, t.length));
  const rest = t.slice(from), i = cutAt(rest, Math.max(50, cap));
  if (i < 0) return { text: rest, next: t.length };
  const nl = rest.lastIndexOf('\n', i), at = nl > i * 0.7 ? nl : i;
  return { text: rest.slice(0, at), next: from + at + (rest[at] === '\n' ? 1 : 0) };
}
