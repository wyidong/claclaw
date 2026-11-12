// 协同消息触发的那一轮：哪些工具调用可以直接放行，哪些要用户在手机上确认。
// 思路是「白名单」：认得出是安全的才放行，其余一律确认（危险命令的写法太多，黑名单拦不全）。
// 读文件也要管：这一轮的回复会传回对方，读到的钥匙、密码等于直接交出去。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

// 敏感位置：读、搜、写都要确认；它们的上级目录（整个家目录、整个工作区……）也要确认，免得一把搜进去
export function sensitiveRoots(dataDir) {
  return [
    '.ssh', '.aws', '.gnupg', '.claclaw', '.config/gh', '.netrc', '.git-credentials', '.npmrc', '.docker',
    '.kube', 'Library/Keychains', '.claude/.credentials.json', '.claude.json', '.config/opencode', '.openclaw',
  ].map(p => path.join(HOME, p)).concat(dataDir ? [path.resolve(dataDir)] : []);
}
const SENSITIVE_NAME = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|p12|pfx|key|keychain(-db)?)|[^/]*(credential|secret|token|passw|auth\.json|vapid)[^/]*|ssh_[^/]*|\.(bash_profile|bashrc|bash_login|profile|zshrc|zprofile|zshenv|zlogin|bash_history|zsh_history|python_history|node_repl_history|psql_history|mysql_history)|config\.fish)$/i;
// 上面最后两组：shell 启动文件（常在这里 export *_KEY）和命令历史（敲过的 key、密码会留在里面）

// Windows：path.resolve 给的是反斜杠路径，而上面的敏感名正则和下面的 inside() 都按 / 比，
// 不统一的话 ~\.ssh\id_rsa、proj\.env、data\peer.json 全都判不出敏感（反斜杠被 [^/]* 吃掉）。
// 统一成小写的 / 分隔再比（Windows 文件名不分大小写）；其他系统原样返回，行为不变 ——
// macOS 的文件名里可以有反斜杠，不能跟着转。
const WIN = process.platform === 'win32';
const norm = p => WIN ? String(p || '').replace(/\\/g, '/').toLowerCase() : String(p || '');
const NHOME = norm(HOME);
const isRoot = p => p === '/' || (WIN && /^[a-z]:\/?$/.test(p));
let USER = '';
try { USER = os.userInfo().username; } catch {}
// ~name/…：shell 会换成那个用户的家目录（zsh 还有 hash -d 起的目录名）。本机用户名 → HOME；
// 别的名字按「家目录的上级/名字」找，找不到就是认不出来（返回 null，调用方当成根目录：一律确认）
function tildeHome(name, cwd) {
  if (!name) return HOME;
  if (name === '+') return cwd || HOME;                       // ~+ = $PWD
  if (name === USER || name === path.basename(HOME)) return HOME;
  if (/^[\w.-]+$/.test(name) && name !== '.' && name !== '..') {
    const c = path.join(path.dirname(HOME), name);
    try { if (fs.statSync(c).isDirectory()) return c; } catch {}
  }
  return null;                                                // ~-（$OLDPWD）、~1（目录栈）、不认识的名字
}
const expand = (p, cwd) => {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return '';
  const m = (WIN ? /^~([^/\\]*)([/\\].*)?$/ : /^~([^/]*)(\/.*)?$/).exec(s);
  if (m) { const h = tildeHome(m[1], cwd); if (h == null) return '/'; s = h + (m[2] || ''); }
  else if (s.startsWith('$HOME')) s = HOME + s.slice(5);
  return norm(path.resolve(cwd || HOME, s));
};
const inside = (p, root) => { p = norm(p); root = norm(root); return p === root || p.startsWith(root.endsWith('/') ? root : root + '/'); };
// 本身就是敏感内容：敏感文件，或在敏感目录里（不含「只是它们的上级」）
// 源码文件名里带 passw / token / credential（passwd.mjs、token.test.js）多半是代码不是钥匙：
// 递归扫描、通配符展开出来的这类不算（不然在本仓库 rg、wc -l *.mjs 都要确认）；直接点名读仍要确认
const CODE_FILE = /\.(m?[jt]sx?|c[jt]s|py|go|rs|java|kt|swift|rb|php|c|cc|cpp|h|hpp|cs|vue|svelte|md)$/i;
const looseName = n => SENSITIVE_NAME.test(n) && CODE_FILE.test(n) && !/(^|\/)\.env/i.test(n) && !/secret|(^|\/)id_|\.(pem|key)\b/i.test(n);
const inSensitive = (a, roots) => SENSITIVE_NAME.test(a) || roots.some(r => inside(a, r));

