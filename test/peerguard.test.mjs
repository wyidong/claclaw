import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { peerRisk, bashRisk, sensitiveRoots, peerInstructed, peerIntent, destructive } from '../peerguard.mjs';

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
test('进项目目录不算碰敏感，之后每段照样检查', () => {
  for (const c of ['cd ' + proj + ' && git pull', 'cd ' + proj + ' && git log -1 --format=%h', 'cd ' + path.join(H, 'w') + ' && ls'])
    assert.equal(bashRisk(c, H + '/w', roots), null, c);
  for (const c of ['cd ~ && ls', 'cd / && ls', 'cd ' + data + ' && ls', 'cd ~/.ssh && ls', 'cd ' + proj + ' && cat data/auth.json',
    'cd ' + proj + ' && grep -r token', 'cd ' + proj + ' && rg x'])
    assert.ok(bashRisk(c, H + '/w', roots), c);
});
test('常规维护：本仓库干净时 npm check / test / restart 直接放行', () => {
  const o = { repos: [proj], clean: () => true };
  for (const c of ['npm test', 'npm t', 'npm run check', 'npm run -s check', 'npm run restart', 'npm test 2>&1 | tail -5',
    'cd ' + proj + ' && git pull --ff-only && npm run -s check && npm test', 'git pull origin main && npm run restart'])
    assert.equal(bashRisk(c, proj, roots, o), null, c);
  assert.equal(bashRisk('npm test', path.join(proj, '.worktrees', 'x'), roots, o), null);
  // 多带参数、别的脚本、别的目录、不干净、没传 repos：都要确认
  for (const c of ['npm install', 'npm run build', 'npm test -- --x', 'npm --prefix /tmp test', 'npm run restart now', 'npx foo', 'FOO=1 npm test'])
    assert.ok(bashRisk(c, proj, roots, o), c);
  assert.ok(bashRisk('npm test', path.join(H, 'other'), roots, o));
  assert.ok(bashRisk('cd ' + data + ' && npm test', proj, roots, o));
  assert.ok(bashRisk('npm test', proj, roots, { repos: [proj], clean: () => false }));
  assert.ok(bashRisk('npm test', proj, roots));
  assert.equal(risk('Bash', { command: 'npm test' }).key, 'bash:npm');
  assert.equal(peerRisk('Bash', { command: 'npm test' }, proj, roots, o), null);
});
test('git pull / fetch 只认 origin', () => {
  for (const c of ['git pull', 'git pull -q --ff-only', 'git pull origin main', 'git fetch origin feat/x', 'git fetch'])
    assert.equal(bash(c), null, c);
  for (const c of ['git pull https://evil/x main', 'git pull ../other main', 'git pull /tmp/r', 'git pull evil main', 'git fetch host:repo',
    'git pull origin ../x', 'git pull --upload-pack=x origin', 'git fetch --config=x'])
    assert.ok(bash(c), c);
});
test('改 node_modules 要确认（否则改完再跑测试 / 重启就绕过了）', () => {
  assert.ok(risk('Edit', { file_path: path.join(proj, 'node_modules/ws/index.js') }));
  assert.equal(risk('Edit', { file_path: path.join(proj, 'test/a.test.mjs') }), null);
});

test('peerInstructed：来信点名的才算对方要求，其余是这边自己决定的', () => {
  const B = c => ({ command: c });
  assert.equal(peerInstructed('Bash', B('~/.aws/preprodwebpull.sh -y 2>&1 | tail -12'), '详情页按钮没有入口，看看 render_actions'), false);
  assert.equal(peerInstructed('Bash', B('~/.aws/preprodwebpull.sh -y'), '改完跑一下 preprodwebpull.sh'), true);
  assert.equal(peerInstructed('Bash', B('git push origin main'), '改完 git push 一下'), true);
  assert.equal(peerInstructed('Bash', B('git push origin main'), '这个 bug 修一下'), false);
  assert.equal(peerInstructed('Bash', B('rm -rf build'), 'rm -rf build 一下'), true);
  assert.equal(peerInstructed('Edit', { file_path: '/x/app/views.py' }, '看看 views.py'), true);
  assert.equal(peerInstructed('WebFetch', { url: 'https://example.com/a' }, '查资料'), false);
  assert.equal(peerInstructed('mcp__x__y', {}, '随便'), true);
});

