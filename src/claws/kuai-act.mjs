// kuAi 动手档（L4）用的几样：改文件（整个写 / 换一段）、改动前后的对比、经 shell 跑命令。
// 这里只管「怎么做」；哪些路径能碰、要不要用户点确认，在 kuai-agent.mjs（runAct / runShell 的调用处）。
// 不依赖 claclaw 的别的模块。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const WRITE_MAX = 400000;            // 一次最多写多少字（模型一次也写不出这么多，防失控）
export const EDIT_MAX = 2 * 1024 * 1024;    // 多大的文件还给改 / 接着写

const countOf = (src, x) => { let n = 0, i = -1; while ((i = src.indexOf(x, i + 1)) >= 0) { n++; i += x.length - 1; } return n; };
const lineAt = (src, i) => src.slice(0, i).split('\n').length;

// 把 old 换成 neu：old 要和文件里一模一样，并且只出现一次（all = true 时全部换）。
// 文件是 CRLF 换行、模型写的是 LF：按 CRLF 再对一次，写回去也保持 CRLF。
// 对不上时尽量说清楚差在哪（多半是缩进、行尾空白），给出相似的那一行在第几行，让模型去 read 了照抄
export function editText(src, old, neu, all = false) {
  if (typeof old !== 'string' || !old) return { ok: false, why: 'old 是空的：写上要换掉的那段原文（和文件里一模一样）；要整个重写用 write' };
  if (typeof neu !== 'string') return { ok: false, why: '没写 new（要删掉那一段就写空字符串）' };
  if (old === neu) return { ok: false, why: 'old 和 new 一样，没有要改的' };
  let o = old, n = neu, c = countOf(src, o);
  if (!c && src.includes('\r\n') && !old.includes('\r\n')) { o = old.replace(/\n/g, '\r\n'); n = neu.replace(/\r?\n/g, '\r\n'); c = countOf(src, o); }
  if (!c) {
    const first = old.split('\n').map(x => x.trim()).find(x => x.length >= 4) || old.trim();
    const lines = src.split('\n'), k = first ? lines.findIndex(l => l.trim() === first) : -1, k2 = k < 0 && first ? lines.findIndex(l => l.includes(first)) : -1;
    const hit = k >= 0 ? k : k2;
    return { ok: false, why: 'old 在文件里对不上' + (hit >= 0 ? `：第 ${hit + 1} 行有相似的内容，多半是缩进、空白或者后面几行不一样。先 read 第 ${Math.max(1, hit - 2)}-${hit + Math.max(4, old.split('\n').length + 2)} 行，照文件里的原样写 old（不带行号）`
      : '：文件里没有这段。先 read 这个文件，照里面的原样写 old（不带行号）') };
  }
  if (c > 1 && !all) return { ok: false, why: `old 在文件里出现了 ${c} 次，不知道改哪一处：多带上前后几行，让它只对上一处；确实要全部替换就加 all: true` };
  const at = lineAt(src, src.indexOf(o));
  if (src.length + (all ? c : 1) * (n.length - o.length) > EDIT_MAX) return { ok: false, why: '改完以后文件会超过 ' + Math.round(EDIT_MAX / 1024) + ' KB，太大了，没有改' };
  return { ok: true, text: all ? src.split(o).join(n) : src.replace(o, () => n), count: all ? c : 1, at };
}

