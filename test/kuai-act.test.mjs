// kuAi 动手档（L4）用的几样：换一段、对比、写文件、经 shell 跑命令（macOS 上的沙箱）
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { editText, miniDiff, headOf, linesOf, utf8Of, writeAtomic, sbProfile, runShell, hasSandbox } from '../src/claws/kuai-act.mjs';

const WIN = process.platform === 'win32';

test('kuAi 换一段（edit）：一模一样、只出现一次才换；出现几次要说清楚；CRLF 的文件照 CRLF 写回去；对不上时指出相似的那一行', () => {
  const src = 'function a() {\n  return 1;\n}\nfunction b() {\n  return 1;\n}\n';
  const r = editText(src, 'function a() {\n  return 1;', 'function a() {\n  return 2;');
  assert.equal(r.ok, true); assert.equal(r.text, 'function a() {\n  return 2;\n}\nfunction b() {\n  return 1;\n}\n'); assert.equal(r.at, 1); assert.equal(r.count, 1);
  // 出现两次：不改，说出现了几次；all 才全换
  const two = editText(src, '  return 1;', '  return 3;');
  assert.equal(two.ok, false); assert.match(two.why, /出现了 2 次/);
  const all = editText(src, '  return 1;', '  return 3;', true);
  assert.equal(all.count, 2); assert.equal(all.text.match(/return 3/g).length, 2);
  // new 里的 $& $1 不当替换符号
  assert.equal(editText('a = 1\n', 'a = 1', 'a = "$&$1"').text, 'a = "$&$1"\n');
  // CRLF：模型写的是 LF，照样对得上，写回去还是 CRLF
  const crlf = editText('x = 1\r\ny = 2\r\n', 'x = 1\ny = 2', 'x = 1\ny = 3');
  assert.equal(crlf.ok, true); assert.equal(crlf.text, 'x = 1\r\ny = 3\r\n');
  // 对不上：缩进不一样 → 指出第几行；压根没有 → 让它先 read
  const off = editText(src, 'function b() {\n    return 1;', 'x');
  assert.equal(off.ok, false); assert.match(off.why, /第 4 行有相似的内容/); assert.match(off.why, /先 read 第 \d+-\d+ 行/);
  assert.match(editText(src, 'nothing here', 'x').why, /文件里没有这段/);
  // 空的 old、一样的、没写 new
  assert.match(editText(src, '', 'x').why, /old 是空的/); assert.match(editText(src, 'function', 'function').why, /一样/); assert.match(editText(src, 'function a', undefined).why, /没写 new/);
  // 删掉一段
  assert.equal(editText('a\nb\nc\n', 'b\n', '').text, 'a\nc\n');
  // 全部替换以后大得离谱的不改（2 MB 的文件每个换行换成几百字，一次能写出几百 MB）
  assert.match(editText('\n'.repeat(100000), '\n', 'x'.repeat(200) + '\n', true).why, /改完以后文件会超过 2048 KB/);
});

test('kuAi 改动的对比：只列变了的那几行，前后各带两行；长的截断；新文件列开头', () => {
  const a = Array.from({ length: 10 }, (_, i) => 'line ' + (i + 1)).join('\n') + '\n', b = a.replace('line 5', 'LINE five').replace('line 6\n', '');
  const d = miniDiff(a, b);
  assert.equal(d.text, '@@ 第 5 行起 @@\n  line 3\n  line 4\n- line 5\n- line 6\n+ LINE five\n  line 7\n  line 8');
  assert.deepEqual([d.del, d.add, d.at], [2, 1, 5]);
  assert.equal(miniDiff(a, a).text, '（内容没有变化）');
  // 往后接着写：只有加的
  const app = miniDiff('a\nb\n', 'a\nb\nc\nd\n');
  assert.equal(app.text, '@@ 第 3 行起 @@\n  a\n  b\n+ c\n+ d'); assert.deepEqual([app.del, app.add], [0, 2]);
  // 很多行：每边最多列一部分，说还有多少
  const big = miniDiff(Array.from({ length: 200 }, (_, i) => 'o' + i).join('\n'), Array.from({ length: 200 }, (_, i) => 'n' + i).join('\n'));
  assert.match(big.text, /- …（还有 172 行）/); assert.match(big.text, /\+ …（还有 172 行）/); assert.ok(big.text.split('\n').length < 70);
  assert.equal(big.cut, true); assert.equal(d.cut, false);   // 没显示全的要认得出来（确认条上得告诉用户）
  const wide = miniDiff('x'.repeat(500) + '\n', 'y\n');   // 一行太长也截，写明还有多少
  assert.equal(wide.text.split('\n')[1], '- ' + 'x'.repeat(200) + '…（这一行还有 300 字）'); assert.equal(wide.cut, true);
  assert.deepEqual(headOf('a\nb\nc\n', { max: 2 }), { text: '+ a\n+ b\n+ …（还有 1 行）', cut: true });
  assert.deepEqual(headOf('a\nb\n'), { text: '+ a\n+ b', cut: false }); assert.equal(headOf('a\n' + 'w'.repeat(300) + '\n').cut, true);
  // 整段也有上限（确认条那边 4000 字就截了，要留在它里面）
  const fat = headOf(Array.from({ length: 40 }, () => 'z'.repeat(190)).join('\n'));
  assert.ok(fat.text.length < 3800); assert.match(fat.text, /\n…（后面还有 \d+ 字没显示）$/); assert.equal(fat.cut, true);
  assert.equal(linesOf('a\nb\n'), 2); assert.equal(linesOf('a\nb'), 2); assert.equal(linesOf(''), 0);
});

