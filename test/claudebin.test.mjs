// Claude 用哪个程序跑：SDK 自带的在就用它；缺了用电脑上的 claude 命令兜底（claudebin.mjs）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sdkBinNames, sdkBinOk, claudeExe } from '../src/claws/claudebin.mjs';

test('找自带程序的包名和 SDK 一样：Linux 两种 libc 都试，Windows 带 .exe', () => {
  assert.deepEqual(sdkBinNames('darwin', 'arm64'), ['@anthropic-ai/claude-agent-sdk-darwin-arm64/claude']);
  assert.deepEqual(sdkBinNames('linux', 'x64'), ['@anthropic-ai/claude-agent-sdk-linux-x64/claude', '@anthropic-ai/claude-agent-sdk-linux-x64-musl/claude']);
  assert.deepEqual(sdkBinNames('win32', 'x64'), ['@anthropic-ai/claude-agent-sdk-win32-x64/claude.exe']);
  assert.deepEqual(sdkBinNames('android', 'arm64'), ['@anthropic-ai/claude-agent-sdk-linux-arm64-android/claude']);
});

test('自带程序在不在：解析得到且文件存在才算；解析报错（没装可选依赖）算缺', () => {
  const resolve = n => { if (/musl/.test(n)) return '/m/' + n; throw new Error('MODULE_NOT_FOUND'); };
  assert.equal(sdkBinOk({ resolve, exists: () => true, platform: 'linux', arch: 'x64' }), true, 'glibc 的没装、musl 的在：也算在（和 SDK 一样两个都试）');
  assert.equal(sdkBinOk({ resolve, exists: () => true, platform: 'darwin', arch: 'x64' }), false);
  assert.equal(sdkBinOk({ resolve: n => '/x/' + n, exists: () => false, platform: 'darwin', arch: 'x64' }), false);
  assert.equal(sdkBinOk(), true, '这台电脑上装着依赖：自带程序在');
});

test('兜底：自带的在 → 不传路径；缺了有 claude 命令 → 传它；都没有 → 不传；Windows 只认 .exe', () => {
  assert.deepEqual(claudeExe({ ok: () => true, find: () => '/usr/local/bin/claude' }), {});
  assert.deepEqual(claudeExe({ ok: () => false, find: () => '/usr/local/bin/claude' }), { pathToClaudeCodeExecutable: '/usr/local/bin/claude' });
  assert.deepEqual(claudeExe({ ok: () => false, find: () => null }), {});
  assert.deepEqual(claudeExe({ ok: () => false, find: () => 'C:\\npm\\claude.cmd', platform: 'win32' }), {});
  assert.deepEqual(claudeExe({ ok: () => false, find: () => 'C:\\Users\\a\\.local\\bin\\claude.exe', platform: 'win32' }), { pathToClaudeCodeExecutable: 'C:\\Users\\a\\.local\\bin\\claude.exe' });
});
