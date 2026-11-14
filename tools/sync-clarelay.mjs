// 把 clarelay 仓库的电脑端代码同步进 claclaw/clarelay/（以 clarelay 仓库为准，这里不要直接改）
//   node tools/sync-clarelay.mjs [clarelay 仓库路径，默认 ../clarelay]
// 复制 FILES 里的文件，记下来源提交到 clarelay/SOURCE；列出有变化的文件，提交前自己看一眼 git diff。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.resolve(process.argv[2] || path.join(ROOT, '..', 'clarelay'));
const FROM = path.join(SRC, 'device'), TO = path.join(ROOT, 'clarelay');
const FILES = ['agent.mjs', 'common.mjs', 'acme.mjs', 'x509.mjs', 'rtc.mjs', 'rtc-client.js', 'rtc-sw.js', 'rtc-test.html'];

if (!fs.existsSync(path.join(FROM, 'agent.mjs'))) { console.error('找不到 ' + FROM + '/agent.mjs：参数给 clarelay 仓库路径'); process.exit(1); }
let commit = '';
try { commit = execFileSync('git', ['-C', SRC, 'log', '-1', '--format=%h %s', '--', 'device'], { encoding: 'utf8' }).trim(); } catch {}
let dirty = '';
try { dirty = execFileSync('git', ['-C', SRC, 'status', '--porcelain', '--', ...FILES.map(f => 'device/' + f)], { encoding: 'utf8' }).trim(); } catch {}
fs.mkdirSync(TO, { recursive: true });
const changed = [];
for (const f of FILES) {
  const a = fs.readFileSync(path.join(FROM, f)), p = path.join(TO, f);
  let b = null; try { b = fs.readFileSync(p); } catch {}
  if (!b || !a.equals(b)) { fs.writeFileSync(p, a); changed.push(f); }
}
fs.writeFileSync(path.join(TO, 'SOURCE'), 'clarelay ' + (commit || '(未知提交)') + (dirty ? '（带未提交的改动）' : '') + '\n');
console.log('来源：clarelay ' + (commit || '?') + (dirty ? '\n注意：clarelay 里这些文件有未提交的改动：\n' + dirty : ''));
console.log(changed.length ? '有变化：' + changed.join('、') : '没有变化');