test('kuAi 写文件：先写临时文件再改名，权限位不变；不是 UTF-8 的认得出来', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-act-')), f = path.join(d, 'run.sh');
  fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  writeAtomic(f, '#!/bin/sh\necho hi\n');
  assert.equal(fs.readFileSync(f, 'utf8'), '#!/bin/sh\necho hi\n');
  if (!WIN) assert.equal(fs.statSync(f).mode & 0o777, 0o755);
  writeAtomic(path.join(d, 'new.txt'), '新的\n');
  assert.deepEqual(fs.readdirSync(d).sort(), ['new.txt', 'run.sh']);   // 没留下临时文件
  assert.throws(() => writeAtomic(path.join(d, 'no', 'such', 'x.txt'), 'x'));
  // 只读的文件不换掉（改名本来能绕过只读）
  if (!WIN && process.getuid?.() !== 0) { const ro = path.join(d, 'ro.txt'); fs.writeFileSync(ro, 'keep\n', { mode: 0o444 }); assert.throws(() => writeAtomic(ro, 'x\n'), /EACCES/); assert.equal(fs.readFileSync(ro, 'utf8'), 'keep\n'); }
  assert.equal(utf8Of(Buffer.from('中文')), '中文'); assert.equal(utf8Of(Buffer.from([0xd6, 0xd0, 0xce, 0xc4])), null);   // GBK 的「中文」
});

test('kuAi 经 shell 跑命令：管道能用，退出码、超时（连它起的子进程一起杀）、输出太多都有交代', { timeout: 30000, skip: WIN }, async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sh-')));
  fs.writeFileSync(path.join(d, 'a.txt'), 'x\ny\nz\n');
  const env = { PATH: process.env.PATH, HOME: d };
  const r = await runShell('cat a.txt | wc -l; echo "$KUAI_API_KEY-"', { cwd: d, env });
  assert.equal(r.code, 0); assert.match(r.out, /^\s*3\n-\n$/);   // 管道能用；环境变量只有给的那几个
  assert.equal((await runShell('echo oops >&2; exit 3', { cwd: d, env })).code, 3);
  // 超时：前台的 sleep 和它放到后台的都杀掉
  const t0 = Date.now(), slow = await runShell('(sleep 30; echo late > late.txt) & sleep 30', { cwd: d, env, ms: 500 });
  assert.ok(Date.now() - t0 < 5000); assert.match(slow.note, /^超过 1 秒，停掉了；它自己另外起的后台进程可能还留着$/); assert.notEqual(slow.code, 0);
  // 输出太多：停掉
  const many = await runShell('yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', { cwd: d, env, maxOut: 20000 });
  assert.match(many.note, /输出太多/);
  // 命令自己退了、放到后台的还占着输出：不等它
  const t1 = Date.now(), bg = await runShell('sleep 20 & echo started', { cwd: d, env });
  assert.equal(bg.code, 0); assert.match(bg.out, /started/); assert.ok(Date.now() - t1 < 5000);
  // 停掉这一轮
  const ac = new AbortController(); setTimeout(() => ac.abort(), 200);
  const t2 = Date.now(); await runShell('sleep 30', { cwd: d, env, signal: ac.signal }); assert.ok(Date.now() - t2 < 5000);
  // 另起了进程组、不停往外写的：杀不到它，但命令返回以后不再读它的输出——它一写就收到 SIGPIPE 退了，不会拖着这个进程空转
  const fl = await runShell('set -m; yes floodfloodfloodfloodflood & echo $! > pid.txt; sleep 0.3; echo done', { cwd: d, env, maxOut: 20000 });
  assert.match(fl.note, /输出太多/);
  const pid = Number(fs.readFileSync(path.join(d, 'pid.txt'), 'utf8'));
  await new Promise(r => setTimeout(r, 800));
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
  // 命令正常返回、留在后台的进程接着写：不算进结果里，也不会因为写得多被杀（写到 1 MB 才关管道）
  const quiet = await runShell('(sleep 0.6; echo later; sleep 0.3; echo ok > alive.txt) & echo started', { cwd: d, env });
  assert.equal(quiet.out, 'started\n'); await new Promise(r => setTimeout(r, 1500)); assert.equal(fs.existsSync(path.join(d, 'alive.txt')), true);
});

