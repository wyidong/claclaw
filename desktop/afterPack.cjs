// electron-builder 不肯把 extraResources 里的 node_modules 打进去：打完包后在这里补上
//   - server 的依赖（resources/server/node_modules）
//   - 自带 Node 里的 npm（Windows：resources/node/node_modules；macOS：resources/node/lib/node_modules）：缺了它装不了任何 Claw
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  const mac = ctx.electronPlatformName === 'darwin';
  const res = mac
    ? path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const stage = path.join(__dirname, 'dist', 'stage');
  const copy = (rel) => {
    const from = path.join(stage, rel), to = path.join(res, rel);
    if (!fs.existsSync(from)) return;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
    console.log('  • afterPack: ' + rel + ' → ' + to);
  };
  copy(path.join('server', 'node_modules'));
  const npmMods = mac ? path.join('node', 'lib', 'node_modules') : path.join('node', 'node_modules');
  copy(npmMods);
  const cli = path.join(res, npmMods, 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) throw new Error('安装包里没有 npm（' + cli + '）：装不了 Claw，不出包');
};
