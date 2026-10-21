// npm run check —— 提交前的自检（零依赖，不装任何东西）
//   1. 所有 .mjs 过一遍 node --check（语法错就是起不来）
//   2. public/index.html 里的内联脚本抽出来做语法检查（它不在 .mjs 里，node --check 管不到）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', 'data', '.worktrees']);

function mjsFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) mjsFiles(p, out);
    else if (e.name.endsWith('.mjs')) out.push(p);
  }
  return out;
}

let bad = 0;
const files = mjsFiles(ROOT).sort();
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) {
    bad++;
    console.error('✗ 语法错误：' + path.relative(ROOT, f));
    console.error(String(e.stderr || e.message).split('\n').slice(0, 4).join('\n'));
  }
}
console.log(`✓ ${files.length} 个 .mjs 语法检查通过`);

// 内联脚本：<script>…</script>（没有 src 的那种）逐个抽出来做语法检查
const html = path.join(ROOT, 'public', 'index.html');
if (fs.existsSync(html)) {
  const src = fs.readFileSync(html, 'utf8');
  const blocks = [...src.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  blocks.forEach((code, i) => {
    const tmp = path.join(ROOT, '.check-inline-' + i + '.js');
    try {
      fs.writeFileSync(tmp, code);
      execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
    } catch (e) {
      bad++;
      console.error('✗ public/index.html 里的第 ' + (i + 1) + ' 段内联脚本语法错误');
      console.error(String(e.stderr || e.message).split('\n').slice(0, 4).join('\n'));
    } finally {
      try { fs.unlinkSync(tmp); } catch {}
    }
  });
  console.log(`✓ public/index.html 里 ${blocks.length} 段内联脚本语法检查通过`);
}

process.exit(bad ? 1 : 0);