// 改动前后的对比（给用户在确认条上看，也给模型看一眼改成了什么样）：去掉头尾相同的行，只列中间变了的，前后各带 ctx 行。
// 不是完整的 diff 算法：中间隔着没变的行也会一起列出来（用户看得到全貌就行）。max：最多列多少行，width：一行最多多少字。
// cut：有没有没显示出来的（行太多、一行太长）——调用的地方要告诉用户「没显示全」，不能让人以为看到的就是全部
export const VIEW_MAX = 3600;   // 确认条上一段对比最多多少字（claclaw 那边 4000 字截断，要留在它里面）
const fit = (text, cut) => text.length > VIEW_MAX ? { text: text.slice(0, VIEW_MAX) + '\n…（后面还有 ' + (text.length - VIEW_MAX) + ' 字没显示）', cut: true } : { text, cut };
export function miniDiff(a, b, { ctx = 2, max = 60, width = 200 } = {}) {
  const A = a ? a.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [], B = b ? b.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : [];
  let p = 0; while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let q = 0; while (q < A.length - p && q < B.length - p && A[A.length - 1 - q] === B[B.length - 1 - q]) q++;
  const del = A.slice(p, A.length - q), add = B.slice(p, B.length - q);
  if (!del.length && !add.length) return { text: '（内容没有变化）', del: 0, add: 0, at: 0, cut: false };
  let part0 = false;
  const cut = l => { if (l.length <= width) return l; part0 = true; return l.slice(0, width) + '…（这一行还有 ' + (l.length - width) + ' 字）'; };
  const out = [];
  for (const l of A.slice(Math.max(0, p - ctx), p)) out.push('  ' + cut(l));
  const half = Math.max(4, Math.floor((max - 2 * ctx) / 2));
  const part = (list, sign) => { for (const l of list.slice(0, half)) out.push(sign + ' ' + cut(l)); if (list.length > half) { part0 = true; out.push(sign + ' …（还有 ' + (list.length - half) + ' 行）'); } };
  part(del, '-'); part(add, '+');
  for (const l of A.slice(A.length - q, A.length - q + ctx)) out.push('  ' + cut(l));
  return { ...fit('@@ 第 ' + (p + 1) + ' 行起 @@\n' + out.join('\n'), part0), del: del.length, add: add.length, at: p + 1 };
}
// 新文件的预览：开头 max 行。返回 { text, cut }
export function headOf(text, { max = 40, width = 200 } = {}) {
  const L = text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
  let part0 = L.length > max;
  const body = L.slice(0, max).map(l => { if (l.length <= width) return '+ ' + l; part0 = true; return '+ ' + l.slice(0, width) + '…（这一行还有 ' + (l.length - width) + ' 字）'; }).join('\n');
  return fit(body + (L.length > max ? '\n+ …（还有 ' + (L.length - max) + ' 行）' : ''), part0);
}
export const linesOf = t => !t ? 0 : t.replace(/\n$/, '').split('\n').length;

// 是不是合法的 UTF-8（不是的不给改：照 UTF-8 写回去会把原来的编码弄坏）
export function utf8Of(buf) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return null; }
}

// 写文件：先写到同目录的临时文件再改名（写到一半断电、被杀不会留下半个文件）；保留原来的权限位
export function writeAtomic(abs, text) {
  let mode = 0o644, had = false; try { mode = fs.statSync(abs).mode & 0o777; had = true; } catch {}
  if (had) fs.accessSync(abs, fs.constants.W_OK);   // 只读的文件：改名能把它换掉，但那不是用户的意思（抛 EACCES）
  const tmp = path.join(path.dirname(abs), '.' + path.basename(abs) + '.kuai-' + process.pid + '-' + Date.now().toString(36));
  try { fs.writeFileSync(tmp, text, { mode, flag: 'wx' }); fs.renameSync(tmp, abs); }
  catch (e) { try { fs.unlinkSync(tmp); } catch {} throw e; }
}

// ---------- 经 shell 跑命令 ----------
// macOS 上套一层 sandbox-exec。它挡的是「用户没看清就点了允许」之后的事：
// - 只有会话目录、临时目录、几个包管理器的缓存能写（write）；claclaw 自己的程序和技能脚本不能写（noWrite）——
//   不然改了技能脚本，下次调技能就是不经确认、不在沙箱里跑改过的代码；shell 的启动脚本、LaunchAgents 这些也一样写不了。
// - 主目录下隐藏的条目、~/Library 默认读不了（各家的登录状态、密钥、历史记录都在这些地方，一个个列不全），只放开列出来的（show：node、git 这些工具自己要读的）。
// - deny 里的读写都不行（claclaw 的数据等），哪怕它在上面放开的目录里。
// - 不能给沙箱外面的进程发信号（给 node 进程发 SIGUSR1 会打开调试口，连上去就能在那个进程里执行代码）；
//   不能让系统去起别的程序（open、AppleEvent——起来的程序不在沙箱里）；剪贴板不给碰；ssh-agent、tmux、编辑器留在临时目录里的 socket 不给连。
// 挡不住的（照实写，别当它挡得住）：别的进程启动时的环境变量（sysctl 读得到，规则管不了——所以密钥不要放环境变量）；本机 127.0.0.1 上的服务照样连得上；联网不拦。
// 规则是后写的盖过先写的。别的系统没有这一层，只靠调用处的检查和用户确认。
const sbStr = s => '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
const sbRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/"/g, '.');
const SOCKS = ['^/private/tmp/com\\.apple\\.launchd\\.', '^/private/tmp/tmux-', '/emacs[0-9]+/', '/vscode-[^/]*\\.sock$', '/\\.screen/', '/S\\.gpg-agent'];
// o：{ deny, write, noWrite, home, show }；只给数组就是 deny（只拦这几处，别的照常——测试用）
export function sbProfile(o = {}) {
  const { deny = [], write = null, noWrite = [], home = '', show = [] } = Array.isArray(o) ? { deny: o } : o;
  const sub = list => list.map(d => '(subpath ' + sbStr(d) + ')').join(' ');
  let p = '(version 1)(allow default)';
  if (write) p += '(deny file-write*)' + (write.length ? '(allow file-write* ' + sub(write) + ')' : '');
  if (home) {
    // 主目录下隐藏的、Library 里的：先整个拦掉，再放开 show 和 write 里落在这里面的（会话目录是主目录本身时不算「落在里面」，所以拦着的照样拦着）
    const lib = path.join(home, 'Library');
    const hid = x => { const r = path.relative(home, x); return !!r && !r.startsWith('..') && !path.isAbsolute(r) && (r.startsWith('.') || r.split(path.sep)[0] === 'Library'); };
    const w = (write || []).filter(hid), r = [...show.filter(hid), ...w];
    p += '(deny file-read* file-write* (regex #"^' + sbRe(home) + '/\\.") (subpath ' + sbStr(lib) + '))';
    // 目录本身（不含里面的）要能看：不然 realpath、getcwd 走到这一层就断了
    p += '(allow file-read-metadata (regex #"^' + sbRe(home) + '/\\.[^/]*$") (literal ' + sbStr(lib) + '))';
    if (r.length) p += '(allow file-read* ' + sub(r) + ')';
    if (w.length) p += '(allow file-write* ' + sub(w) + ')';
  }
  if (noWrite.length) p += '(deny file-write* ' + sub(noWrite) + ')';
  if (deny.length) p += '(deny file-read* file-write* ' + sub(deny) + ')';
  return p + '(deny file-read* file-write* network-outbound ' + SOCKS.map(x => '(regex #"' + x + '")').join(' ') + ')'
    + '(deny process-info* (target others))(deny signal)(allow signal (target same-sandbox))(deny lsopen)(deny appleevent-send)(deny mach-lookup (global-name "com.apple.pasteboard.1"))';
}
export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
export const hasSandbox = () => process.platform === 'darwin' && fs.existsSync(SANDBOX_EXEC);

