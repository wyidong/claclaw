import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureAutostart, vbsText } from '../src/winstart.mjs';

const read = f => fs.readFileSync(f).toString('utf16le').replace(/^\ufeff/, '');

test('Windows 开机启动：第一次放好 claclaw.vbs（后台跑守护），内容变了就更新，用户删了不再放回', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'winstart-')), dir = path.join(t, 'Startup'), data = path.join(t, 'data');
  fs.mkdirSync(data);
  const o = { root: 'D:\\apps\\claclaw 中文', data, port: 8787, node: 'C:\\Program Files\\nodejs\\node.exe', env: {}, platform: 'win32', dir };
  const f = path.join(dir, 'claclaw.vbs');
  assert.equal(ensureAutostart(o), 'created');
  assert.equal(fs.readFileSync(f).subarray(0, 2).toString('hex'), 'fffe');   // UTF-16 带 BOM：WSH 认，中文路径不乱
  const v = read(f);
  assert.match(v, /sh\.CurrentDirectory = "D:\\apps\\claclaw 中文"/);
  assert.match(v, /sh\.Run """C:\\Program Files\\nodejs\\node\.exe"" tools\\win-serve\.mjs", 0, False/);   // 0：不弹窗口
  assert.doesNotMatch(v, /--port|CLACLAW_HOST/);
  assert.equal(ensureAutostart(o), 'ok');
  // 端口、监听地址变了：更新
  assert.equal(ensureAutostart({ ...o, port: 9000, host: '127.0.0.1,100.1.2.3' }), 'updated');
  assert.match(read(f), /tools\\win-serve\.mjs --port 9000", 0, False/);
  assert.match(read(f), /sh\.Environment\("PROCESS"\)\("CLACLAW_HOST"\) = "127\.0\.0\.1,100\.1\.2\.3"/);
  // 用户删了：不再放回
  fs.unlinkSync(f);
  assert.equal(ensureAutostart(o), 'skip:removed-by-user');
  assert.ok(!fs.existsSync(f));
});

test('Windows 开机启动：不是 Windows、CLACLAW_AUTOSTART=0、指定了 CLACLAW_DATA（测试、多开）都不放', () => {
  const t = fs.mkdtempSync(path.join(os.tmpdir(), 'winstart-')), dir = path.join(t, 'Startup');
  const o = { root: 'D:\\c', data: t, port: 8787, node: 'node.exe', dir };
  assert.equal(ensureAutostart({ ...o, platform: 'darwin', env: {} }), 'skip:not-windows');
  assert.equal(ensureAutostart({ ...o, platform: 'win32', env: { CLACLAW_AUTOSTART: '0' } }), 'skip:off');
  assert.equal(ensureAutostart({ ...o, platform: 'win32', env: { CLACLAW_DATA: t } }), 'skip:custom-data');
  assert.ok(!fs.existsSync(dir));
});

test('vbs 里的双引号按 VBScript 转义', () => {
  assert.match(vbsText({ root: 'C:\\a"b', node: 'n.exe' }), /sh\.CurrentDirectory = "C:\\a""b"/);
});
