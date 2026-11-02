import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SPECS, loginInfo, tailOf } from '../login.mjs';

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

test('tailOf：终端界面重画连成一行的几帧按转圈字符切开、去重、去网址，只留最后两句', () => {
  const text = 'Waiting for auth... (Press ESC to cancel)\nBrowser didn\'t open? Use the url below to sign in: (Copied link to clipboard)\nhttps://example.com/auth?x=1\n✸ Waiting for auth... (Press ESC to cancel)✸ Waiting for auth... (Press ESC to cancel)✹ Waiting for auth... (Press ESC to cancel)';
  assert.equal(tailOf(text), 'Browser didn\'t open? Use the url below to sign in: (Copied link to clipboard) · Waiting for auth... (Press ESC to cancel)');
  assert.equal(tailOf('a\n\n · \nb\r\nb'), 'a · b');
  assert.equal(tailOf(''), '');
  assert.equal(tailOf('Pick one\x0f\n✷ Waiting for auth...✷ Waiting for auth...⠙ Waiting for auth...'), 'Pick one · Waiting for auth...');
});

test('Copilot 登录用设备码（默认的浏览器回调只能在电脑上用）', async () => {
  const { SPECS } = await import('../login.mjs');
  assert.ok(SPECS.copilot && /--device-code/.test(String(SPECS.copilot.cmd)), 'Copilot 要用设备码登录');
});