// 跑一条命令：{ code, out, note }。超时、输出太多、停掉这一轮：连它起的子进程一起杀（另起进程组；它自己又另起了进程组的杀不到）。
// sandbox：true（只拦 deny 里的路径）或者 sbProfile 的那个对象；只在 macOS 有
const LATE_MAX = 1024 * 1024;   // 命令返回以后，它留在后台的进程还能往输出里写多少（超了就把管道关掉）
export function runShell(line, { cwd, env, signal, ms = 120000, maxOut = 100000, sandbox = false, deny = [], shell = '' } = {}) {
  return new Promise(res => {
    const win = process.platform === 'win32';
    let out = '', note = '', done = false, killed = false, late = 0, p;
    const sh = shell || (win ? '' : '/bin/sh');
    try {
      p = win && !sh ? spawn(line, { cwd, env, shell: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : sandbox ? spawn(SANDBOX_EXEC, ['-p', sbProfile(sandbox === true ? { deny } : sandbox), sh, '-c', line], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
        : spawn(sh, ['-c', line], { cwd, env, detached: !win, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) { res({ code: -1, out: e.message, note: '' }); return; }
    const kill = () => { killed = true; try { if (win) p.kill('SIGKILL'); else process.kill(-p.pid, 'SIGKILL'); } catch { try { p.kill('SIGKILL'); } catch {} } };
    // 不再读它的输出：还占着管道的进程（没杀到的、不停往外写的）再写就收到 SIGPIPE
    const shut = () => { try { p.stdout.destroy(); p.stderr.destroy(); } catch {} };
    const fin = code => { if (done) return; done = true; clearTimeout(to); signal?.removeEventListener?.('abort', kill); if (killed) shut(); res({ code, out, note }); };
    const to = setTimeout(() => { note = '超过 ' + Math.ceil(ms / 1000) + ' 秒，停掉了；它自己另外起的后台进程可能还留着'; kill(); }, ms);
    if (signal?.aborted) kill(); else signal?.addEventListener?.('abort', kill, { once: true });
    const take = d => {
      // 命令已经返回了：它留在后台的进程（用户要的服务这类）接着写的不要了；写得太多就关管道，不能让它把这个进程拖着空转
      if (done) { late += d.length; if (late > LATE_MAX) shut(); return; }
      if (out.length >= maxOut) return;
      out += d; if (out.length >= maxOut) { note = '输出太多，停掉了'; kill(); }
    };
    p.stdout.setEncoding('utf8'); p.stderr.setEncoding('utf8');
    p.stdout.on('data', take); p.stderr.on('data', take);
    p.stdout.on('error', () => {}); p.stderr.on('error', () => {});
    p.on('error', e => { out += e.message; fin(-1); });
    // 命令自己退了、但它放到后台的进程还占着输出管道：不等了（那些进程留着）
    p.on('exit', code => setTimeout(() => fin(code ?? -1), 300));
    p.on('close', code => fin(code ?? -1));
  });
}
