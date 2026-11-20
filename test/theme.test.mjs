// claw-theme 技能：主题名 / 别名解析、卡片输出、set 调本机接口；主题库和网页、服务器认的 id 一致
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
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
  const html = fs.readFileSync('public/index.html', 'utf8'), srv = fs.readFileSync('server.mjs', 'utf8');
  const re = new RegExp(srv.match(/const THEME_RE = \/(.+)\/;/)[1].replace(/\\\\/g, '\\'));
  for (const t of THEMES) {
    assert.ok(re.test(t.id), 'server: ' + t.id);
    assert.ok(t.id === 'auto' || t.id === 'shichen' || html.includes("'" + t.id + "':[") || html.includes(t.id + ":['"), 'THP: ' + t.id);
  }
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
