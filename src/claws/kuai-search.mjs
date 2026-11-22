#!/usr/bin/env node
// kuAi 的 search 在子进程里跑的那部分（kuai-ops.mjs 的 searchFiles 起它）：在一个目录或文件里逐行找，结果用一行 JSON 写到 stdout。
// 参数（argv[2]，JSON）：{ pattern, root, glob, noGo: [不能进的目录], secret: 像密钥的文件名的正则, jail: { home, keep }（home 下面只搜 keep 里的）}
// 不进隐藏的目录和文件、node_modules、链接；二进制和 2 MB 以上的文件不看；最多看 20000 个文件、给 60 处、搜 12 秒。
// 输出：{ hits: [[文件, 行号, 那一行]], files: 有几个文件命中, scanned: 看了几个文件, other: 名字不符合 -g 没看的, more: 还有没给出的, note, literal: 是按原文找的, anyName: -g 一个都没对上、改成不限文件名搜的 } | { error }
import fs from 'node:fs';
import path from 'node:path';

const MAX_HITS = 60, MAX_FILES = 20000, FILE_MAX = 2 * 1024 * 1024, LINE_SHOW = 200, LINE_TEST = 2000, MS = 12000;
const out = o => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
let a; try { a = JSON.parse(process.argv[2] || ''); } catch { out({ error: '搜索的参数不对' }); }
const fold = process.platform === 'darwin' || process.platform === 'win32' ? x => x.toLowerCase() : x => x;
const noGo = new Set((a.noGo || []).map(fold)), secret = a.secret ? new RegExp(a.secret, 'i') : null;
// jail：p 在 home 里、又不在 keep 里，也不是 keep 的上级目录（往 keep 走要经过它）→ 不进
const inside = (p, d) => { p = fold(p); d = fold(d); return p === d || p.startsWith(d + path.sep); };
const jailed = p => !!a.jail && inside(p, a.jail.home) && !inside(p, a.jail.keep) && !inside(a.jail.keep, p);
const fileJailed = p => !!a.jail && inside(p, a.jail.home) && !inside(p, a.jail.keep);   // 文件：在 home 里就必须在 keep 里
const pattern = String(a.pattern || '');
if (!pattern) out({ error: '没写要找什么：search "文字或正则" [目录或文件] [-g "*.js"]' });
// 正则写得不对就按原文找；全小写的不分大小写
const flags = /[A-Z]/.test(pattern) ? '' : 'i';
let re, literal = false;
try { re = new RegExp(pattern, flags); } catch { re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), flags); literal = true; }
// -g "*.js,*.ts"：按文件名筛（* ? 通配）
const globs = String(a.glob || '').split(',').map(s => s.trim()).filter(Boolean)
  .map(g => new RegExp('^' + g.replace(/^.*\//, '').replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*+/g, '.*').replace(/\?/g, '.') + '$', 'i'));
let anyName = false;   // -g 一个文件都没对上时，改成不限文件名再搜一遍
const nameOk = n => anyName || !globs.length || globs.some(g => g.test(n));

const hits = [], t0 = Date.now();
let scanned = 0, files = 0, other = 0, more = false, note = '';   // other：名字不符合 -g、没看的文件
function look(f) {
  let st; try { st = fs.statSync(f); } catch { return; }
  if (!st.isFile() || st.size > FILE_MAX || !st.size) return;
  let buf; try { buf = fs.readFileSync(f); } catch { return; }
  if (buf.subarray(0, 8192).includes(0)) return;
  scanned++;
  const lines = buf.toString('utf8').split('\n');
  let any = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].length > LINE_TEST ? lines[i].slice(0, LINE_TEST) : lines[i];
    if (!re.test(l)) continue;
    if (hits.length >= MAX_HITS) { more = true; return; }
    const t = l.trim();
    hits.push([f, i + 1, t.length > LINE_SHOW ? t.slice(0, LINE_SHOW) + '…' : t]); any = true;
  }
  if (any) files++;
}
const stop = () => more || scanned >= MAX_FILES || Date.now() - t0 > MS;
function walk(dir) {
  let list; try { list = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  list.sort((x, y) => x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  const dirs = [];
  for (const e of list) {
    if (stop()) return;
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { if (e.name !== 'node_modules' && !noGo.has(fold(p)) && !jailed(p)) dirs.push(p); }
    else if (e.isFile() && !(secret && secret.test(e.name)) && !fileJailed(p)) { if (nameOk(e.name)) look(p); else other++; }
  }
  for (const d of dirs) { if (stop()) return; walk(d); }   // 先看完这一层的文件，再往下走
}
let st; try { st = fs.statSync(a.root); } catch { out({ error: '没有这个目录或文件：' + a.root }); }
// 起点本身不让进的（agent 那边已经查过，这里再挡一道）
if ([...noGo].some(d => inside(a.root, d)) || (fileJailed(a.root) && !inside(a.jail.keep, a.root))) out({ error: '这个位置不能搜：' + a.root });
if (st.isDirectory()) walk(a.root); else look(a.root);
// -g 写的那类文件这里一个都没有（弱一些的模型会凭印象写 *.py）：不限文件名重搜一遍，并告诉它
if (st.isDirectory() && globs.length && !scanned && other) { anyName = true; other = 0; walk(a.root); }
if (scanned >= MAX_FILES) note = '文件太多，只搜了前 ' + MAX_FILES + ' 个'; else if (Date.now() - t0 > MS) note = '搜了 ' + MS / 1000 + ' 秒没搜完';
out({ hits, files, scanned, other, more, note, literal, anyName });
