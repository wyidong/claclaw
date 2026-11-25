import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 假的 ~/.gemini 和 claclaw 数据目录：先设好环境变量再加载模块
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-gemini-'));
const ghome = path.join(root, 'home'), data = path.join(root, 'data');
process.env.GEMINI_CLI_HOME = ghome; process.env.CLACLAW_DATA = data;
delete process.env.GEMINI_API_KEY; delete process.env.GOOGLE_API_KEY;
fs.mkdirSync(data, { recursive: true });
const gm = await import('../src/claws/gemini.mjs');
const { SPECS, loginInfo } = await import('../src/claws/login.mjs');
const { INSTALLS } = await import('../src/claws/install.mjs');

const G = path.join(ghome, '.gemini');
const line = o => JSON.stringify(o) + '\n';
function session(slug, cwd, sid, recs, name = 'session-2026-11-25T04-38-' + sid.slice(0, 8) + '.jsonl') {
  const d = path.join(G, 'tmp', slug);
  fs.mkdirSync(path.join(d, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(d, '.project_root'), cwd);
  const f = path.join(d, 'chats', name);
  fs.writeFileSync(f, recs.map(line).join(''));
  return f;
}
const CTX = { id: 'c0', timestamp: '2026-11-25T04:38:34.000Z', type: 'user', content: [{ text: '<session_context>\nThis is the Gemini CLI.\n</session_context>' }] };
const SID = 'fc03422d-0330-4597-9aec-21ffb91a522b', JUNK = '6d586a4b-254c-4b9a-86ec-e5a40d14e993';
const real = session('proj', '/work/proj', SID, [
  { sessionId: SID, projectHash: 'x', startTime: '2026-11-25T04:38:34.000Z', lastUpdated: '2026-11-25T04:38:34.000Z', kind: 'main' },
  CTX, { $set: { lastUpdated: '2026-11-25T04:38:34.026Z' } },
  { id: 'u1', timestamp: '2026-11-25T04:38:35.000Z', type: 'user', content: [{ text: '用三个字打个招呼' }] },
  { id: 'a1', timestamp: '2026-11-25T04:38:36.000Z', type: 'gemini', content: '你好啊！', model: 'gemini-2.5-flash', tokens: { input: 10409, output: 1 } },
]);
session('home', '/Users/x', JUNK, [{ sessionId: JUNK, startTime: '2026-11-25T04:38:33.000Z', kind: 'main' }, CTX]);   // 起进程留下的空会话
session('proj', '/work/proj', 'aaaaaaaa-0000-4000-8000-000000000001', [{ sessionId: 'aaaaaaaa-0000-4000-8000-000000000001', kind: 'subagent' }, { id: 'u', type: 'user', content: [{ text: '子代理' }] }]);

test('会话列表：读 tmp/<项目>/chats，目录取 .project_root；只有 <session_context> 的空会话、子代理不列；标题、模型、上下文', () => {
  const list = gm.gmSessionList();
  assert.deepEqual(list.map(s => s.id), ['gm:' + SID]);
  const s = list[0];
  assert.equal(s.title, '用三个字打个招呼'); assert.equal(s.cwd, '/work/proj'); assert.equal(s.branch, 'gemini-2.5-flash'); assert.equal(s.claw, 'gemini');
  assert.equal(gm.gmInfo('gm:' + SID).ctx, 10409);
  assert.equal(gm.gmInfo('gm:' + JUNK), null);
  assert.equal(gm.gmInfo('qw:' + SID), null);
});

test('历史清理和时间：去掉 <session_context>；用户说的话、带文字的回复各有时间', () => {
  assert.equal(gm.stripCtx('<session_context>\nx\n</session_context>用三个字打个招呼'), '用三个字打个招呼');
  assert.equal(gm.stripCtx('<hook_context>h</hook_context> 你好'), '你好');
  assert.equal(gm.stripCtx('[Function Response: write_file]'), '', '重放的工具结果不算用户的话');
  assert.equal(gm.stripCtx('看看 [Function Response: x] 这个'), '看看 [Function Response: x] 这个');
  assert.deepEqual(gm.timesOf(real), [{ kind: 'user', text: '用三个字打个招呼', at: Date.parse('2026-11-25T04:38:35.000Z') }, { kind: 'ai', at: Date.parse('2026-11-25T04:38:36.000Z') }]);
});

test('改名：追加 $set summary（gemini 自己也认），先备份到回收站；列表用新名字', () => {
  const trash = path.join(data, 'trash');
  assert.equal(gm.gmRename('gm:' + SID, '  打招呼 测试 ', trash), '打招呼 测试');
  const last = fs.readFileSync(real, 'utf8').trim().split('\n').pop();
  assert.deepEqual(JSON.parse(last), { $set: { summary: '打招呼 测试' } });
  assert.ok(fs.readdirSync(trash).some(n => n.includes('gemini-rename_' + SID)));
  assert.equal(gm.gmInfo('gm:' + SID).title, '打招呼 测试');
  assert.throws(() => gm.gmRename('gm:nope-0000', 'x', trash), /找不到/);
});

test('删除：会话文件挪进回收站', () => {
  const sid = 'bbbbbbbb-0000-4000-8000-000000000002';
  const f = session('proj', '/work/proj', sid, [{ sessionId: sid, kind: 'main' }, { id: 'u', type: 'user', content: [{ text: '删我' }] }]);
  const trash = path.join(data, 'trash');
  const dest = gm.gmDelete('gm:' + sid, trash);
  assert.ok(!fs.existsSync(f) && fs.existsSync(dest) && dest.endsWith('.jsonl'));
  assert.equal(gm.gmInfo('gm:' + sid), null);
});

test('用哪把 key：没登录 Google 时用模型库第一把；记了供应商 / key 哈希就用那把；登录过 Google 且选了 own 就不用 key', () => {
  const store = { providers: [
    { id: 'g1', name: 'Google', endpoints: { gemini: 'https://generativelanguage.googleapis.com/v1beta' }, key: 'AIzaFIRST', models: [{ id: 'gemini-2.5-flash' }] },
    { id: 'g2', name: 'Google', label: '备用', endpoints: { gemini: 'https://generativelanguage.googleapis.com/v1beta' }, key: 'AIzaSECOND', models: [] },
    { id: 'ds', name: 'DeepSeek', endpoints: { openai: 'https://api.deepseek.com' }, key: 'sk-x', models: [{ id: 'v4' }] },
  ] };
  assert.deepEqual(gm.gmKeys(store).map(p => p.id), ['g1', 'g2']);
  assert.equal(gm.route(store, {}).p.id, 'g1');
  assert.equal(gm.route(store, { provider: 'g2', model: 'm' }).p.id, 'g2');
  assert.equal(gm.route(store, { provider: 'g2', model: 'm' }).model, 'm');
  assert.equal(gm.route(store, { keyHash: gm.keyHash('AIzaSECOND') }).p.id, 'g2');
  assert.equal(gm.route(store, { own: true }).p.id, 'g1', 'own 但没登录 Google：还是用 key');
  assert.equal(gm.route({ providers: [] }, {}), null);
  fs.mkdirSync(G, { recursive: true }); fs.writeFileSync(path.join(G, 'oauth_creds.json'), '{"refresh_token":"x"}');
  try {
    assert.equal(gm.route(store, { own: true }), null);
    assert.equal(gm.route(store, {}), null, '登录过 Google、没选过：用 Google');
    assert.equal(gm.route(store, { provider: 'g1' }).p.id, 'g1');
    assert.equal(gm.wantType({ p: store.providers[0] }), 'gemini-api-key');
    assert.equal(gm.wantType(null, ''), 'oauth-personal');
  } finally { fs.unlinkSync(path.join(G, 'oauth_creds.json')); }
  assert.equal(gm.wantType(null, 'vertex-ai'), 'vertex-ai', '用户自己选的 Vertex 不动');
  assert.equal(gm.wantType(null, ''), '');
});

test('认证方式写进 settings.json：只改 security.auth.selectedType，别的设置留着，改之前备份；读不懂的不动', () => {
  const f = path.join(G, 'settings.json'), trash = path.join(root, 'trash2');
  fs.mkdirSync(G, { recursive: true });
  fs.writeFileSync(f, JSON.stringify({ ui: { theme: 'x' }, security: { folderTrust: { enabled: true }, auth: { selectedType: 'oauth-personal' } } }));
  assert.equal(gm.gmSetType('gemini-api-key', null, trash), true);
  const o = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepEqual(o, { ui: { theme: 'x' }, security: { folderTrust: { enabled: true }, auth: { selectedType: 'gemini-api-key' } } });
  assert.equal(fs.readdirSync(trash).length, 1);
  assert.equal(gm.gmSetType('gemini-api-key', null, trash), false, '没变不写');
  assert.equal(gm.gmSetType('', null, trash), false);
  fs.writeFileSync(f, '{ // 注释\n}');
  assert.equal(gm.gmSetType('oauth-personal', null, trash), false);
  fs.unlinkSync(f);
});

test('ACP 开关按装的版本选：代码里有 option("acp" 用 --acp，没有用 --experimental-acp', () => {
  const d = path.join(root, 'pkg', 'bundle'); fs.mkdirSync(d, { recursive: true });
  const bin = path.join(d, 'gemini.js');
  fs.writeFileSync(bin, '#!/usr/bin/env node\nimport "./gemini-ABC.js";');
  fs.writeFileSync(path.join(d, 'gemini-ABC.js'), 'yargs.option("experimental-acp", {})');
  assert.equal(gm.acpFlag(bin), '--experimental-acp');
  fs.writeFileSync(path.join(d, 'gemini-ABC.js'), 'yargs.option("acp", {}).option("experimental-acp", {})');
  const t = new Date(Date.now() + 5000); fs.utimesSync(bin, t, t);
  assert.equal(gm.acpFlag(bin), '--acp');
  fs.writeFileSync(path.join(root, 'pkg', 'package.json'), '{"name":"@google/gemini-cli","version":"0.71.1"}');
  assert.equal(gm.gmVersion(bin), '0.71.1');
});

test('登录规格：Google 账号（终端界面 + 授权码）和 API key 两种都有；key 不像就拒；登录面板只给模型库 key 的后 4 位', () => {
  const s = SPECS.gemini;
  assert.ok(s.google && typeof s.cmd === 'function' && typeof s.write === 'function');
  assert.ok(s.ask.when.test('Please visit the following URL…\n\nEnter the authorization code: '));
  assert.equal(s.env().GEMINI_CLI_TRUST_WORKSPACE, 'false', '登录用的空目录定成不信任（不弹对话框，授权码才收得到）');
  assert.ok(s.steps.some(x => x.when.test('Do you trust the files in this folder?') && x.send === '3'), '万一弹了也选「不信任」');
  assert.throws(() => s.write('有空格 的 key'), /不像/);
  assert.throws(() => s.write('', { lib: 'nope' }), /没有这把/);
  const info = loginInfo('gemini');
  assert.equal(info.google, process.platform !== 'win32');
  assert.ok(Array.isArray(info.keys));
  for (const k of info.keys) assert.deepEqual(Object.keys(k).sort(), ['id', 'label', 'last4', 'on']);
});

test('一键安装列表里有 Gemini CLI（只装这个包）', () => {
  assert.equal(INSTALLS.gemini.pkg, '@google/gemini-cli@latest');
  assert.equal(INSTALLS.gemini.bin, 'gemini');
});