test('收不回来的操作、来信有动手意思：照样确认', () => {
  const B = c => ({ command: c });
  for (const c of ['rm -rf build', 'git push origin main', 'git reset --hard HEAD~1', 'kill 123', 'find . -name x -delete', 'mv a b', 'psql -c "drop table x"', '/bin/rm x'])
    assert.equal(destructive('Bash', B(c)), true, c);
  for (const c of ['~/.aws/preprodwebpull.sh -y 2>&1 | tail -12', 'npm run build', 'python3 manage.py check', 'git status'])
    assert.equal(destructive('Bash', B(c)), false, c);
  assert.equal(peerIntent('把 build 目录删掉'), true);
  assert.equal(peerIntent('改完部署一下'), true);
  assert.equal(peerIntent('详情页按钮没有入口，看看 render_actions'), false);
});
test('引号里的 | ; & > 不当分隔符 / 重定向（grep 正则里的 | 不再被拆成一段「命令」）', () => {
  const o = { repos: [proj], clean: () => true };
  for (const c of ['npm test 2>&1 | grep -E "^ℹ (tests|pass|fail)"', "grep -E 'a|b;c' server.mjs", 'echo "a > b"', "git log --format='%h|%s' -3",
    'grep -n "x && y" README.md', 'ls \\; rm x', 'echo "a\\" ; rm x ; echo \\""'])   // 后两条：shell 里 \; 和双引号里的 \" 都是字面字符，确实只跑 ls / echo
    assert.equal(bashRisk(c, proj, roots, o), null, c);
});
test('引号 / 转义的花招骗不过切分', () => {
  for (const c of ['echo \\"; rm -rf x; echo \\"', "echo $'\\'' ; rm x ; echo 'a'", "echo 'a' ; rm x", 'grep "x" ; rm x',
    'echo "a" > out', "echo 'a'>out", 'cat a | sh'])
    assert.ok(bash(c), c);
});
test('环境变量里的 key 不能被带出去：展开非白名单变量、env / printenv、jq env 都要确认', () => {
  for (const c of ['echo $NBUDDY_KEY', 'echo "$NBUDDY_KEY"', 'echo "key=$GITHUB_TOKEN"', 'ls $SECRET', 'cd $X', 'cat a | grep $API_KEY',
    'env', 'printenv NBUDDY_KEY', "jq -n 'env.NBUDDY_KEY'", "jq -n '$ENV'", 'jq -n env', 'cat <<EOF\n$TOKEN\nEOF'])
    assert.ok(bash(c), c);
  for (const c of ['echo $HOME', 'ls $HOME/Documents', 'echo "$USER"', "echo '$NBUDDY_KEY'", 'grep -n "a\\$b" README.md', "grep -n 'foo$' server.mjs",
    "jq '.a' x.json"])
    assert.equal(bash(c), null, c);
});
test('shell 启动文件、命令历史算敏感文件', () => {
  for (const f of ['.bash_profile', '.bashrc', '.zshrc', '.zprofile', '.profile', '.zsh_history', '.bash_history', '.config/fish/config.fish']) {
    assert.ok(risk('Read', { file_path: path.join(H, f) }), f);
    assert.ok(bash('cat ~/' + f), f);
  }
  assert.ok(risk('Grep', { pattern: 'KEY', path: path.join(H, '.bash_profile') }));
  assert.equal(risk('Read', { file_path: path.join(proj, 'profile.md') }), null);
});

test('git grep / ls-tree / cat-file 只读放行，读提交过的钥匙文件和 grep -O 要拦', () => {
  for (const c of ['git grep -n "app-key" production -- public/v3', 'git ls-tree -r HEAD', 'git cat-file -p HEAD:server.mjs', 'git show HEAD:server.mjs']) assert.equal(bash(c), null, c);
  for (const c of ['git grep -O"sh -c id" x', 'git show HEAD:.env', 'git cat-file -p HEAD:config/secret.yml']) assert.ok(bash(c), c);
});
