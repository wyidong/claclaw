// claclaw 技能：仓库 skills/ 里预先准备好的 Agent Skills（SKILL.md + 脚本），用户用到相关场景时 claclaw 推荐安装。
// 两个安装位置就覆盖五个 Claw：
//   ~/.claude/skills  —— Claude Code（OpenCode 也读）
//   ~/.agents/skills  —— DeepSeek Harness、OpenCode、Kimi、Qwen Code、OpenClaw 共用的个人技能目录
// 装的是复制件（有的 Claw 不跟软链接），里面放一个 .claclaw-skill 标记；claclaw 启动时把带标记的复制件同步成仓库里的最新版，
// 卸载也只删带标记的，用户自己的同名技能不碰。
// 另外每次启动写 ~/.claclaw/local.json（本机地址 + 令牌）和 ~/.claclaw/bin/ 下的命令，技能里的命令靠它们找到 claclaw。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(ROOT, 'skills');
const HOME = os.homedir();
export const CLACLAW_HOME = process.env.CLACLAW_HOME || path.join(HOME, '.claclaw');
const MARK = '.claclaw-skill';

// 安装位置：claude 一处，其余 Claw 共用一处
export const TARGETS = {
  claude: { dir: path.join(HOME, '.claude', 'skills'), claws: ['claude', 'opencode'], label: 'Claude Code' },
  agents: { dir: path.join(HOME, '.agents', 'skills'), claws: ['deepseek', 'opencode', 'kimi', 'qwen', 'openclaw'], label: 'DeepSeek、OpenCode、Kimi、Qwen、OpenClaw' },
};
export const targetOf = claw => claw === 'claude' ? 'claude' : 'agents';

export function catalog() {
  try { return JSON.parse(fs.readFileSync(path.join(SRC, 'index.json'), 'utf8')).filter(s => s && /^[a-z0-9-]+$/.test(s.name)); }
  catch { return []; }
}
const versionOf = name => {
  // 版本 = 技能目录里所有文件内容的哈希：仓库更新了，复制件就跟着更新
  const h = crypto.createHash('sha256');
  const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { h.update(f.name); h.update(fs.readFileSync(p)); } } };
  walk(path.join(SRC, name));
  return h.digest('hex').slice(0, 16);
};
const markOf = dest => { try { return JSON.parse(fs.readFileSync(path.join(dest, MARK), 'utf8')); } catch { return null; } };

// 某个技能在某个位置的状态：none 没装 / ours 我们装的 / foreign 用户自己的同名技能
export function stateAt(name, target) {
  const dest = path.join(TARGETS[target].dir, name);
  if (!fs.existsSync(path.join(dest, 'SKILL.md'))) return 'none';
  return markOf(dest) ? 'ours' : 'foreign';
}
export function installedFor(name, claw) {
  return Object.entries(TARGETS).some(([t, v]) => v.claws.includes(claw) && stateAt(name, t) !== 'none');
}
export function list(clawsInstalled) {
  return catalog().map(s => ({
    ...s,
    targets: Object.entries(TARGETS)
      .filter(([, v]) => v.claws.some(c => s.claws.includes(c) && clawsInstalled.includes(c)))
      .map(([t, v]) => ({ id: t, label: v.label, state: stateAt(s.name, t) })),
  }));
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const f of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, f.name), b = path.join(to, f.name);
    if (f.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b);
  }
}
export function install(name, target) {
  if (!catalog().some(s => s.name === name)) throw new Error('没有这个技能：' + name);
  const t = TARGETS[target]; if (!t) throw new Error('没有这个安装位置');
  const dest = path.join(t.dir, name);
  if (stateAt(name, target) === 'foreign') throw new Error(dest + ' 已有同名技能（不是 claclaw 装的），没有覆盖');
  const tmp = dest + '.claclaw-tmp-' + process.pid;
  fs.rmSync(tmp, { recursive: true, force: true });
  copyDir(path.join(SRC, name), tmp);
  fs.writeFileSync(path.join(tmp, MARK), JSON.stringify({ from: 'claclaw', version: versionOf(name), at: Date.now() }));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.renameSync(tmp, dest);
}
export function uninstall(name, target) {
  const t = TARGETS[target]; if (!t) throw new Error('没有这个安装位置');
  if (stateAt(name, target) !== 'ours') throw new Error('不是 claclaw 装的技能，不动它');
  fs.rmSync(path.join(t.dir, name), { recursive: true, force: true });
}
// 启动时：我们装过的复制件跟上仓库里的最新版
export function syncInstalled(log) {
  for (const s of catalog()) for (const target of Object.keys(TARGETS)) {
    if (stateAt(s.name, target) !== 'ours') continue;
    const m = markOf(path.join(TARGETS[target].dir, s.name));
    try { if (m.version !== versionOf(s.name)) { install(s.name, target); log?.('skill updated', s.name, '→', target); } }
    catch (e) { log?.('skill update failed', s.name, target, e.message); }
  }
}

// 本机令牌 + 命令入口。只有默认实例（或明确给了 CLACLAW_HOME 的）才写，免得临时实例把正在用的覆盖掉
let localToken = '';
export const checkLocal = t => !!localToken && typeof t === 'string' && t.length === localToken.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(localToken));
export function setupLocal(port, log) {
  if (process.env.CLACLAW_DATA && !process.env.CLACLAW_HOME) return;
  try {
    localToken = crypto.randomBytes(24).toString('base64url');
    fs.mkdirSync(path.join(CLACLAW_HOME, 'bin'), { recursive: true, mode: 0o700 });
    const f = path.join(CLACLAW_HOME, 'local.json');
    fs.writeFileSync(f + '.tmp', JSON.stringify({ url: 'http://127.0.0.1:' + port, token: localToken, pid: process.pid }), { mode: 0o600 });
    fs.renameSync(f + '.tmp', f);
    // 命令入口：用 claclaw 自己的 node 跑仓库里的脚本（AI 的终端里不一定有 node）
    for (const s of catalog()) {
      const js = path.join(SRC, s.name, s.name.replace(/^claclaw-/, '') + '.mjs');
      if (!fs.existsSync(js)) continue;
      const bin = path.join(CLACLAW_HOME, 'bin', s.name);
      fs.writeFileSync(bin, '#!/bin/sh\nexec ' + JSON.stringify(process.execPath) + ' ' + JSON.stringify(js) + ' "$@"\n', { mode: 0o755 });
    }
  } catch (e) { log?.('local setup failed', e.message); }
}