test('kuAi 沙箱（macOS）：deny 里的目录读不了也写不了（换个写法、从链接绕也不行），别的进程的信息看不了；别的照常', { timeout: 30000, skip: !hasSandbox() }, async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sb-'))), secret = path.join(d, 'data'), work = path.join(d, 'work');
  fs.mkdirSync(secret); fs.mkdirSync(work);
  fs.writeFileSync(path.join(secret, 'models.json'), 'SECRET_MARK\n'); fs.writeFileSync(path.join(d, 'cred file'), 'SECRET_TWO\n'); fs.writeFileSync(path.join(work, 'a.txt'), 'fine\n');
  const o = { cwd: work, env: { PATH: process.env.PATH, HOME: d }, sandbox: true, deny: [secret, path.join(d, 'cred file')] };
  assert.match(sbProfile(o.deny), /^\(version 1\)\(allow default\)\(deny file-read\* file-write\* \(subpath "[^"]+\/data"\) \(subpath "[^"]+\/cred file"\)\)\(deny file-read\* file-write\* network-outbound [^\n]+\(deny process-info\* \(target others\)\)\(deny signal\)\(allow signal \(target same-sandbox\)\)\(deny lsopen\)\(deny appleevent-send\)\(deny mach-lookup \(global-name "com\.apple\.pasteboard\.1"\)\)$/);
  const r = await runShell('cat a.txt; cat ../da*/models.json; ln -s ../data lnk; cat lnk/models.json; cat "../cred file"; echo x > ../data/new.txt; ls ../data; echo done', o);
  assert.match(r.out, /^fine\n/); assert.match(r.out, /done\n$/);
  assert.doesNotMatch(r.out, /SECRET_MARK|SECRET_TWO/); assert.ok(r.out.match(/Operation not permitted/g).length >= 4);
  assert.deepEqual(fs.readdirSync(secret), ['models.json']);
  // 别的进程的环境变量（里面有 key）看不了
  const ps = await runShell('ps eww -p ' + process.pid + ' 2>&1; echo rc=$?', o);
  assert.doesNotMatch(ps.out, /PATH=/); assert.match(ps.out, /rc=[1-9]/);
  // 平常的活照常干：写会话目录、起 node
  const ok = await runShell('echo hi > b.txt && cat b.txt && "' + process.execPath + '" -e "console.log(6*7)"', o);
  assert.equal(ok.code, 0); assert.equal(ok.out, 'hi\n42\n');
  // 路径里带引号也不会把规则写坏
  assert.match(sbProfile(['/tmp/a"b\\c']), /\(subpath "\/tmp\/a\\"b\\\\c"\)/);
});

test('kuAi 沙箱（macOS）：只有会话目录、临时目录、缓存能写；主目录下隐藏的和 Library 默认读不了（放开的除外）；装着的程序不能写；信号发不出去、起不了别的程序', { timeout: 30000, skip: !hasSandbox() }, async () => {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'kuai-sb2-'))), home = path.join(d, 'home'), work = path.join(home, 'work'), app = path.join(d, 'app'), tmp = path.join(d, 'tmp');
  for (const x of [work, app, tmp, path.join(home, '.ssh'), path.join(home, '.nvm'), path.join(home, 'Library', 'Keychains'), path.join(home, 'Library', 'Caches'), path.join(home, 'docs')]) fs.mkdirSync(x, { recursive: true });
  const put = (p, t) => fs.writeFileSync(path.join(home, p), t);
  put('.zshrc', 'RC_MARK\n'); put('.ssh/id', 'SSH_MARK\n'); put('.nvm/v', 'NVM_OK\n'); put('Library/Keychains/k', 'KC_MARK\n'); put('Library/Caches/c', 'CACHE_OK\n'); put('docs/n.txt', 'DOC_OK\n');
  fs.writeFileSync(path.join(app, 'skill.mjs'), '// skill\n');
  const sb = { deny: [], write: [work, tmp, '/dev', path.join(home, 'Library', 'Caches')], noWrite: [app], home, show: [path.join(home, '.nvm')] };
  const o = { cwd: work, env: { PATH: process.env.PATH, HOME: home, TMPDIR: tmp }, sandbox: sb };
  // 写：会话目录、临时目录、缓存、/dev/null 行；主目录别处、隐藏的启动脚本、LaunchAgents、装着的程序不行
  await runShell(`echo a > a.txt; echo t > "$TMPDIR/t.txt"; echo c > ~/Library/Caches/n; echo y > /dev/null; echo x > ~/out.txt; echo x >> ~/.zshrc; mkdir -p ~/Library/LaunchAgents; echo x > ~/Library/LaunchAgents/a.plist; echo x >> "${app}/skill.mjs"; echo x > ~/docs/n.txt`, o);
  assert.deepEqual([path.join(work, 'a.txt'), path.join(tmp, 't.txt'), path.join(home, 'Library', 'Caches', 'n')].map(f => fs.existsSync(f)), [true, true, true]);
  assert.deepEqual([path.join(home, 'out.txt'), path.join(home, 'Library', 'LaunchAgents')].map(f => fs.existsSync(f)), [false, false]);
  assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'RC_MARK\n'); assert.equal(fs.readFileSync(path.join(app, 'skill.mjs'), 'utf8'), '// skill\n'); assert.equal(fs.readFileSync(path.join(home, 'docs', 'n.txt'), 'utf8'), 'DOC_OK\n');
  // 读：隐藏的、Library 里的读不了；放开的（.nvm、缓存）、不隐藏的、装着的程序读得了
  const r = await runShell(`cat ~/.zshrc ~/.ssh/id ~/Library/Keychains/k; cat ~/.nvm/v ~/Library/Caches/c ~/docs/n.txt "${app}/skill.mjs"`, o);
  assert.doesNotMatch(r.out, /RC_MARK|SSH_MARK|KC_MARK/); assert.match(r.out, /NVM_OK\nCACHE_OK\nDOC_OK\n\/\/ skill\n$/);
  // 会话开在主目录：能写主目录了，隐藏的照样读不了、写不了
  const r2 = await runShell('echo x > ok.txt; echo x >> .zshrc; cat .zshrc .ssh/id; cat .nvm/v', { ...o, cwd: home, sandbox: { ...sb, write: [home, tmp, '/dev'] } });
  assert.equal(fs.existsSync(path.join(home, 'ok.txt')), true); assert.equal(fs.readFileSync(path.join(home, '.zshrc'), 'utf8'), 'RC_MARK\n');
  assert.doesNotMatch(r2.out, /RC_MARK|SSH_MARK/); assert.match(r2.out, /NVM_OK\n$/);
  // 信号：给外面的进程（父进程就是 node——SIGUSR1 会打开调试口）发不出去，自己起的子进程照常能杀；open 起不了程序
  let got = 0; const on = () => got++; process.on('SIGUSR2', on);
  const r3 = await runShell('kill -USR2 $PPID 2>&1; kill -0 ' + process.pid + ' 2>&1; sleep 5 & kill $! && echo own-ok; open -g -j /System/Applications/Calculator.app 2>&1; echo rc=$?', o);
  await new Promise(x => setTimeout(x, 200)); process.off('SIGUSR2', on);
  assert.equal(got, 0); assert.equal(r3.out.match(/Operation not permitted/g).length, 2); assert.match(r3.out, /own-ok\n/); assert.match(r3.out, /failed with error/); assert.match(r3.out, /rc=[1-9]\n$/);
});
