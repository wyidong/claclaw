// 再确认身份只要密码（auth.mjs verifyPassword）：有密码的任一组对上就行；没设密码的账号要带用户名
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.CLACLAW_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-authpw-'));
const { setupMaster, setLastSet, verifyPassword, anyNoPassword } = await import('../auth.mjs');

test('verifyPassword', () => {
  setupMaster('boss', 'pw-master');
  assert.equal(verifyPassword('pw-master'), 'master');
  assert.equal(verifyPassword('nope'), null);
  assert.equal(verifyPassword(''), null);
  assert.equal(anyNoPassword(), false);
  setLastSet('', 'pw-last');
  assert.equal(verifyPassword('pw-last'), 'lastSet');
  assert.equal(verifyPassword('pw-master'), 'master');
  setLastSet('onlyuser', '');
  assert.equal(anyNoPassword(), true);
  assert.equal(verifyPassword(''), null, '没设密码的账号光靠空密码不行');
  assert.equal(verifyPassword('', 'onlyuser'), 'lastSet', '带上用户名可以');
  assert.equal(verifyPassword('', 'boss'), null);
});
