// claw-theme 技能：主题名 / 别名解析、卡片输出、set 调本机接口；主题库和网页、服务器认的 id 一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { makeTheme, THEME_RE } from '../src/theme.mjs';
const BIN = 'skills/claw-theme/theme.mjs';
const run = (...a) => execFileSync(process.execPath, [BIN, ...a], { encoding: 'utf8' });
const ids = out => out.split('\n').filter(l => l.includes(' | ')).map(l => l.split(' | ')[0]);
const THEMES = JSON.parse(fs.readFileSync('skills/claw-theme/themes.json', 'utf8'));

test('show：id、名字、别名（颜色、时辰、经络）都认，去重，输出 ```theme 块', () => {
  const out = run('show', '深色,九紫离火,粉色,午时,肾经,shichen@3,默认,深色');
  assert.match(out, /^```theme\n[\s\S]*\n```\n$/);
  assert.deepEqual(ids(out), ['dark', 'ziwei', 'shichen@7', 'shichen@6', 'shichen@9', 'shichen@3', 'auto']);
  for (const l of out.split('\n').filter(l => l.includes(' | '))) assert.equal(l.split(' | ').length, 3);
});
test('没有的主题退出码 2', () => {
  assert.equal(spawnSync(process.execPath, [BIN, 'show', '彩虹色xyz']).status, 2);
});
test('主题库的 id：网页的卡片能画、服务器的接口认', () => {
  const html = fs.readFileSync('public/index.html', 'utf8'), re = THEME_RE;
  for (const t of THEMES) {
    assert.ok(re.test(t.id), 'server: ' + t.id);
    assert.ok(t.id === 'auto' || t.id === 'shichen' || html.includes("'" + t.id + "':[") || html.includes(t.id + ":['"), 'THP: ' + t.id);
  }
});
async function withFake(args) {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c); req.on('end', () => { got.push(JSON.parse(b || '{}')); res.setHeader('content-type', 'application/json'); res.end('{"ok":true}'); }); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clth-'));
  fs.writeFileSync(path.join(home, 'local.json'), JSON.stringify({ url: 'http://127.0.0.1:' + srv.address().port, token: 'tk' }));
  const out = await new Promise(resolve => {   // 不能用 spawnSync：会卡住这个进程里的假服务器
    const p = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, CLACLAW_HOME: home } });
    let o = ''; p.stdout.on('data', c => o += c); p.on('close', () => resolve(o));
  });
  srv.close(); fs.rmSync(home, { recursive: true, force: true });
  return { got, out };
}
test('背景图：img off / set … --img off 都带上 img，主题名不吃进选项', async () => {
  let r = await withFake(['img', 'off']);
  assert.deepEqual(r.got, [{ img: 'off' }]);
  assert.match(r.out, /纯色/);
  r = await withFake(['set', '辰', '--img', 'off', '--alt', '子']);
  assert.deepEqual(r.got, [{ theme: 'shichen@4', img: 'off' }]);
  assert.deepEqual(ids(r.out), ['shichen@4', 'shichen@0']);
});
test('背景图：bg 不写路径 = 最近发的图；写路径转成绝对路径；--fit / --on 只收时辰；reset、fit', async () => {
  let r = await withFake(['bg', '--on', '辰', '--fit', 'center']);
  assert.deepEqual(r.got, [{ bg: 'last', theme: 'shichen@4', fit: 'center' }]);
  r = await withFake(['bg', 'pic.jpg']);
  assert.deepEqual(r.got, [{ bg: path.resolve('pic.jpg') }]);
  r = await withFake(['bg', '--on', '九紫离火']);
  assert.deepEqual(r.got, []);
  assert.match(r.out, /只有时辰主题/);
  assert.deepEqual((await withFake(['bg', 'reset'])).got, [{ bg: 'reset' }]);
  assert.deepEqual((await withFake(['fit', '居中'])).got, [{ fit: 'center' }]);
});
test('set：调本机接口换上第一个，卡片是换上的 + 备选（不重复）', async () => {
  const got = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', c => b += c); req.on('end', () => {
      got.push({ m: req.method, u: req.url, tok: req.headers['x-claclaw-local'], b });
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'clth-'));
  fs.writeFileSync(path.join(home, 'local.json'), JSON.stringify({ url: 'http://127.0.0.1:' + srv.address().port, token: 'tk' }));
  const out = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [BIN, 'set', '深色', '--alt', '酉,深色,丑'], { env: { ...process.env, CLACLAW_HOME: home } });
    let o = ''; p.stdout.on('data', c => o += c); p.on('close', c => c === 0 ? resolve(o) : reject(new Error(o)));
  });
  srv.close(); fs.rmSync(home, { recursive: true, force: true });
  assert.equal(got.length, 1);
  assert.deepEqual([got[0].m, got[0].u, got[0].tok, JSON.parse(got[0].b).theme], ['POST', '/api/local/theme', 'tk', 'dark']);
  assert.match(out, /已换成「阴黑暗沉」/);
  assert.deepEqual(ids(out), ['dark', 'shichen@9', 'shichen@1']);
});

