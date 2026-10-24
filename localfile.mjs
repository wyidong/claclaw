// 聊天里点文件路径：解析成电脑上的文件；本机网页直接用电脑上的 App 打开，别的设备读回去在页面里预览
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const READ_MAX = 50 * 1024 * 1024;   // 和 send_file 一样

// `server.mjs:123`、`a.md#L5`、两边的引号 → 去掉；~ 展开
export function cleanUserPath(p, home) {
  let s = String(p || '').trim().replace(/^(['"])(.*)\1$/, '$2');
  s = s.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?::\d+){1,2}$/, '');
  if (!s || s.length > 1024 || s.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return '';
  return s.replace(/^~(?=\/|$)/, home);
}

const statOf = f => { try { return fs.statSync(f); } catch { return null; } };

// 相对路径：先按会话目录找；找不到再看会话目录下一层（会话开在上级目录、AI 写的是仓库里的相对路径），最后看主目录
export function findUserPath(p, cwd, home) {
  const s = cleanUserPath(p, home);
  if (!s) return null;
  if (path.isAbsolute(s)) { const st = statOf(s); return st ? { abs: s, st } : null; }
  const base = cwd && path.isAbsolute(cwd) ? cwd : home;
  const bases = [base];
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true }).slice(0, 200)) {
      if (d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules') bases.push(path.join(base, d.name));
    }
  } catch {}
  if (home && base !== home) bases.push(home);
  for (const b of bases) {
    const abs = path.resolve(b, s), st = statOf(abs);
    if (st) return { abs, st };
  }
  return null;
}

// 双击会执行代码的东西（.command、.app、脚本、可执行文件……）不直接打开，只在访达里选中
const RISKY = new Set(('app command tool terminal sh bash zsh csh ksh fish py pyw pl rb php jar workflow action scpt scptd applescript ' +
  'pkg mpkg dmg webloc inetloc fileloc url desktop prefpane kext saver bundle plugin appex framework mobileconfig shortcut xpc ' +
  'dylib so exe bat cmd ps1 vbs').split(' '));
export function openArgs(abs, st) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (st.isDirectory()) return RISKY.has(ext) ? ['-R', abs] : [abs];
  if (RISKY.has(ext) || (st.mode & 0o111)) return ['-R', abs];
  return [abs];
}
// 返回 'open'（用默认 App 打开）或 'reveal'（在访达里选中）
export function openOnMac(abs, st) {
  const args = openArgs(abs, st);
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/open', args, { stdio: 'ignore' });
    p.on('error', reject);
    p.on('exit', code => code === 0 ? resolve(args[0] === '-R' ? 'reveal' : 'open') : reject(new Error('open 退出码 ' + code)));
  });
}

const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', pdf: 'application/pdf' };
// 给网页预览的类型：图片 / PDF 按扩展名；不认识的扩展名，开头 8KB 没有 0 字节就当文本（.go .rs Makefile 之类也能直接看）
export function previewType(abs, size) {
  const ext = path.extname(abs).slice(1).toLowerCase();
  if (MIME[ext]) return MIME[ext];
  if (size > 3 * 1024 * 1024) return 'application/octet-stream';
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const b = Buffer.alloc(Math.min(size, 8192));
    const n = fs.readSync(fd, b, 0, b.length, 0);
    return b.subarray(0, n).includes(0) ? 'application/octet-stream' : 'text/plain; charset=utf-8';
  } catch { return 'application/octet-stream'; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
