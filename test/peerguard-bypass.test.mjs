// 审查实测能绕过确认的写法：白名单命令写文件 / 执行、~user 和通配符绕过敏感路径、递归搜索读到 .env
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { peerRisk, bashRisk, sensitiveRoots } from '../peerguard.mjs';

const H = os.homedir();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pg-'));
// 带 .env 的项目、干净的项目（只有 src/a.js）、深层子目录里藏 .env 的项目
const withEnv = path.join(tmp, 'withenv'), clean = path.join(tmp, 'clean'), deep = path.join(tmp, 'deep');
for (const d of [withEnv, path.join(clean, 'src'), path.join(deep, 'a/b/c')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(withEnv, '.env'), 'KEY=x');
fs.writeFileSync(path.join(withEnv, 'server.mjs'), '');
fs.writeFileSync(path.join(clean, 'server.mjs'), '');
fs.writeFileSync(path.join(clean, 'src/a.js'), '');
fs.writeFileSync(path.join(deep, 'a/b/c/.env.local'), 'KEY=x');
fs.writeFileSync(path.join(deep, 'a/x.js'), '');
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const roots = sensitiveRoots(path.join(tmp, 'nodata'));
const bash = (c, cwd = clean) => bashRisk(c, cwd, roots);
const risk = (n, i, cwd = clean) => peerRisk(n, i, cwd, roots);

test('白名单命令写文件 / 执行程序 / 改系统要确认', () => {
  for (const c of ['sort -o src/x.js server.mjs', 'sort --output=x server.mjs', 'sort -uo x server.mjs', 'sort --compress-program=sh server.mjs',
    'uniq server.mjs out.js', 'uniq -c server.mjs out.js', 'uniq - out.js', 'tree -o x.txt', 'tree -aRo x', 'tree -R',
    'rg --pre bash foo .', 'rg --pre=bash foo', 'rg --pre-glob "*.js" foo src', 'rg --hostname-bin=x foo src',
    'date 0101120026', 'date -s "2020-01-01"', 'date --set=x', 'date -u 0101', 'file -C', 'file -C -m x', 'file -bC',
    'git diff --no-index ~/.ssh/id_rsa server.mjs', 'git log -p .env', 'git diff .env', 'git blame .env.local'])
    assert.ok(bash(c), c);
  for (const c of ['sort server.mjs', 'sort -k1,1 -t, -n server.mjs', 'uniq server.mjs', 'uniq -c', 'tree -L 2 src', 'tree -a src',
    'date', 'date +%s', 'date -u +%Y-%m-%dT%H:%M', 'date -Iseconds', 'date -d @0 +%F', 'date -r 0', 'date -j -f %s 0 +%F', 'file server.mjs',
    'file -b src/a.js', 'rg -n foo server.mjs', 'git diff server.mjs', 'git log -p -- src/a.js'])
    assert.equal(bash(c), null, c);
});

test('~user/ 按家目录展开，认不出来的要确认', () => {
  const u = os.userInfo().username;
  for (const c of [`cat ~${u}/.config/gh/hosts.yml`, `cat ~${path.basename(H)}/.ssh/config`, 'cat ~nosuchuser_pg_x/a', 'cat ~-/x', 'ls ~' + u,
    'cd ~nosuchuser_pg_x && ls', 'cat <~/.config/gh/hosts.yml', 'cat < ~/.config/gh/hosts.yml', 'cat x<~/.config/gh/hosts.yml'])
    assert.ok(bash(c), c);
  assert.equal(bash('cat ~+/server.mjs'), null);
  assert.equal(bash('cat ~' + u + '/w/proj/README.md'), null);
});

test('通配符 / 花括号 / 括号绕不过敏感判断', () => {
  for (const c of ['cat ~/.config/g?/hosts.yml', 'cat ~/.ss*/id_rsa', 'cat ~/.config/*/hosts.yml', 'cat /Users/*/.ssh/id_rsa', 'ls /*', 'ls ~/*',
    'grep KEY .env*', 'cat .e*', 'cat .[e]nv', 'cat ./.?nv', 'cat .{e,x}nv', 'cat .env{,}', 'git show HEAD:.{e,x}nv',
    'ls *(e:x:)', 'cat **/.env', 'cd ~/.ss? && ls', 'cat --x=.e*'])
    assert.ok(bash(c, withEnv), c);
  for (const c of ['cat a/b/*/.e*', 'head */*/*/.env*']) assert.ok(bash(c, deep), c);
  // 展开后没有敏感文件、匹配不上：照常放行
  for (const c of ['cat *.mjs', 'wc -l src/*.js', 'ls src/*', 'cat nomatch*', "grep -n 'a*' server.mjs", 'grep -n "x?" server.mjs'])
    assert.equal(bash(c, clean), null, c);
  assert.equal(bash('cat *.mjs', withEnv), null);
});

test('递归搜索：目录里有 .env 就要确认（rg 默认递归）', () => {
  for (const c of ['grep -rn API_KEY .', 'grep -r KEY', 'grep --recursive KEY .', 'grep -d recurse KEY .', 'rg KEY', 'rg -n KEY .', 'egrep -R KEY ' + withEnv])
    assert.ok(bash(c, withEnv), c);
  assert.ok(bash('rg KEY', deep));
  assert.ok(bash('grep -rn KEY a', deep));
  assert.ok(bash('rg KEY ' + withEnv, clean));
  // 干净的目录、只搜文件、不递归：放行
  for (const c of ['grep -rn API_KEY .', 'rg KEY', 'rg -n KEY src', 'grep -r KEY src'])
    assert.equal(bash(c, clean), null, c);
  for (const c of ['rg KEY server.mjs', 'grep -n KEY server.mjs', 'rg -n KEY a/x.js'])
    assert.equal(bash(c, c.includes('a/x') ? deep : withEnv), null, c);
});

test('Grep 工具：glob / type / 目录按敏感文件查', () => {
  assert.ok(risk('Grep', { pattern: 'KEY', path: withEnv }));
  assert.ok(risk('Grep', { pattern: 'KEY' }, withEnv));
  assert.ok(risk('Grep', { pattern: 'KEY', path: deep }));
  assert.ok(risk('Grep', { pattern: 'KEY', path: withEnv, glob: '.env*' }));
  assert.ok(risk('Grep', { pattern: 'KEY', path: clean, glob: '.env' }));
  assert.ok(risk('Grep', { pattern: 'KEY', path: clean, glob: '**/*.pem' }));
  assert.ok(risk('Grep', { pattern: 'KEY', path: clean, type: 'pem' }));
  assert.ok(risk('Grep', { pattern: 'KEY', path: deep, glob: '**/.env*' }));
  assert.equal(risk('Grep', { pattern: 'KEY', path: clean }), null);
  assert.equal(risk('Grep', { pattern: 'KEY', path: withEnv, glob: '*.mjs' }), null);
  assert.equal(risk('Grep', { pattern: 'KEY', path: withEnv, type: 'js' }), null);
  assert.equal(risk('Grep', { pattern: 'KEY', path: path.join(withEnv, 'server.mjs') }), null);
});

test('目录太大或太深：确认', () => {
  const big = path.join(tmp, 'deepdir');
  fs.mkdirSync(path.join(big, 'a/b/c/d/e/f/g/h/i/j'), { recursive: true });
  assert.ok(bash('rg KEY', big));
  assert.ok(risk('Grep', { pattern: 'KEY', path: big }));
});
