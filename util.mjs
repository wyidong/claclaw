// 各模块共用的小工具：路径显示、文字压成一行、时间统一成毫秒、找命令、跑命令
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export const HOME = os.homedir();
// 家目录下的路径显示成 ~/…
export const tilde = p => { p = String(p || ''); return p === HOME ? '~' : p.startsWith(HOME + '/') ? '~' + p.slice(HOME.length) : p; };
// 在 cwd 下的给相对路径，其余同 tilde
export const relPath = (p, cwd) => { if (typeof p !== 'string') return ''; if (cwd && p.startsWith(cwd + '/')) return p.slice(cwd.length + 1); return tilde(p); };
export const oneLine = t => String(t || '').replace(/\s+/g, ' ').trim();
// 时间统一成毫秒：秒 / 毫秒 / 数字字符串 / ISO 字符串都认；认不出返回 bad
export const tms = (v, bad) => { const n = typeof v === 'string' ? (/^\d+$/.test(v) ? +v : Date.parse(v)) : +v; return n > 0 ? (n < 1e12 ? n * 1000 : n) : bad; };
export const sleep = ms => new Promise(r => { const t = setTimeout(r, ms); t.unref?.(); });

// 子进程的 PATH：带上当前 node 所在目录（launchd 环境里 PATH 很短）
export const binEnv = () => ({ ...process.env, PATH: [path.dirname(process.execPath), process.env.PATH || '', '/usr/local/bin'].join(':') });
// 找命令：先看 first 里的目录，再看 PATH 和常见安装目录；找到返回真实路径（软链接解开），找不到 null
export function findBin(name, first = []) {
  const dirs = new Set([...first, ...(process.env.PATH || '').split(':'), path.dirname(process.execPath), '/opt/homebrew/bin', '/usr/local/bin', path.join(HOME, '.local', 'bin'), '/usr/bin']);
  for (const d of dirs) {
    const p = d && path.join(d, name);
    if (!p) continue;
    try { fs.accessSync(p, fs.constants.X_OK); } catch { continue; }
    try { return fs.realpathSync(p); } catch { return p; }
  }
  return null;
}
// 跑命令拿 stdout；失败时报错信息取 stderr 最后一行
export const runBin = (bin, args, ms, { maxBuffer = 64 * 1024 * 1024, missing = '没找到命令' } = {}) => new Promise((ok, fail) => {
  if (!bin) return fail(new Error(missing));
  execFile(bin, args, { cwd: HOME, env: binEnv(), timeout: ms, maxBuffer }, (e, out, err) =>
    e ? fail(new Error(String(err || e.message).trim().split('\n').pop())) : ok(out));
});
// 读 JSON 文件：没有、读不了、内容是 null 都返回 fallback
export const readJson = (file, fallback = {}) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) ?? fallback; } catch { return fallback; } };
