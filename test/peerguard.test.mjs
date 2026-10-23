import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { peerRisk, bashRisk, sensitiveRoots } from '../peerguard.mjs';

const H = os.homedir(), proj = path.join(H, 'w', 'proj'), data = path.join(proj, 'data');
const roots = sensitiveRoots(data);
const bash = c => bashRisk(c, proj, roots);
const risk = (n, i) => peerRisk(n, i, proj, roots);

test('只读命令直接放行', () => {
  for (const c of ['ls', 'git status', 'git log --oneline -5', 'git diff HEAD~1', 'git pull', 'cat README.md', 'sed -n 1,20p server.mjs',
    'grep -n foo server.mjs', 'head -5 src/a.js 2>&1', 'wc -l *.mjs | sort', 'git log -1 >/dev/null'])
    assert.equal(bash(c), null, c);
});
test('有风险的命令要确认', () => {
  for (const c of ['rm -rf x', 'git push origin main', 'git reset --hard', 'npm test', 'node x.mjs', 'curl http://x', 'ls; rm a',
    'ls && sudo x', 'echo hi > a', 'cat $(echo a)', 'cat `x`', 'find . -delete', 'find . -exec rm {} ;', 'sed -i s/a/b/ f',
    'FOO=1 ls', 'git -c core.pager=x log', 'git branch -D x', 'git remote add x y', 'cat a | sh', 'ls & rm a', 'bash x.sh', 'python3 -c 1'])
    assert.ok(bash(c), c);
});
test('读敏感位置要确认，包括上级目录的递归搜索', () => {
  for (const c of ['cat ~/.ssh/id_rsa', 'cat data/auth.json', 'cat .env', 'cd ~/.ssh && ls', 'grep -r token .', 'rg password', 'find .', 'ls ~', 'cat ~/ssh_1.2.3.4.sh'])
    assert.ok(bash(c), c);
  assert.ok(risk('Read', { file_path: path.join(H, '.aws/credentials') }));
  assert.ok(risk('Read', { file_path: path.join(data, 'tokens.json') }));
  assert.ok(risk('Grep', { pattern: 'x' }));            // 默认搜当前目录，里面有 data/
  assert.ok(risk('Grep', { pattern: 'x', path: H }));
  assert.equal(risk('Read', { file_path: path.join(proj, 'server.mjs') }), null);
  assert.equal(risk('Grep', { pattern: 'x', path: path.join(proj, 'public') }), null);
});
test('改文件：项目目录里放行，目录外或敏感文件要确认', () => {
  assert.equal(risk('Edit', { file_path: path.join(proj, 'a.mjs') }), null);
  assert.ok(risk('Write', { file_path: path.join(H, 'x.txt') }));
  assert.ok(risk('Edit', { file_path: path.join(proj, '.git/hooks/pre-commit') }));
  assert.ok(risk('Edit', { file_path: path.join(proj, '.env') }));
  assert.ok(risk('Write', { file_path: path.join(data, 'x.json') }));
});
test('其他工具：联网和未知工具要确认，同类按 key 合并', () => {
  assert.ok(risk('WebFetch', { url: 'http://x' }));
  assert.ok(risk('mcp__claclaw__peer_send', {}));
  assert.equal(risk('TodoWrite', {}), null);
  assert.equal(risk('Bash', { command: 'rm a' }).key, risk('Bash', { command: 'rm -rf b' }).key);
});
