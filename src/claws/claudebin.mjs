// Claude 用哪个程序跑：Claude Agent SDK 自带各平台的 Claude Code 程序（可选依赖 @anthropic-ai/claude-agent-sdk-<平台>-<架构>），
// 平时就用它（不传 pathToClaudeCodeExecutable，SDK 自己找）。装依赖时跳过了可选依赖（--omit=optional）或者平台少见，
// 自带的程序就缺了，SDK 直接报错；这时改用电脑上装的 claude 命令兜底（还是走 SDK 这一条路，只是换个程序）。
// 找法照抄 SDK（sdk.mjs 的 K4）：Linux 两种 libc 的包都试，Android 用 linux-<arch>-android；Windows 是 claude.exe
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { findBin } from '../util.mjs';

const PKG = '@anthropic-ai/claude-agent-sdk';
export function sdkBinNames(platform = process.platform, arch = process.arch) {
  const ext = platform === 'win32' ? '.exe' : '';
  const pk = platform === 'android' ? [`${PKG}-linux-${arch}-android`]
    : platform === 'linux' ? [`${PKG}-linux-${arch}`, `${PKG}-linux-${arch}-musl`] : [`${PKG}-${platform}-${arch}`];
  return pk.map(p => p + '/claude' + ext);
}

// SDK 自带的程序在不在（从 SDK 所在位置解析，和 SDK 自己找的一样）
export function sdkBinOk({ resolve, exists = fs.existsSync, platform, arch } = {}) {
  let res = resolve;
  if (!res) {
    try { const r = createRequire(createRequire(import.meta.url).resolve(PKG)); res = n => r.resolve(n); } catch { return false; }   // Node 18 也行（不用 import.meta.resolve）
  }
  return sdkBinNames(platform, arch).some(n => { try { return exists(res(n)); } catch { return false; } });
}

// 给 query() 的 options：自带的在 → {}（SDK 自己找）；缺了、电脑上有 claude 命令 → { pathToClaudeCodeExecutable }；都没有 → {}（让 SDK 报它的错）
// 自带的在不在只查一次（装好就不会变）；兜底的命令每次现找（用户可能后来才装）。Windows 只认 .exe（npm 的 .cmd 外壳 SDK 起不来）
let sdkOk = null;
export function claudeExe({ ok = () => (sdkOk ??= sdkBinOk()), find = () => findBin('claude'), platform = process.platform } = {}) {
  if (ok()) return {};
  const b = find();
  if (!b || (platform === 'win32' && !/\.exe$/i.test(b))) return {};
  return { pathToClaudeCodeExecutable: b };
}
// Claude 在这台电脑上跑得起来吗：自带的在，或者有 claude 命令可以兜底
export const claudeRunnable = () => (sdkOk ??= sdkBinOk()) || !!claudeExe().pathToClaudeCodeExecutable;
