// 第三方库：运行时下载到 vendor/<库>/<版本>-<哈希前 8 位>/，不进 claclaw 版本库（vendor/ 里只提交 README.md 和 .gitignore）。
// 现在只有一个：clarelay 电脑端（单文件 clarelay.mjs，协议见那台中继的 /_relay/PROTOCOL.md §17）。
// - 发布方签名：下载的文件 + 发布方私钥对文件原始字节的 Ed25519 签名（.sig，base64）。公钥由调用方给（clarelay：设备邀请码里带的，
//   或控制连接 hello 里给已加入电脑的，按圈子域名记下，以后只认它）；私钥只在发布方自己电脑上。验不过、没签名就不装。
//   下载地址只负责存文件：它被改了 / 出事了也换不了已经记下公钥的电脑上的代码。
// - 版本：文件第二行注释「// clarelay <版本> …」。不降级（已装的是签过名的，只装更新的；同一版本内容变了照常装），
//   比 LIBS 里的 minVersion 旧的一律不装（新电脑第一次下载也挡住签过名的旧版）。
// - 只从 https 下载（按系统 CA 校验证书、不跟跳转）；本机 127.0.0.1 / localhost 可以用 http（测试）。
// - 验过才写成新的版本目录（先写临时目录再整体改名），最后改 vendor/<库>/current.json 指过去。
// - 每个版本一个目录：已经加载进内存的旧版本照常跑；换新版的地方重新 import 新目录（路径不同，不会拿到缓存里的旧模块）。
// - 保留当前和上一个版本（回退用），更早的删掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const vendorRoot = () => process.env.CLACLAW_VENDOR || path.join(ROOT, 'vendor');

// 已知的第三方库：从哪下（相对下载地址的路径）、装成什么文件名、版本号怎么认、最低版本
export const LIBS = {
  clarelay: {
    name: 'clarelay 电脑端',
    file: '/_relay/client/clarelay.mjs',       // 单文件客户端（startDevice、startTunnel、relayRequest… 都从它导出）
    sig: '/_relay/client/clarelay.mjs.sig',    // 文件原始字节的 Ed25519 签名（base64）
    main: 'clarelay.mjs',
    verRe: /^\/\/ clarelay (\S+) /m,            // 第二行：// clarelay 0.5.2 电脑端（客户端）单文件版…
    minVersion: '0.5.2',                         // 单文件从 0.5.2 开始；比它旧的一律不装
  },
};

const VER_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MAX_FILE = 8 * 1024 * 1024, TIMEOUT = 30e3;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const libOf = id => { const L = LIBS[id]; if (!L) throw new Error('不认识的第三方库：' + id); return L; };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const DIR_RE = /^[0-9A-Za-z][0-9A-Za-z._-]*$/;

// 版本比较：a 比 b 新返回 true（按点分的数字比，非数字部分按字符串）
export function newerVersion(a, b) {
  const x = String(a || '').split(/[.+-]/), y = String(b || '').split(/[.+-]/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? '', q = y[i] ?? '';
    if (p === q) continue;
    if (/^\d+$/.test(p) && /^\d+$/.test(q)) return Number(p) > Number(q);
    return p > q;
  }
  return false;
}
// 发布公钥：只认 Ed25519 SPKI DER 的 base64（60 个字符）；格式不对返回 ''
export function releaseKeyOk(k) {
  k = String(k || '').trim();
  if (!/^[A-Za-z0-9+/]{59}=$/.test(k)) return '';
  try { return crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }).asymmetricKeyType === 'ed25519' ? k : ''; } catch { return ''; }
}
// 签名：任一公钥验得过就算
export function verifySig(bytes, sigB64, pubkeys) {
  const sig = Buffer.from(String(sigB64 || '').trim(), 'base64');
  if (sig.length !== 64) return false;
  for (const k of pubkeys || []) {
    try { if (crypto.verify(null, bytes, crypto.createPublicKey({ key: Buffer.from(k, 'base64'), format: 'der', type: 'spki' }), sig)) return true; } catch {}
  }
  return false;
}
// 文件里写的版本号（没有 / 格式不对返回 ''）
export function fileVersion(id, bytes) {
  const m = libOf(id).verRe.exec(bytes.subarray(0, 4096).toString('utf8'));
  return m && VER_RE.test(m[1]) ? m[1] : '';
}

// 当前版本：vendor/<库>/current.json = { version, dir, from, at, sha256, signed }
function current(id) {
  const L = libOf(id), c = readJson(path.join(vendorRoot(), id, 'current.json'));
  if (!c || typeof c.dir !== 'string' || !DIR_RE.test(c.dir)) return null;
  const dir = path.join(vendorRoot(), id, c.dir);
  if (!fs.existsSync(path.join(dir, L.main))) return null;
  return { ...c, path: dir };
}

/** 装好的版本：{ id, name, installed, version, from, at, signed }；没装 installed: false */
export function libInfo(id) {
  const L = libOf(id), c = current(id);
  return c ? { id, name: L.name, installed: true, version: String(c.version || ''), from: c.from || '', at: c.at || 0, signed: c.signed !== false } : { id, name: L.name, installed: false, version: '' };
}
/** 装好的版本目录（没装返回 ''） */
export const libDir = id => current(id)?.path || '';
/** import 库的主文件；没装返回 null */
export async function libImport(id) {
  const c = current(id);
  return c ? import(pathToFileURL(path.join(c.path, libOf(id).main)).href) : null;
}

