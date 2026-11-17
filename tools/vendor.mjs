// 第三方库（vendor/，见 vendor/README.md）
//   node tools/vendor.mjs                                   列出已装的库
//   node tools/vendor.mjs install <库> <https://下载地址> [--key 发布公钥]
//                                                           下载、验签、核对、装上（已是最新就不动，不降级）；
//                                                           公钥默认用加入 clarelay 时记下的（数据目录 clarelay-release-keys.json，按域名）
//   node tools/vendor.mjs install <库> --src <本机目录>       从本机目录装（开发用，比如 ../clarelay/client；不验签，标成「未签名」）
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { LIBS, libInfo, libInstall, vendorRoot, releaseKeyOk } from '../vendor.mjs';

const [cmd, id, src] = process.argv.slice(2);
const die = m => { console.error(m); process.exit(1); };

if (!cmd) {
  console.log('目录：' + vendorRoot());
  for (const k of Object.keys(LIBS)) { const i = libInfo(k); console.log(k.padEnd(10) + (i.installed ? i.version + (i.signed ? '' : '（未签名）') + '  来自 ' + i.from + '  ' + new Date(i.at).toLocaleString('zh-CN', { hour12: false }) : '没装') + '  （' + i.name + '）'); }
  process.exit(0);
}
if (cmd !== 'install' || !LIBS[id] || !src) die('用法：node tools/vendor.mjs install <' + Object.keys(LIBS).join('|') + '> <https://下载地址 | --src 本机目录>');

let base = src, srv = null;
if (src === '--src') {
  // 本机目录：临时在 127.0.0.1 上按清单格式提供一遍，走和网上下载同一条路（核对 sha256、换版本目录）
  const dir = path.resolve(process.argv[5] || die('--src 后面给目录'));
  const L = LIBS[id], files = {}, body = {};
  for (const f of fs.readdirSync(dir)) if (/\.(mjs|js)$/.test(f) && fs.statSync(path.join(dir, f)).isFile()) { body[f] = fs.readFileSync(path.join(dir, f)); files[f] = crypto.createHash('sha256').update(body[f]).digest('hex'); }
  let version = 'local';
  try { version = /VERSION\s*=\s*'([^']+)'/.exec(body['common.mjs'] || body['tunnel.mjs'])[1] + '-local'; } catch {}
  const routes = { [L.manifest]: Buffer.from(JSON.stringify({ version, files })) };
  for (const f of Object.keys(files)) routes[L.file(f)] = body[f];
  srv = http.createServer((q, r) => { const b = routes[q.url]; r.writeHead(b ? 200 : 404); r.end(b || ''); });
  await new Promise(ok => srv.listen(0, '127.0.0.1', ok));
  base = 'http://127.0.0.1:' + srv.address().port;
}
let pubkeys = [];
if (!srv) {
  const ki = process.argv.indexOf('--key');
  if (ki > 0) pubkeys = [releaseKeyOk(process.argv[ki + 1]) || die('--key 后面的发布公钥格式不对')];
  else {
    const DATA = process.env.CLACLAW_DATA ? path.resolve(process.env.CLACLAW_DATA) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'data');
    let k = ''; try { k = releaseKeyOk(JSON.parse(fs.readFileSync(path.join(DATA, 'clarelay-release-keys.json'), 'utf8'))[new URL(base).hostname]?.key); } catch {}
    if (!k) die('没有记下这个域名的发布公钥：用 --key 给（公钥在设备邀请码里，或那台中继的 PROTOCOL.md §17）');
    pubkeys = [k];
  }
}
try {
  const r = await libInstall(id, base, { log: (...a) => console.log(...a), pubkeys, ...(srv ? { unsigned: true, allowDowngrade: true } : {}) });
  console.log((r.changed ? '装好：' : '已经是这个版本：') + id + ' ' + r.info.version + (r.info.signed ? '' : '（未签名）'));
  console.log('正在运行的 claclaw：宿主页 clarelay 点「更新」或重启后用上');
} catch (e) { console.error('没装上：' + e.message); process.exitCode = 1; }
finally { srv?.close(); }