// 这个路径碰不碰得到敏感内容：本身敏感、在敏感目录里、或者是敏感目录的上级
export function touchesSensitive(p, cwd, roots) {
  const a = expand(p, cwd);
  if (!a) return false;
  if (SENSITIVE_NAME.test(a)) return true;
  if (isRoot(a) || a === NHOME || inside(HOME, a)) return true;
  return roots.some(r => inside(a, r) || inside(r, a));
}

// ---- 通配符、递归搜索：先看清楚到底会碰到哪些文件 ----
// glob → 正则。* ? [..] 按 shell；Grep 工具的 glob 还有 ** 和 {a,b}。点开头的文件也算能匹配（宁可多问）
function globToRe(g) {
  let re = '', depth = 0;
  for (let i = 0; i < g.length; i++) {
    const ch = g[i];
    if (ch === '*') {
      if (g[i + 1] === '*') { i++; if (g[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*'; }
      else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '[') {
      const j = g.indexOf(']', i + 2);
      if (j < 0) { re += '\\['; continue; }
      let body = g.slice(i + 1, j), neg = false;
      if (body[0] === '!' || body[0] === '^') { neg = true; body = body.slice(1); }
      re += '[' + (neg ? '^' : '') + body.replace(/[\\\]\[^]/g, '\\$&') + ']';
      i = j;
    } else if (ch === '{') { depth++; re += '(?:'; }
    else if (ch === '}' && depth) { depth--; re += ')'; }
    else if (ch === ',' && depth) re += '|';
    else re += ch.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  }
  try { return new RegExp('^' + re + ')'.repeat(depth) + '$', WIN ? 'i' : ''); } catch { return /[\s\S]*/; }   // 认不出来：当成什么都匹配
}
const GLOB_CH = /[*?[]/;
// 通配符的路径（已展开成绝对路径）可能落进敏感目录、或是敏感目录 / 家目录的上级：~/.config/g?/hosts.yml、/Users/*
function globHitsRoot(abs, roots) {
  const ps = abs.replace(/\/+$/, '').split('/');
  for (const t of roots.map(norm).concat(NHOME)) {
    const ts = t.split('/'), n = Math.min(ps.length, ts.length);
    let ok = true, deep = false;
    for (let i = 0; i < n && ok; i++) {
      if (ps[i].includes('**')) { deep = true; break; }
      ok = globToRe(ps[i]).test(ts[i]);
    }
    if (!ok) continue;
    if (deep || t !== NHOME || ps.length <= ts.length) return true;
  }
  return false;
}
const SCAN_SKIP = new Set(['.git', 'node_modules']);
const SCAN_DEPTH = 8, SCAN_MAX = 10000, SCAN_FOUND = 200;
// 递归搜索前先看一遍目录里有没有敏感文件（.env、钥匙……）、敏感目录、指向敏感位置的软链接。
// 限深度、限数量：超了就当有（返回 limit），宁可多问。.git、node_modules 不进去（里面不放钥匙，进去就超限）
function scanSensitive(root, roots) {
  const found = [];
  let level = [root], n = 0;
  for (let d = 0; level.length; d++) {
    if (d > SCAN_DEPTH) return { limit: true };
    const next = [];
    for (const dir of level) {
      let ents;
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of ents) {
        if (++n > SCAN_MAX) return { limit: true };
        const p = dir + (dir.endsWith('/') || dir.endsWith('\\') ? '' : '/') + e.name;
        const rel = norm(path.relative(root, p)).split(path.sep).join('/');
        let hit = (SENSITIVE_NAME.test(e.name) && !looseName(e.name)) || roots.some(r => inside(p, r));
        if (!hit && e.isSymbolicLink()) {
          try { const t = fs.realpathSync(p); hit = touchesSensitive(t, root, roots); } catch {}
          if (hit) { found.push({ p, rel, file: false }); if (found.length >= SCAN_FOUND) return { limit: true }; }
          continue;
        }
        if (hit) { found.push({ p, rel, file: !e.isDirectory() }); if (found.length >= SCAN_FOUND) return { limit: true }; continue; }
        if (e.isDirectory() && !SCAN_SKIP.has(e.name)) next.push(p);
      }
    }
    level = next;
  }
  return { found };
}
// 递归搜索 target 会不会读到敏感文件。glob / type：Grep 工具只搜匹配的文件（敏感目录、软链接不按它们过滤）
function searchRisk(target, roots, glob = '', type = '') {
  try { if (!fs.statSync(target).isDirectory()) return null; } catch { return null; }
  const r = scanSensitive(target, roots);
  if (r.limit) return '目录太大，确认不了里面没有敏感文件：' + target;
  const gre = glob && !glob.startsWith('!') ? globToRe(glob) : null;
  const hit = r.found.find(f => !f.file || ((!gre || gre.test(glob.includes('/') ? f.rel : f.rel.split('/').pop()))
    && (!type || f.rel.split('/').pop().toLowerCase().includes(String(type).toLowerCase()))));
  return hit ? '搜索的目录里有敏感文件 ' + hit.p : null;
}
// 带通配符的参数：按 shell 的规矩在 dir 下展开，返回 { paths }（没匹配上就是空，shell 会把原样的字传下去）或要确认的原因
function globPaths(pat, dir, roots) {
  const abs = expand(pat, dir);
  if (globHitsRoot(abs, roots)) return '通配符可能匹配到敏感位置 ' + pat;
  const segs = abs.split('/');
  const i0 = segs.findIndex(x => GLOB_CH.test(x));
  if (i0 < 0) return { paths: [abs] };
  let base = segs.slice(0, i0).join('/') || '/';
  if (/^[a-z]:$/i.test(base)) base += '/';
  if (segs.slice(i0).some(x => x.includes('**'))) {   // zsh 的 ** 会递归：整棵树看一遍
    const r = searchRisk(base, roots);
    return r ? '通配符 ** ' + r : { paths: [] };
  }
  let cur = [base], n = 0;
  for (let i = i0; i < segs.length && cur.length; i++) {
    const s = segs[i];
    if (!s) continue;
    const next = [], join = c => c + (c.endsWith('/') ? '' : '/');
    if (!GLOB_CH.test(s)) { for (const c of cur) next.push(join(c) + s); }
    else {
      const re = globToRe(s);
      for (const c of cur) {
        let ents;
        try { ents = fs.readdirSync(c); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') continue; return '展不开通配符 ' + pat; }
        if ((n += ents.length) > SCAN_MAX) return '通配符匹配太多 ' + pat;
        for (const e of ents) if (re.test(WIN ? e.toLowerCase() : e)) next.push(join(c) + e);
      }
    }
    cur = next;
  }
  return { paths: cur.filter(p => { try { fs.lstatSync(p); return true; } catch { return false; } }) };
}

// 只看文件名、不读内容的命令：参数不按路径查
const NAME_ONLY = new Set(['echo', 'basename', 'dirname', 'true', 'pwd', 'uname', 'which']);
// 白名单命令里会写文件、执行程序、改系统的参数
function cmdOptRisk(c, args) {
  const short = (a, re) => /^-[^-]/.test(a) && re.test(a.slice(1));
  if (c === 'sort' && args.some(a => short(a, /o/) || /^--(output|compress-prog)/.test(a))) return 'sort 会写文件或执行程序';
  if (c === 'uniq' && args.filter(a => a === '-' || !/^-/.test(a)).length >= 2) return 'uniq 第二个文件参数是输出（会写文件）';
  if (c === 'tree' && args.some(a => short(a, /[oR]/) || /^--(output|o\b)/.test(a))) return 'tree 会写文件';
  if (c === 'rg' && args.some(a => /^--(pre|hostname-bin)/.test(a))) return 'rg 会执行程序';
  if (c === 'file' && args.some(a => short(a, /C/) || /^--compile/.test(a))) return 'file 会写文件';
  if (c === 'date') {
    // 只认显示：+格式、-u 这类开关、-d/-r/-v/-f 带的值；其余的位置参数（MMDDhhmm…）和 -s/--set 是改系统时间。
    // BSD 的 -j 表示不改时间
    const noSet = args.some(a => short(a, /j/));
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (/^--set/.test(a) || (short(a, /s/) && !/^-I/.test(a))) return 'date 改系统时间';
      if (/^-([drvfz]|-date|-reference|-file)$/.test(a)) { i++; continue; }
      if (!/^[-+]/.test(a) && !noSet) return 'date 改系统时间';
    }
  }
  return null;
}

const READ_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// 不碰文件、不联网、不执行的
const HARMLESS = new Set(['TodoWrite', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TaskGet', 'TaskOutput', 'ToolSearch', 'Skill', 'Agent', 'Task',
  'EnterPlanMode', 'ExitPlanMode', 'AskUserQuestion', 'mcp__claclaw__peer_sessions']);

// 只读命令：第一个词在这里才可能放行
const SAFE_CMDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'egrep', 'rg', 'find', 'stat', 'file', 'du', 'df',
  'which', 'echo', 'date', 'uname', 'tree', 'diff', 'sort', 'uniq', 'cut', 'tr', 'cd', 'true', 'basename', 'dirname', 'realpath', 'jq', 'sed', 'git']);
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'tag', 'blame', 'ls-files', 'shortlog', 'describe', 'pull', 'fetch', 'remote', 'grep', 'ls-tree', 'cat-file']);
const SEARCH_CMDS = new Set(['grep', 'egrep', 'rg', 'find', 'du', 'tree', 'ls']);
// 展开了也无害的环境变量；其余的（*_KEY、*_TOKEN……）在协同那一轮里展开，回复传回对方就等于把值交出去
const SAFE_VARS = new Set(['HOME', 'USER', 'LOGNAME', 'PWD', 'OLDPWD', 'SHELL', 'TMPDIR', 'LANG', 'TERM', 'PATH', 'HOSTNAME']);
// 常规维护：在 claclaw 仓库（或它的 .worktrees/ 里）跑自检、测试、空闲后重启。
// 跑的是仓库里提交过的代码——和「拉代码 + 重启」本来就会跑的一样，用户认可这是常规操作，不用每次确认。
// 参数要一字不差，多带一个都不算；仓库里有没提交的改动（可能是这一轮刚改的）就照样确认，免得「先改代码再跑测试」绕过去。
const ROUTINE_NPM = new Set(['test', 't', 'run check', 'run test', 'run restart']);
// 例外：npm run restart -- <备注>。备注只写进重启日志（tools/restart-when-idle.mjs 不解析它），只许字母数字、中文和 . _ - : / # @ +，
// 不许 - 开头（不像选项）
const NOTE_WORD = /^[\p{L}\p{N}._:/#@+][\p{L}\p{N}._\-:/#@+]*$/u;
const routineNpm = a => ROUTINE_NPM.has(a.join(' '))
  || (a.length > 3 && a[0] === 'run' && a[1] === 'restart' && a[2] === '--' && a.slice(3).every(w => NOTE_WORD.test(w)));
// git merge --ff-only origin/<分支>：只快进，不会丢本地提交；只认 origin 上的分支（别处的代码会被后面的测试 / 重启执行）
const ffFromOrigin = a => a.includes('--ff-only') && a.every(x => /^(-q|--quiet|--ff-only)$/.test(x) || /^origin\/\w[\w./-]*$/.test(x) && !x.includes('..'))
  && a.filter(x => !/^-/.test(x)).length === 1;
// dir 可能已经过 expand() 归一化（cd 之后），repos 是调用方给的原始路径：两边都归一再比
const inRepo = (dir, repos) => repos.some(r => norm(dir) === norm(r) || inside(dir, path.join(r, '.worktrees')));

// 粗分词：引号里的空格不拆，反斜杠转义下一个字符（和 shell 一样）。分错只会多问，不会少问（每一段都要单独过检查）
const words = seg => lex(seg).map(x => x.v);
// 同上，每个词另外带 g：引号外出现过的 * ? [ { ( ) —— shell 会拿它们展开通配符 / 花括号（zsh 的 *(e:…:) 还会执行命令）
function lex(seg) {
  const out = []; let cur = '', q = '', g = '';
  const push = () => { out.push({ v: cur, g }); cur = ''; g = ''; };
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q === "'") { if (ch === q) q = ''; else cur += ch; continue; }
    // Windows：命令里常是 D:\Users\… 这种路径，反斜杠是分隔符不是转义符。照 shell 吃掉它，
    // ~\.ssh\id_rsa 会变成 .sshid_rsa，敏感判断整个失效 —— 那是「少问」，正好和上面的原则相反。
    // 所以引号外、下一个字符不是 shell 元字符时，反斜杠按字面留着（留着只会多问）。
    if (ch === '\\' && i + 1 < seg.length && !q && WIN && /[^\s"'$`\\]/.test(seg[i + 1])) { cur += ch; continue; }
    if (ch === '\\' && i + 1 < seg.length && (!q || /["\\$`]/.test(seg[i + 1]))) { cur += seg[++i]; continue; }
    if (q) { if (ch === q) q = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) push(); continue; }
    if (/[*?[{}()]/.test(ch)) g += ch;
    cur += ch;
  }
  if (cur) push();
  return out;
}

// 引号里、反斜杠后面的字符换成占位符（长度不变）：| ; & > 只有在这之外才是分隔符 / 重定向。
// 按 shell 的规矩：单引号里没有转义；双引号里 \" \\ 是转义、不结束引号；引号外 \x 就是字面的 x。
// keepDq：双引号里的内容原样保留（$变量 在双引号里照样展开，查变量时要看得见）
function unquoted(s, keepDq = false) {
  let out = '', q = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q === "'") { if (ch === "'") { q = ''; out += ch; } else out += '_'; continue; }
    if (ch === '\\' && i + 1 < s.length) { out += '__'; i++; continue; }
    if (q === '"') { if (ch === '"') { q = ''; out += ch; } else out += keepDq ? ch : '_'; continue; }
    if (ch === '"' || ch === "'") q = ch;
    out += ch;
  }
  return out;
}
// 按 && || ; | & 换行切成一段段命令（引号里的不算）
export function segments(cmd) {
  const s = String(cmd || ''), out = [];
  let last = 0;
  for (const m of unquoted(s).matchAll(/&&|\|\||[;|&\n]/g)) { out.push(s.slice(last, m.index)); last = m.index + m[0].length; }
  out.push(s.slice(last));
  return out.map(x => x.trim()).filter(Boolean);
}

// 返回 null = 安全；否则返回要确认的原因。repos：可以跑常规维护的仓库目录
export function bashRisk(cmd, cwd, roots, { repos = [], clean = () => false } = {}) {
  let s = String(cmd || '');
  if (/\$\(|`|<\(|>\(|\$\{/.test(s)) return '命令里有嵌套执行';
  // $'…' 里的 \' 不结束引号，切分会和 shell 对不上，一律确认；只看引号外的（grep 'abc$' 里的 $' 是字面字符）
  if (/\$'/.test(unquoted(s))) return "命令里有 $'…' 转义串";
  for (const m of unquoted(s, true).matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) if (!SAFE_VARS.has(m[1])) return '读取环境变量 $' + m[1];
  s = s.replace(/\s\d?>\s*\/dev\/null/g, ' ').replace(/\s2>&1/g, ' ');
  // 输出写到 /tmp 下的一个文件（npm test >/tmp/t.log 这类临时日志）：不算写用户的文件。只认 /tmp 下一层、文件名只有字母数字 . _ -
  s = s.replace(/(^|\s)\d?>>?\s*\/tmp\/[\w.-]+(?=$|[\s;&|])/g, '$1');
  if (/>/.test(unquoted(s))) return '命令会写文件';
  // < 读文件：cat <~/.config/gh/hosts.yml。把 < 换成空格，后面的文件名成了单独的词，照样按路径查
  { const u = unquoted(s); if (u.includes('<')) { let t = ''; for (let i = 0; i < s.length; i++) t += u[i] === '<' ? ' ' : s[i]; s = t; } }
  const segs = segments(s);
  if (!segs.length) return '空命令';
  let dir = cwd;
  for (const seg of segs) {
    const lx = lex(seg);
    const w = lx.map(x => x.v);
    const c = w[0];
    const args = w.slice(1);
    if (lx.some(x => /[{}]/.test(x.g))) return '命令里有花括号展开';            // .{e,x}nv → .env
    if (lx.some(x => /[()]/.test(x.g))) return '命令里有括号（zsh 的通配符限定词能执行命令）';
    if (c === 'npm' && inRepo(dir, repos) && routineNpm(args.filter(a => !/^(-s|--silent|-q|--quiet)$/.test(a)))) {
      if (!clean(dir)) return '仓库里有没提交的改动，npm 会执行它们';
      continue;
    }
    if (!SAFE_CMDS.has(c)) return '运行 ' + c;
    if (c === 'jq' && args.some(a => /\$ENV|\benv\b/.test(a))) return 'jq 读取环境变量';
    if (c === 'git') {
      const sub = args[0];
      if (sub === 'merge' && ffFromOrigin(args.slice(1))) continue;   // 版本更新：只快进到 origin 上的分支，和 pull --ff-only 一样
      if (!SAFE_GIT.has(sub)) return 'git ' + (sub || '');
      if (args.some(a => /^--(output|exec|upload-pack|receive-pack|ext-diff)/.test(a) || /^-[cC]$/.test(a))) return 'git 带了会执行或写文件的参数';
      if (args.includes('--no-index')) return 'git ' + sub + ' --no-index 读仓库外的文件';
      if ((sub === 'show' || sub === 'cat-file') && args.slice(1).some(a => { const i = a.indexOf(':'); return i >= 0 && SENSITIVE_NAME.test(a.slice(i + 1)); })) return '读敏感位置（git 里提交过的 ' + sub + '）';   // HEAD:.env 这类
      if (args.slice(1).some(a => !/^-/.test(a) && SENSITIVE_NAME.test(a))) return '读敏感文件（git ' + sub + '）';   // git log -p .env、git diff .env、git blame .env
      if (sub === 'grep' && args.some(a => /^(-O|--open-files-in-pager)/.test(a))) return 'git grep 用分页程序打开文件';   // -O<程序> 会执行命令
      if ((sub === 'branch' || sub === 'tag') && args.slice(1).some(a => /^-/.test(a) && !/^-(a|v|vv|r|l|-list|-all|-verbose|-show-current|-contains)$/.test(a))) return 'git ' + sub + ' 改动';
      if (sub === 'remote' && args.slice(1).some(a => /^(add|remove|rm|rename|set-url|set-head|prune)$/.test(a))) return 'git remote 改动';
      // pull / fetch 只认 origin：别处（网址、本地路径）拉来的代码会被后面的测试 / 重启执行
      if (sub === 'pull' || sub === 'fetch') {
        const pos = args.slice(1).filter(a => !/^-/.test(a));
        if (pos.length && (pos[0] !== 'origin' || pos.slice(1).some(a => !/^[\w][\w./-]*$/.test(a) || a.includes('..')))) return 'git ' + sub + ' 不是从 origin';
        if (args.slice(1).some(a => /^--(repo|upload-pack|config)/.test(a))) return 'git ' + sub + ' 带了改来源的参数';
      }
      continue;
    }
    if (c === 'find' && args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) return 'find 会执行或删除';
    if (c === 'sed') {
      const script = args.find(a => !/^-/.test(a));
      if (!(args.includes('-n') && script && /^\d+(,\d+)?p$/.test(script))) return 'sed 可能改文件';
    }
    // 进项目目录不算碰敏感（项目里有 data/ 也一样）：之后每一段照样按新目录检查，递归搜索仍要确认。
    // 家目录、根目录及其上级、敏感目录本身还是要确认
    if (c === 'cd') {
      if (lx[1] && GLOB_CH.test(lx[1].g)) return '进入的目录带通配符';
      dir = expand(args[0] || '~', dir);
      if (isRoot(dir) || dir === NHOME || inside(HOME, dir) || inSensitive(dir, roots)) return '进入敏感目录';
      continue;
    }
    const optRisk = cmdOptRisk(c, args);
    if (optRisk) return optRisk;
    if (NAME_ONLY.has(c)) continue;
    const paths = args.filter(a => !/^-/.test(a));
    // 要按路径查的：所有不是选项的参数、--opt=值 的值；带通配符的先在当前目录下展开（.e* → .env）
    const cands = [];
    for (const x of lx.slice(1)) {
      let v = x.v;
      if (/^-/.test(v)) { const m = /^--[\w-]+=(.+)$/.exec(v); if (!m) continue; v = m[1]; }
      if (GLOB_CH.test(x.g) && GLOB_CH.test(v)) {
        const r = globPaths(v, dir, roots);
        if (typeof r === 'string') return r;
        cands.push(...r.paths.filter(a => !looseName(path.basename(a))));
        if (r.paths.length) continue;
      }
      cands.push(v);
    }
    for (const a of cands) if (touchesSensitive(a, dir, roots)) return '读敏感位置 ' + a;
    for (const a of paths) if (SENSITIVE_NAME.test(a)) return '读敏感文件 ' + a;
    const recursive = args.some(a => /^-[a-zA-Z]*[rR]/.test(a) || /^--(recursive|dereference-recursive|directories=recurse)$/.test(a)
      || /^-d\s*recurse$/.test(a)) || / -d recurse( |$)/.test(' ' + args.join(' ') + ' ');
    // 递归搜索没写路径：搜的是当前目录
    if (SEARCH_CMDS.has(c) && (c === 'rg' || c === 'find' || c === 'du' || c === 'tree' || recursive)
      && !paths.some(a => /[/\\~.]/.test(a)) && touchesSensitive(dir, cwd, roots)) return '在含敏感内容的目录里搜索';
    // 递归读内容（grep -r、rg 默认递归）：搜的目录里有 .env 这类文件也要确认。
    // 参数里有存在的路径就看其中的目录；一个都不存在（只有搜索词）就是搜当前目录
    if (c === 'rg' || ((c === 'grep' || c === 'egrep') && recursive)) {
      const abs = cands.map(a => expand(a, dir)).filter(a => { try { fs.statSync(a); return true; } catch { return false; } });
      const targets = abs.length ? abs : [expand(dir, cwd)];
      for (const t of new Set(targets)) { const r = searchRisk(t, roots); if (r) return r; }
    }
  }
  return null;
}

// 这一步是不是来信直接点名要做的：来信里出现了这条命令的程序 / 子命令、脚本或文件名、网址的域名。
// 用户的规矩：消息来自协同通道，但做什么是我们自己定的，就不用确认；只有对方点名要做的才问。
// 读敏感内容不走这条（回复会传回对方，读到的钥匙等于交出去），调用方自己判断。
export function peerInstructed(name, input, text) {
  const t = String(text || '').toLowerCase();
  if (!t) return false;
  const has = x => { x = String(x || '').toLowerCase(); return x.length >= 3 && t.includes(x); };
  const base = x => String(x || '').replace(/\/+$/, '').split('/').pop();
  input = input || {};
  if (name === 'Bash') {
    const segs = segments(input.command);
    for (const seg of segs) {
      if (has(seg.replace(/\s+/g, ' '))) return true;                      // 整段命令原样出现在来信里
      const w = words(seg).filter(a => !/^-/.test(a));
      if (!w.length) continue;
      if (w.length > 1 && has(base(w[0]) + ' ' + w[1])) return true;      // git push、npm publish 这类「程序 + 子命令」
      if (base(w[0]).length >= 5 && has(base(w[0]))) return true;       // 程序名本身够特别（preprodwebpull.sh、rsync…）
      for (const a of w) if (/[/~]/.test(a) || /\.\w{1,5}$/.test(a)) { const b = base(a); if (b.length >= 4 && has(b)) return true; }   // 脚本、文件名
    }
    return false;
  }
  if (input.file_path || input.notebook_path) return has(base(input.file_path || input.notebook_path));
  if (input.url) { try { return has(new URL(input.url).hostname); } catch { return false; } }
  if (input.query) return true;
  return true;   // 认不出来的工具：按对方点名算，照样问
}

// 删除、覆盖、重置、强推、杀进程、发布这类做了收不回来的：不管是谁的主意都要确认
const DESTRUCTIVE_CMDS = new Set(['rm', 'rmdir', 'unlink', 'shred', 'dd', 'mkfs', 'kill', 'killall', 'pkill', 'sudo', 'su', 'chmod', 'chown',
  'launchctl', 'shutdown', 'reboot', 'halt', 'truncate', 'trash', 'srm', 'diskutil', 'crontab', 'systemctl', 'service']);
const DESTRUCTIVE_GIT = new Set(['push', 'reset', 'clean', 'rebase', 'checkout', 'restore', 'switch', 'filter-branch', 'filter-repo', 'gc', 'prune', 'update-ref', 'rm', 'mv', 'stash', 'branch', 'tag', 'commit', 'merge', 'cherry-pick', 'revert', 'am', 'apply']);
const DESTRUCTIVE_WORDS = /\b(drop|delete|truncate|flushall|flushdb|destroy|purge|prune|wipe|--force|-f\b|--hard|publish|deploy|terminate|rmi)\b/i;
export function destructive(name, input) {
  if (name !== 'Bash') return false;
  const segs = segments((input || {}).command);
  for (const seg of segs) {
    const w = words(seg), c = String(w[0] || '').split('/').pop();
    if (DESTRUCTIVE_CMDS.has(c)) return true;
    if (c === 'mv' || c === 'cp' && w.includes('-f')) return true;
    if (c === 'find' && w.some(a => /^-(delete|exec|execdir)$/.test(a))) return true;
    if (c === 'git' && DESTRUCTIVE_GIT.has(w.find((a, i) => i > 0 && !/^-/.test(a)))) return true;
    if (DESTRUCTIVE_WORDS.test(seg)) return true;
  }
  return false;
}
// 来信里有要动手的意思（删、清、重置、部署、推送、重启……）：这一轮有风险的操作都确认，不管来信写没写具体命令
const INTENT_WORDS = /删|清空|清理|清掉|移除|去掉.{0,4}(目录|文件|库|表|数据)|销毁|丢弃|重置|覆盖|回滚|还原|强推|推送|推上去|部署|上线|发布|重启|停掉|停止服务|杀掉|关掉进程|格式化|改权限|drop|delete|remove|truncate|reset|deploy|publish|release|kill|restart|force|wipe|purge|rm\s/i;
export function peerIntent(text) { return INTENT_WORDS.test(String(text || '')); }

// 读环境变量：Claude 进程的环境里有 CLAUDE_CODE_OAUTH_TOKEN（长期令牌）等钥匙，回复会传回对方，
// 按「读敏感内容」算——一律确认，不交给小模型审查（对方点名要 printenv 也一样）
const ENV_CMDS = new Set(['env', 'printenv', 'set', 'export', 'declare', 'typeset', 'compgen', 'launchctl']);
export function readsEnv(cmd) {
  const s = String(cmd || '');
  if (/process\.env|os\.environ|getenv|\/environ\b|\$ENV\b|\bENV\[|CLAUDE_CODE_OAUTH_TOKEN/.test(s)) return true;
  for (const m of unquoted(s, true).matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) if (!SAFE_VARS.has(m[1])) return true;
  for (const seg of segments(s)) {
    const w = words(seg), c = String(w[0] || '').split('/').pop(), args = w.slice(1);
    if (ENV_CMDS.has(c) && (c !== 'launchctl' || args[0] === 'getenv')) return true;
    if (c === 'ps' && (args.some(a => /^-[a-zA-Z]*E/.test(a)) || /^[a-zA-Z]*e[a-zA-Z]*$/.test(args[0] || ''))) return true;   // ps -E / ps eww 带出别的进程的环境
    if (c === 'jq' && args.some(a => /\benv\b/.test(a))) return true;
  }
  return false;
}

// 工具调用的风险：null = 直接放行；否则返回 { key（「本轮同类都允许」按它记）, reason }
export function peerRisk(name, input, cwd, roots, opts) {
  input = input || {};
  if (HARMLESS.has(name)) return null;
  if (READ_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path || input.path || cwd;
    if (touchesSensitive(p, cwd, roots)) return { key: 'read-sensitive', reason: '读敏感位置：' + expand(p, cwd) };
    if (name === 'Grep') {
      // glob / type 本身点名了敏感文件（.env、*.pem……），或者要搜的目录里有敏感文件（按 glob / type 过滤后）
      const g = String(input.glob || ''), t = String(input.type || '');
      if (g && !g.startsWith('!') && SENSITIVE_NAME.test(g.replace(/^(\*\*\/)+/, ''))) return { key: 'read-sensitive', reason: '搜敏感文件：' + g };
      if (t && (SENSITIVE_NAME.test(t) || SENSITIVE_NAME.test('x.' + t))) return { key: 'read-sensitive', reason: '搜敏感文件类型：' + t };
      const r = searchRisk(expand(p, cwd), roots, g, t);
      if (r) return { key: 'read-sensitive', reason: r };
    }
    return null;
  }
  if (EDIT_TOOLS.has(name)) {
    const p = expand(input.file_path || input.notebook_path, cwd);
    if (!p) return { key: 'edit-out', reason: '改文件' };
    if (!inside(p, path.resolve(cwd))) return { key: 'edit-out', reason: '改项目目录外的文件：' + p };
    if (touchesSensitive(p, cwd, roots) || /\/(\.git|\.claude|node_modules)\//.test(p)) return { key: 'edit-sensitive', reason: '改敏感文件：' + p };
    return null;
  }
  if (name === 'Bash') {
    if (readsEnv(input.command)) return { key: 'read-sensitive', reason: '读取环境变量（里面有登录令牌等钥匙）' };
    const r = bashRisk(input.command, cwd, roots, opts);
    if (!r) return null;
    const first = words(String(input.command || '').trim())[0] || '';
    return { key: 'bash:' + first, reason: r };
  }
  if (name === 'WebFetch' || name === 'WebSearch') return { key: name, reason: '联网（可能把内容带出去）' };
  return { key: name, reason: '用工具 ' + name };
}
