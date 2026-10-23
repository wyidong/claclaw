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
const SENSITIVE_NAME = /(^|\/)(\.env(\.[^/]*)?|id_(rsa|dsa|ecdsa|ed25519)[^/]*|[^/]*\.(pem|p12|pfx|key|keychain(-db)?)|[^/]*(credential|secret|token|passw|auth\.json|vapid)[^/]*|ssh_[^/]*)$/i;

const expand = (p, cwd) => {
  let s = String(p || '').trim().replace(/^['"]|['"]$/g, '');
  if (!s) return '';
  if (s === '~' || s.startsWith('~/')) s = HOME + s.slice(1);
  else if (s.startsWith('$HOME')) s = HOME + s.slice(5);
  return path.resolve(cwd || HOME, s);
};
const inside = (p, root) => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');

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
const SAFE_GIT = new Set(['status', 'log', 'diff', 'show', 'rev-parse', 'branch', 'tag', 'blame', 'ls-files', 'shortlog', 'describe', 'pull', 'fetch', 'remote']);
const SEARCH_CMDS = new Set(['grep', 'egrep', 'rg', 'find', 'du', 'tree', 'ls']);

function words(seg) {
  // 粗分词：引号里的空格不拆。分错只会多问，不会少问（每一段都要单独过检查）
  const out = []; let cur = '', q = '';
  for (const ch of seg) {
    if (q) { if (ch === q) q = ''; else cur += ch; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (/\s/.test(ch)) { if (cur) out.push(cur), cur = ''; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

// 返回 null = 安全；否则返回要确认的原因
export function bashRisk(cmd, cwd, roots) {
  let s = String(cmd || '');
  if (/\$\(|`|<\(|>\(|\$\{/.test(s)) return '命令里有嵌套执行';
  s = s.replace(/\s\d?>\s*\/dev\/null/g, ' ').replace(/\s2>&1/g, ' ');
  if (/>/.test(s)) return '命令会写文件';
  const segs = s.split(/&&|\|\||[;|&\n]/).map(x => x.trim()).filter(Boolean);
  if (!segs.length) return '空命令';
  let dir = cwd;
  for (const seg of segs) {
    const w = words(seg);
    const c = w[0];
    if (!SAFE_CMDS.has(c)) return '运行 ' + c;
    const args = w.slice(1);
    if (c === 'git') {
      const sub = args[0];
      if (!SAFE_GIT.has(sub)) return 'git ' + (sub || '');
      if (args.some(a => /^--(output|exec|upload-pack|receive-pack|ext-diff)/.test(a) || /^-[cC]$/.test(a))) return 'git 带了会执行或写文件的参数';
      if ((sub === 'branch' || sub === 'tag') && args.slice(1).some(a => /^-/.test(a) && !/^-(a|v|vv|r|l|-list|-all|-verbose|-show-current|-contains)$/.test(a))) return 'git ' + sub + ' 改动';
      if (sub === 'remote' && args.slice(1).some(a => /^(add|remove|rm|rename|set-url|set-head|prune)$/.test(a))) return 'git remote 改动';
      continue;
    }
    if (c === 'find' && args.some(a => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(a))) return 'find 会执行或删除';
    if (c === 'sed') {
      const script = args.find(a => !/^-/.test(a));
      if (!(args.includes('-n') && script && /^\d+(,\d+)?p$/.test(script))) return 'sed 可能改文件';
    }
    if (c === 'cd') { dir = expand(args[0] || '~', dir); if (touchesSensitive(dir, cwd, roots)) return '进入敏感目录'; continue; }
    const paths = args.filter(a => !/^-/.test(a));
    for (const a of paths) if (/[/~.]/.test(a) && touchesSensitive(a, dir, roots)) return '读敏感位置 ' + a;
    for (const a of paths) if (SENSITIVE_NAME.test(a)) return '读敏感文件 ' + a;
    // 递归搜索没写路径：搜的是当前目录
    if (SEARCH_CMDS.has(c) && (c === 'rg' || c === 'find' || c === 'du' || c === 'tree' || args.some(a => /^-[a-zA-Z]*[rR]/.test(a)))
      && !paths.some(a => /[/~.]/.test(a)) && touchesSensitive(dir, cwd, roots)) return '在含敏感内容的目录里搜索';
  }
  return null;
}

// 工具调用的风险：null = 直接放行；否则返回 { key（「本轮同类都允许」按它记）, reason }
export function peerRisk(name, input, cwd, roots) {
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
    if (touchesSensitive(p, cwd, roots) || /\/\.git\/|\/\.claude\//.test(p)) return { key: 'edit-sensitive', reason: '改敏感文件：' + p };
    return null;
  }
  if (name === 'Bash') {
    const r = bashRisk(input.command, cwd, roots);
    if (!r) return null;
    const first = words(String(input.command || '').trim())[0] || '';
    return { key: 'bash:' + first, reason: r };
  }
  if (name === 'WebFetch' || name === 'WebSearch') return { key: name, reason: '联网（可能把内容带出去）' };
  return { key: name, reason: '用工具 ' + name };
}
