// 备料：把打包要用的 claclaw 程序和 Node 运行时放进 desktop/dist/stage/，再由 electron-builder 打成安装包
//   dist/stage/server：仓库里的程序文件（git ls-files，不要测试、安装脚本、桌面版自己）+ npm install --omit=dev 装好的依赖
//   dist/stage/node：官方 Node 运行时（带 npm），下载后按 SHASUMS256 校验
// 要在目标系统上跑：依赖里有分平台的程序（Claude Code、node-datachannel），npm 只装本机平台的那份。
// 国内网络：设 CLACLAW_NODE_MIRROR=https://npmmirror.com/mirrors/node 、npm_config_registry=https://registry.npmmirror.com
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STAGE = path.join(HERE, 'dist', 'stage');
const NODE_MAJOR = 24;
const MIRROR = (process.env.CLACLAW_NODE_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '');
const WIN = process.platform === 'win32';
const say = s => console.log('>> ' + s);
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', shell: WIN && /\.cmd$/i.test(cmd), ...opts });

// 打进安装包的程序文件：仓库里受版本管理的，去掉这些
const SKIP = [/^desktop\//, /^test\//, /^install\//, /^probe\//, /^\.github\//, /^tools\/icon-concepts\.py$/, /^public\/icons\/concept-/];

async function get(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(url + ' → HTTP ' + r.status);
  return Buffer.from(await r.arrayBuffer());
}

function stageServer() {
  const dir = path.join(STAGE, 'server');
  fs.rmSync(dir, { recursive: true, force: true });
  const files = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(f => f && !SKIP.some(r => r.test(f)));
  for (const f of files) {
    const src = path.join(ROOT, f), dst = path.join(dir, f);
    if (!fs.existsSync(src)) continue;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  say(`程序文件 ${files.length} 个 → ${dir}`);
  const npm = WIN ? 'npm.cmd' : 'npm';
  run(npm, ['ci', '--omit=dev', '--no-audit', '--no-fund'], { cwd: dir });
  // 桌面安装包面向国内用户、只照顾国内的 Agent，不带 Claude Code 本体（@anthropic-ai/claude-agent-sdk-<平台>，两三百 MB）；
  // 要用 Claude 的话，claclaw 会改用电脑上装的 claude 命令
  const A = path.join(dir, 'node_modules', '@anthropic-ai');
  for (const d of fs.existsSync(A) ? fs.readdirSync(A) : []) if (/^claude-agent-sdk-/.test(d)) { fs.rmSync(path.join(A, d), { recursive: true, force: true }); say('不带 Claude Code：删掉 @anthropic-ai/' + d); }
}

async function stageNode() {
  const dir = path.join(STAGE, 'node');
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const index = JSON.parse((await get(MIRROR + '/index.json')).toString());
  const v = index.find(x => x.version.startsWith('v' + NODE_MAJOR + '.')).version;
  const name = WIN ? `node-${v}-win-${arch}.zip` : `node-${v}-${process.platform}-${arch}.tar.gz`;
  if (fs.existsSync(path.join(dir, '.version')) && fs.readFileSync(path.join(dir, '.version'), 'utf8') === name) { say('Node 已备好：' + name); return; }
  say('下载 ' + name);
  const sums = (await get(`${MIRROR}/${v}/SHASUMS256.txt`)).toString();
  const want = (sums.split('\n').find(l => l.trim().endsWith('  ' + name)) || '').split(/\s+/)[0];
  if (!want) throw new Error('SHASUMS256 里没有 ' + name);
  const buf = await get(`${MIRROR}/${v}/${name}`);
  if (crypto.createHash('sha256').update(buf).digest('hex') !== want) throw new Error(name + ' 校验没通过');
  const tmp = path.join(STAGE, name);
  fs.mkdirSync(STAGE, { recursive: true });
  fs.writeFileSync(tmp, buf);
  fs.rmSync(dir, { recursive: true, force: true });
  const ex = path.join(STAGE, 'node-extract');
  fs.rmSync(ex, { recursive: true, force: true });
  fs.mkdirSync(ex, { recursive: true });
  run('tar', ['-xf', tmp, '-C', ex]);   // Windows 10 起自带的 tar 也能解 zip
  fs.renameSync(path.join(ex, name.replace(/\.(zip|tar\.gz)$/, '')), dir);
  fs.rmSync(ex, { recursive: true, force: true });
  fs.rmSync(tmp, { force: true });
  // 用不到的：C 头文件、文档、corepack（只留 node 和 npm）
  for (const x of ['include', 'share', 'CHANGELOG.md', 'README.md', path.join('lib', 'node_modules', 'corepack'), path.join('node_modules', 'corepack'), 'corepack', 'corepack.cmd', path.join('bin', 'corepack')])
    fs.rmSync(path.join(dir, x), { recursive: true, force: true });
  fs.writeFileSync(path.join(dir, '.version'), name);
  say('Node ' + v + ' → ' + dir);
}

// 依赖瘦身：删掉跑起来用不到的文档、类型声明、source map、测试目录。装的时候文件数少一半，杀毒软件逐个扫描也就快一半
const JUNK_FILE = /\.(md|markdown|map|d\.ts|d\.mts|d\.cts)$|^(changelog|history|authors|contributing)(\.(txt|rst))?$|^\.(npmignore|eslintrc.*|prettierrc.*|travis\.yml|editorconfig)$/i;
const KEEP_FILE = /^(licen[cs]e|notice|copying)/i;   // 许可证留着
const JUNK_DIR = new Set(['__tests__', '.github', 'coverage']);
const JUNK_PKG_DIR = new Set(['test', 'tests', 'example', 'examples', 'docs', 'man']);   // 只删包根目录下的（别处同名目录可能是代码）
function prune(root) {
  let n = 0;
  const walk = d => {
    let ents; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    const pkgRoot = ents.some(e => e.isFile() && e.name === 'package.json');
    for (const e of ents) {
      const f = path.join(d, e.name);
      if (e.isDirectory()) {
        if (JUNK_DIR.has(e.name) || (pkgRoot && JUNK_PKG_DIR.has(e.name))) { fs.rmSync(f, { recursive: true, force: true }); n++; }
        else walk(f);
      } else if (JUNK_FILE.test(e.name) && !KEEP_FILE.test(e.name)) { fs.rmSync(f, { force: true }); n++; }
    }
  };
  walk(root);
  say(`瘦身：删了 ${n} 个文件 / 目录（${root}）`);
}

await stageNode();
stageServer();
prune(path.join(STAGE, 'server', 'node_modules'));
for (const d of [path.join('node_modules', 'npm'), path.join('lib', 'node_modules', 'npm')]) if (fs.existsSync(path.join(STAGE, 'node', d))) prune(path.join(STAGE, 'node', d));
say('备料好了；接着 electron-builder 打包');