// 服务器那半：src/theme.mjs
function ctl() {
  let p = { theme: 'ziwei', lang: 'en' }; const sent = [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clbg-'));
  const c = makeTheme({ dir, prefs: () => ({ ...p }), save: n => { p = n; }, notify: o => sent.push(o), sips: '/nonexistent-sips' });
  return { c, dir, sent, prefs: () => p };
}
test('换主题：存进个人设置（别的设置不动）、发通知、带 themeAt；不认的主题不存', () => {
  const { c, sent, prefs } = ctl();
  const r = c.set({ theme: 'shichen@6' });
  assert.equal(r.ok, true); assert.equal(r.theme, 'shichen@6');
  assert.equal(prefs().lang, 'en'); assert.equal(prefs().scZ, '6'); assert.ok(prefs().themeAt);
  assert.deepEqual({ ...sent[0], at: 0 }, { t: 'theme', theme: 'shichen', scZ: '6', img: '', bg: '', fit: '', at: 0 });
  c.set({ theme: 'auto' }); assert.equal(prefs().theme, undefined); assert.equal(prefs().scZ, undefined);
  for (const bad of ['purple', 'light@3', 'shichen@12', '']) assert.equal(c.set({ theme: bad }).ok, false);
  assert.equal(sent.length, 2);
});
test('背景图：文件存成内容哈希名、主题换成时辰、开图；last 用最近发的图；reset / fit / img off', () => {
  const { c, dir, sent, prefs } = ctl();
  const png = path.resolve('public/icons/icon-192.png');
  let r = c.set({ bg: png, fit: 'center' });
  assert.equal(r.ok, true, r.error);
  assert.match(prefs().bg, /^[0-9a-f]{12}\.png$/); assert.ok(fs.existsSync(path.join(dir, prefs().bg)));
  assert.deepEqual([prefs().theme, prefs().scZ, prefs().scImg, prefs().bgFit], ['shichen', '3', '1', 'center']);
  assert.equal(sent.at(-1).bg, prefs().bg); assert.equal(sent.at(-1).fit, 'center');
  assert.equal(c.set({ bg: png, theme: 'dark' }).ok, false);   // 背景图只配时辰主题
  assert.equal(c.set({ bg: 'last' }).ok, false);              // 还没人发过图
  c.lastImage({ media_type: 'image/png', data: fs.readFileSync(png).toString('base64') });
  r = c.set({ bg: 'last', theme: 'shichen@4' });
  assert.equal(r.ok, true); assert.equal(r.lastAgo, 0); assert.equal(prefs().scZ, '4');
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('.')), []);   // 临时文件删了
  assert.equal(c.set({ bg: path.join(dir, 'nope.jpg') }).ok, false);
  assert.equal(c.set({ bg: path.resolve('package.json') }).ok, false);
  c.set({ fit: 'cover' }); assert.equal(prefs().bgFit, undefined);
  c.set({ img: 'off' }); assert.equal(prefs().scImg, undefined);
  c.set({ bg: 'reset' }); assert.equal(prefs().bg, undefined);
  assert.deepEqual(c.state(), { theme: 'shichen@4', img: 'off', bg: 'default', fit: 'cover' });
  fs.rmSync(dir, { recursive: true, force: true });
});
