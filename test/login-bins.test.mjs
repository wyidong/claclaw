// 登录找的程序要和各 Claw 实际起的一致（不起真实外部程序）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { SPECS, codexLoginCmd } = await import('../login.mjs');
const { qdBin } = await import('../qoder.mjs');
const { mmBin } = await import('../minimax.mjs');
const { kmBin } = await import('../kimi.mjs');
const { cbBin } = await import('../codebuddy.mjs');
const { cxBin } = await import('../codex.mjs');
const { cpBin } = await import('../copilot.mjs');
const { glBin } = await import('../glm.mjs');

test('Codex 登录：有 codex-acp 用它带的 Codex（cli login --device-auth），没有才退回 codex 本体', () => {
  assert.deepEqual(codexLoginCmd('/x/codex-acp', '/x/codex'), ['/x/codex-acp', ['cli', 'login', '--device-auth']]);
  assert.deepEqual(codexLoginCmd('/x/codex-acp', null), ['/x/codex-acp', ['cli', 'login', '--device-auth']]);
  assert.deepEqual(codexLoginCmd(null, '/x/codex'), ['/x/codex', ['login', '--device-auth']]);
  assert.equal(codexLoginCmd(null, null), null);
});

test('各 Claw 登录用的程序就是它们会话里起的那个', () => {
  const same = { qoder: qdBin, minimax: mmBin, kimi: kmBin, codebuddy: cbBin, copilot: cpBin, glm: glBin };
  for (const [k, bin] of Object.entries(same)) assert.equal(SPECS[k].cmd()?.[0] ?? null, bin(), k);
  if (cxBin()) assert.equal(SPECS.codex.cmd()[0], cxBin());
});

test('qoder / minimax 的程序目录：findBin 第二个参数是目录，装在官方位置的能找到', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'login-bins-home-'));
  const put = (...p) => { const f = path.join(home, ...p); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '#!/bin/sh\n'); fs.chmodSync(f, 0o755); return fs.realpathSync(f); };
  const ext = process.platform === 'win32' ? '.exe' : '';   // Windows 上 findBin 只认带后缀的（PATHEXT）
  const qd = put('.qoder', 'bin', 'qodercli', 'qodercli' + ext);
  const mm = put('.minimax-code', 'bin', 'mcode' + ext);
  const js = `const [{ qdBin }, { mmBin }] = await Promise.all([import('./qoder.mjs'), import('./minimax.mjs')]); console.log(JSON.stringify([qdBin(), mmBin()]));`;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', js], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home, CLACLAW_DATA: fs.mkdtempSync(path.join(os.tmpdir(), 'login-bins-data-')) },
  });
  assert.deepEqual(JSON.parse(out.trim().split('\n').pop()), [qd, mm]);
});
