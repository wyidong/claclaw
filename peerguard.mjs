// 协同消息触发的那一轮：哪些工具调用可以直接放行，哪些要用户在手机上确认。
// 思路是「白名单」：认得出是安全的才放行，其余一律确认（危险命令的写法太多，黑名单拦不全）。
// 读文件也要管：这一轮的回复会传回对方，读到的钥匙、密码等于直接交出去。
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

const expand = (p, cwd) => {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  else if (s.startsWith('$HOME')) s = HOME + s.slice(5);
  return path.resolve(cwd || HOME, s);
};
const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
// 本身就是敏感内容：敏感文件，或在敏感目录里（不含「只是它们的上级」）
const inSensitive = (a, roots) => SENSITIVE_NAME.test(a) || roots.some(r => inside(a, r));

// 这个路径碰不碰得到敏感内容：本身敏感、在敏感目录里、或者是敏感目录的上级
export function touchesSensitive(p, cwd, roots) {
  const a = expand(p, cwd);
  if (!a) return false;
  if (SENSITIVE_NAME.test(a)) return true;
  if (a === '/' || a === HOME || inside(HOME, a)) return true;
  return roots.some(r => inside(a, r) || inside(r, a));
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
const inRepo = (dir, repos) => repos.some(r => dir === r || inside(dir, path.join(r, '.worktrees')));

function words(seg) {
  // 粗分词：引号里的空格不拆，反斜杠转义下一个字符（和 shell 一样）。分错只会多问，不会少问（每一段都要单独过检查）
  const out = []; let cur = '', q = '';
  for (let i = 0; i < seg.length; i++) {
    const ch = seg[i];
    if (q === "'") { if (ch === q) q = ''; else cur += ch; continue; }
    if (ch === '\\' && i + 1 < seg.length && (!q || /["\\$`]/.test(seg[i + 1]))) { cur += seg[++i]; continue; }
    if (q) { if (ch === q) q = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) out.push(cur), cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
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
  if (/>/.test(unquoted(s))) return '命令会写文件';
  const segs = segments(s);
  if (!segs.length) return '空命令';
  let dir = cwd;
  for (const seg of segs) {
    const w = words(seg);
    const c = w[0];
    const args = w.slice(1);
    if (c === 'npm' && inRepo(dir, repos) && ROUTINE_NPM.has(args.filter(a => !/^(-s|--silent|-q|--quiet)$/.test(a)).join(' '))) {
      if (!clean(dir)) return '仓库里有没提交的改动，npm 会执行它们';
      continue;
    }
    if (!SAFE_CMDS.has(c)) return '运行 ' + c;
    if (c === 'jq' && args.some(a => /\$ENV|\benv\b/.test(a))) return 'jq 读取环境变量';
    if (c === 'git') {
      const sub = args[0];
      if (!SAFE_GIT.has(sub)) return 'git ' + (sub || '');
      if (args.some(a => /^--(output|exec|upload-pack|receive-pack|ext-diff)/.test(a) || /^-[cC]$/.test(a))) return 'git 带了会执行或写文件的参数';
      if ((sub === 'show' || sub === 'cat-file') && args.slice(1).some(a => { const i = a.indexOf(':'); return i >= 0 && SENSITIVE_NAME.test(a.slice(i + 1)); })) return '读敏感位置（git 里提交过的 ' + sub + '）';   // HEAD:.env 这类
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
      dir = expand(args[0] || '~', dir);
      if (dir === '/' || dir === HOME || inside(HOME, dir) || inSensitive(dir, roots)) return '进入敏感目录';
      continue;
    }
    const paths = args.filter(a => !/^-/.test(a));
    for (const a of paths) if (/[/~.]/.test(a) && touchesSensitive(a, dir, roots)) return '读敏感位置 ' + a;
    for (const a of paths) if (SENSITIVE_NAME.test(a)) return '读敏感文件 ' + a;
    // 递归搜索没写路径：搜的是当前目录
    if (SEARCH_CMDS.has(c) && (c === 'rg' || c === 'find' || c === 'du' || c === 'tree' || args.some(a => /^-[a-zA-Z]*[rR]/.test(a)))
      && !paths.some(a => /[/~.]/.test(a)) && touchesSensitive(dir, cwd, roots)) return '在含敏感内容的目录里搜索';
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

// 工具调用的风险：null = 直接放行；否则返回 { key（「本轮同类都允许」按它记）, reason }
export function peerRisk(name, input, cwd, roots, opts) {
  input = input || {};
  if (HARMLESS.has(name)) return null;
  if (READ_TOOLS.has(name)) {
    const p = input.file_path || input.notebook_path || input.path || cwd;
    return touchesSensitive(p, cwd, roots) ? { key: 'read-sensitive', reason: '读敏感位置：' + expand(p, cwd) } : null;
  }
  if (EDIT_TOOLS.has(name)) {
    const p = expand(input.file_path || input.notebook_path, cwd);
    if (!p) return { key: 'edit-out', reason: '改文件' };
    if (!inside(p, path.resolve(cwd))) return { key: 'edit-out', reason: '改项目目录外的文件：' + p };
    if (touchesSensitive(p, cwd, roots) || /\/(\.git|\.claude|node_modules)\//.test(p)) return { key: 'edit-sensitive', reason: '改敏感文件：' + p };
    return null;
  }
  if (name === 'Bash') {
    const r = bashRisk(input.command, cwd, roots, opts);
    if (!r) return null;
    const first = words(String(input.command || '').trim())[0] || '';
    return { key: 'bash:' + first, reason: r };
  }
  if (name === 'WebFetch' || name === 'WebSearch') return { key: name, reason: '联网（可能把内容带出去）' };
  return { key: name, reason: '用工具 ' + name };
}
