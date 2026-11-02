import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, loginInfo } from '../login.mjs';

test('登录规格：每个都有名字、说明，要么能起命令要么直接写文件；loginInfo 字段齐全', () => {
  for (const [k, s] of Object.entries(SPECS)) {
    assert.ok(s.label && s.hint, k + ' 缺 label / hint');
    assert.ok(typeof s.cmd === 'function' || typeof s.write === 'function', k + ' 既没有 cmd 也没有 write');
    assert.equal(typeof s.loggedIn, 'function'); assert.equal(typeof s.libOk, 'function');
    const info = loginInfo(k);
    for (const f of ['can', 'key', 'loggedIn', 'need', 'hint', 'running']) assert.ok(f in info, k + ' loginInfo 缺 ' + f);
    assert.equal(info.key, !!(s.keyPrompt || s.write));
  }
  assert.equal(loginInfo('claude'), null);
});