// 下载地址只认 https（本机回环可以 http），只取 origin
export function baseOf(u) {
  let x; try { x = new URL(String(u)); } catch { throw new Error('下载地址不对：' + u); }
  const loop = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(x.hostname);
  if (x.protocol !== 'https:' && !(loop && x.protocol === 'http:')) throw new Error('第三方库只从 https 地址下载');
  if (x.username || x.password) throw new Error('下载地址不能带用户名密码');
  return x.origin;
}

async function get(url, max, fetchImpl) {
  const r = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(TIMEOUT), headers: { accept: '*/*' } });
  if (!r.ok) throw new Error('下载失败（HTTP ' + r.status + '）：' + url);
  if (Number(r.headers.get('content-length')) > max) throw new Error('文件太大：' + url);
  const chunks = []; let n = 0;
  for await (const c of r.body) { n += c.length; if (n > max) throw new Error('文件太大：' + url); chunks.push(Buffer.from(c)); }
  return Buffer.concat(chunks);
}

// 检查一份文件能不能装：版本号、最低版本；签名由调用方先验
function checkBytes(id, bytes) {
  const L = libOf(id), version = fileVersion(id, bytes);
  if (!version) throw new Error(L.name + '：文件里读不到版本号，没装');
  if (L.minVersion && newerVersion(L.minVersion, version)) throw new Error(L.name + '：下载到的是 ' + version + '，claclaw 要求至少 ' + L.minVersion + '，没装');
  return version;
}

/**
 * 下载并验签（不装）：{ version, bytes }。查新版本也用它（文件不大，一次下完）
 * @param {object} o
 * @param {string[]} o.pubkeys  发布公钥（任一验得过就算）
 */
export async function libFetch(id, base, { fetchImpl = fetch, pubkeys } = {}) {
  const L = libOf(id), origin = baseOf(base), keys = (pubkeys || []).map(releaseKeyOk).filter(Boolean);
  if (!keys.length) throw new Error(L.name + '：还没有发布公钥，不能下载（用带公钥的设备邀请码加入）');
  let bytes, sig;
  try { bytes = await get(origin + L.file, MAX_FILE, fetchImpl); } catch (e) { throw new Error(L.name + '：下载不了（' + e.message + '）'); }
  try { sig = (await get(origin + L.sig, 1024, fetchImpl)).toString('utf8'); } catch (e) { throw new Error(L.name + '：读不到签名（' + e.message + '）'); }
  if (!verifySig(bytes, sig, keys)) throw new Error(L.name + '：签名不对（不是发布方签的），没装');
  return { version: checkBytes(id, bytes), bytes };
}

const locks = new Map();
/**
 * 从 base 下载库 id、验签，装好后切过去。已经是这份（版本和哈希一样）就不动。
 * @returns {Promise<{ info: object, changed: boolean }>}
 */
export function libInstall(id, base, { log = () => {}, fetchImpl = fetch, pubkeys } = {}) {
  return locked(id, async () => {
    const origin = baseOf(base), { version, bytes } = await libFetch(id, origin, { fetchImpl, pubkeys });
    return put(id, bytes, version, { from: origin, signed: true, log });
  });
}
/** 从本机文件装（开发用，命令行 --src）：不验签，标成「未签名」，也不受「不降级」限制 */
export function libInstallFile(id, file, { log = () => {} } = {}) {
  return locked(id, async () => {
    const bytes = fs.readFileSync(file);
    return put(id, bytes, checkBytes(id, bytes), { from: 'file:' + path.resolve(file), signed: false, log, allowDowngrade: true });
  });
}
function locked(id, fn) {   // 同一个库一次只装一个
  const p = (locks.get(id) || Promise.resolve()).then(fn);
  const tail = p.then(() => {}, () => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return p;
}
function put(id, bytes, version, { from, signed, log, allowDowngrade = false }) {
  const L = libOf(id), cur = current(id), hash = sha256(bytes);
  if (cur && cur.signed !== false && !allowDowngrade && version !== cur.version && !newerVersion(version, cur.version)) throw new Error(L.name + '：已装 ' + cur.version + '，下载到的是更旧的 ' + version + '，不降级');
  const dirName = version.replace(/[^0-9A-Za-z.-]/g, '_') + '-' + hash.slice(0, 8);
  if (cur?.dir === dirName) return { info: libInfo(id), changed: false };
  const top = path.join(vendorRoot(), id);
  fs.mkdirSync(top, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(top, '.dl-'));
  try {
    fs.writeFileSync(path.join(tmp, L.main), bytes);
    const dest = path.join(top, dirName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
  const meta = { version, dir: dirName, from, at: Date.now(), signed, sha256: hash };
  const cj = path.join(top, 'current.json'), t2 = cj + '.tmp';
  fs.writeFileSync(t2, JSON.stringify(meta, null, 2)); fs.renameSync(t2, cj);
  // 留当前和上一个版本，更早的删掉
  for (const e of fs.readdirSync(top, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === dirName || e.name === cur?.dir) continue;
    fs.rmSync(path.join(top, e.name), { recursive: true, force: true });
  }
  log('vendor', id, (cur ? cur.version + ' → ' : '装好 ') + version, 'from', from);
  return { info: libInfo(id), changed: true };
}
