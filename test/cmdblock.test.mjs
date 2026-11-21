// 命令块：把 public/index.html 里的命令块模块（和朗读去 Markdown 的 ttsStrip）原样抽出来测：分条、复制文字、下载成脚本、朗读提示
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const cut = (a, b) => { const i = html.indexOf(a), j = html.indexOf(b, i); assert.ok(i >= 0 && j > i, '找不到 ' + a); return html.slice(i, j); };
const ctx = { COPY_ICON: '<svg></svg>', esc: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;') };
vm.createContext(ctx);
vm.runInContext(cut('// ---------- 命令块：', '// ---------- 命令块完') + cut('function ttsStrip(', 'function ttsText('), ctx);
const { cmdParse, cmdScript, codeSay, mdCode, ttsStrip } = ctx;
const plain = x => JSON.parse(JSON.stringify(x));   // vm 里的数组换成本地的，deepEqual 才认
const cmds = (code, kind) => plain(cmdParse(code, kind).cmds.map(c => c.text));
const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

test('bash：一行一条；空行、注释不算；续行、末尾 && / |、heredoc、跨行的 for / if / 函数算一条', () => {
  assert.deepEqual(cmds('# 装 node\nbrew install node\n\nnode -v', 'sh'), ['brew install node', 'node -v']);
  assert.deepEqual(cmds('docker run \\\n  -p 80:80 \\\n  nginx\nls', 'sh'), ['docker run \\\n  -p 80:80 \\\n  nginx', 'ls']);
  assert.deepEqual(cmds('make &&\n  make install\nls |\n  wc -l', 'sh'), ['make &&\n  make install', 'ls |\n  wc -l']);
  assert.deepEqual(cmds("cat > a.txt <<'EOF'\nfor x in 1\nEOF\nls", 'sh'), ["cat > a.txt <<'EOF'\nfor x in 1\nEOF", 'ls']);
  assert.deepEqual(cmds('for f in *.txt; do\n  echo "$f" # for\ndone\nif [ -f x ]; then\n  rm x\nfi', 'sh'), ['for f in *.txt; do\n  echo "$f" # for\ndone', 'if [ -f x ]; then\n  rm x\nfi']);
  assert.deepEqual(cmds('for f in *; do echo $f; done\necho "wait for it"\nhi() {\n  echo hi\n}', 'sh'), ['for f in *; do echo $f; done', 'echo "wait for it"', 'hi() {\n  echo hi\n}']);
  assert.deepEqual(cmds('cat <<< "x"\nls', 'sh'), ['cat <<< "x"', 'ls']);   // here-string 不是 heredoc
  const p = cmdParse('# a\nls\n\npwd', 'sh');
  assert.deepEqual(plain(p.rows.map(r => r.g)), [-1, 0, -1, 1]);
});

test('PowerShell / cmd / console：各自的注释、续行和块', () => {
  assert.deepEqual(cmds('# 看 IP\nGet-NetIPAddress |\n  Where-Object AddressFamily -eq IPv4\n<#\n说明\n#>\nGet-Service `\n  -Name w*\nif ($x) {\n  echo 1\n}', 'ps'),
    ['Get-NetIPAddress |\n  Where-Object AddressFamily -eq IPv4', 'Get-Service `\n  -Name w*', 'if ($x) {\n  echo 1\n}']);
  assert.deepEqual(cmds('REM 注释\n:: 也是注释\nipconfig /all\nif exist a (\n  del a\n)\necho a ^\n b', 'bat'), ['ipconfig /all', 'if exist a (\n  del a\n)', 'echo a ^\n b']);
  assert.deepEqual(cmds('$ ls -l\ntotal 0\n$ echo hi\nhi\nPS C:\\> dir', 'con'), ['ls -l', 'echo hi', 'dir']);   // 只认提示符开头的行，复制时去掉提示符
});

test('渲染：两条以上才逐条加复制图标和头部；一条的照旧；代码原文（textContent）不变；data-c 是这条的完整命令', () => {
  const one = mdCode('brew install node', 'bash');
  assert.doesNotMatch(one, /class="cbl"|cb-h/); assert.match(one, /class="cp"/);
  const code = '# 装\nbrew install node\n\ndocker run \\\n  nginx "a<b>"';
  const h = mdCode(code, 'bash');
  assert.match(h, /class="cb cbc" data-lang="bash"/);
  assert.equal((h.match(/class="lcp"/g) || []).length, 2);
  assert.match(h, /bash · 2 条命令/);
  assert.match(h, /title="下载成脚本 brew-install-node\.sh"/);
  const pre = h.slice(h.indexOf('<pre><code>') + 11, h.indexOf('</code></pre>'));
  assert.equal(unesc(pre.replace(/<button[^]*?<\/button>/g, '').replace(/<[^>]+>/g, '')), code);
  const dc = [...h.matchAll(/data-c="([^"]*)"/g)].map(m => unesc(m[1]));
  assert.deepEqual([...new Set(dc)], ['brew install node', 'docker run \\\n  nginx "a<b>"']);
  assert.doesNotMatch(mdCode('a = 1\nb = 2', 'python'), /class="cbl"/);   // 不是命令的语言照旧
  assert.doesNotMatch(mdCode('ls\npwd', 'console'), /class="cdl"/);       // 终端记录能逐条复制、不给下载
});

test('下载成脚本：.sh 补 #!（zsh 用 zsh）、.ps1 带 BOM 和 CRLF、.bat 用 CRLF 且有中文先切代码页；文件名取命令；一条的不给', () => {
  const sh = cmdScript('sudo apt update\nsudo apt install -y git', 'bash');
  assert.equal(sh.name, 'apt-update.sh'); assert.equal(sh.text, '#!/usr/bin/env bash\nsudo apt update\nsudo apt install -y git\n');
  assert.equal(cmdScript('#!/bin/sh\nls\npwd', 'sh').text, '#!/bin/sh\nls\npwd\n');
  assert.match(cmdScript('cd ~/x\nnpm install\nnpm start', 'zsh').text, /^#!\/usr\/bin\/env zsh\n/);
  assert.equal(cmdScript('cd ~/x\nnpm install\nnpm start', 'zsh').name, 'npm-install.sh');
  const ps = cmdScript('Get-Service\nGet-Process', 'powershell');
  assert.equal(ps.name, 'get-service.ps1'); assert.equal(ps.text, '\ufeffGet-Service\r\nGet-Process\r\n');
  const bat = cmdScript('ipconfig /all\necho 完成', 'cmd');
  assert.equal(bat.name, 'ipconfig.bat'); assert.equal(bat.text, '@chcp 65001 >nul\r\nipconfig /all\r\necho 完成\r\n');
  assert.equal(cmdScript('ipconfig\nping x', 'bat').text, 'ipconfig\r\nping x\r\n');
  assert.equal(cmdScript('curl -fsSL https://x/y | sh\n./y', 'bash').name, 'curl.sh');
  assert.equal(cmdScript('"$HOME/a"\n./b', 'bash').name, 'commands.sh');
  assert.equal(cmdScript('ls', 'bash'), null);
  assert.equal(cmdScript('ls\npwd', 'console'), null);
  assert.equal(cmdScript('a\nb', 'python'), null);
});

test('朗读：代码块不念「代码略」——命令块说几条命令，别的说几行代码，卡片块不提', () => {
  assert.equal(codeSay('ls\n# x\npwd', 'bash'), '，下面有两条命令，');
  assert.equal(codeSay('ls', 'sh'), '，下面有一条命令，');
  assert.equal(codeSay('a=1\n\nb=2\nc=3', 'python'), '，下面有三行代码，');
  assert.equal(codeSay('x', 'tv'), '，');
  assert.equal(codeSay(Array(12).fill('ls').join('\n'), 'bash'), '，下面有12条命令，');
  assert.match(mdCode('ls\npwd', 'bash'), /data-say="，下面有两条命令，"/);
  const s = ttsStrip('先装好：\n```bash\nbrew install node\nnode -v\n```\n再看：\n```js\nconsole.log(1)\n```\n');
  assert.match(s, /先装好：\n，下面有两条命令，\n再看：\n，下面有一行代码，/);
  assert.doesNotMatch(s, /代码略|brew/);
});
