// electron-builder 不肯把 extraResources 里的 node_modules 打进去：打完包后在这里补上 server 的依赖
const fs = require('node:fs');
const path = require('node:path');
exports.default = async function afterPack(ctx) {
  const res = ctx.electronPlatformName === 'darwin'
    ? path.join(ctx.appOutDir, ctx.packager.appInfo.productFilename + '.app', 'Contents', 'Resources')
    : path.join(ctx.appOutDir, 'resources');
  const from = path.join(__dirname, 'dist', 'stage', 'server', 'node_modules');
  const to = path.join(res, 'server', 'node_modules');
  fs.rmSync(to, { recursive: true, force: true });
  fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  console.log('  • afterPack: server/node_modules → ' + to);
};
