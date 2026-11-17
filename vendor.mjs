// 第三方库：运行时下载到 vendor/<库>/<版本>-<哈希前 8 位>/，不进 claclaw 版本库（vendor/ 里只提交 README.md 和 .gitignore）。
// - 下载：先拿清单（版本 + 每个文件的 sha256），逐个下载、核对，全部对上才写成新的版本目录，最后改 vendor/<库>/current.json 指过去。
// - 只从 https 下载（按系统 CA 校验证书、不跟跳转）；本机 127.0.0.1 / localhost 可以用 http（测试）。
// - 清单和文件来自同一个地址：sha256 只防下载不完整、被截断，不防下载地址本身被人改了。下载地址必须是用户自己信得过的（clarelay：自己加入的那台中继）。
// - 每个版本一个目录：已经加载进内存的旧版本照常跑；换新版的地方重新 import 新目录（路径不同，不会拿到缓存里的旧模块）。
// - 保留当前和上一个版本（回退用），更早的删掉。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const vendorRoot = () => process.env.CLACLAW_VENDOR || path.join(ROOT, 'vendor');

// 已知的第三方库：从哪下（相对下载地址的路径）、少了哪些文件就不算装好
export const LIBS = {
  clarelay: {
    name: 'clarelay 电脑端',
    manifest: '/_relay/client/manifest.json',   // { version, files: { 文件名: sha256 }, doc }
    file: f => '/_relay/client/' + encodeURIComponent(f),
    need: ['agent.mjs', 'common.mjs', 'tunnel.mjs'],
  },
};

const FILE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;   // 只要文件名：不带目录、不以点开头（.lib.json 不能被覆盖）
const VER_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/;
const MAX_MANIFEST = 64 * 1024, MAX_FILE = 4 * 1024 * 1024, MAX_FILES = 40, TIMEOUT = 30e3;
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const libOf = id => { const L = LIBS[id]; if (!L) throw new Error('不认识的第三方库：' + id); return L; };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

// 当前版本：vendor/<库>/current.json = { version, dir, from, at, files: { 文件名: sha256 } }
function current(id) {
  const c = readJson(path.join(vendorRoot(), id, 'current.json'));
  if (!c || typeof c.dir !== 'string' || !FILE_RE.test(c.dir) || !c.files || typeof c.files !== 'object') return null;
  const dir = path.join(vendorRoot(), id, c.dir);
  for (const f of libOf(id).need) if (!fs.existsSync(path.join(dir, f))) return null;
  return { ...c, path: dir };
}

/** 装好的版本：{ id, name, installed, version, from, at }；没装 installed: false */
export function libInfo(id) {
  const L = libOf(id), c = current(id);
  return c ? { id, name: L.name, installed: true, version: String(c.version || ''), from: c.from || '', at: c.at || 0 } : { id, name: L.name, installed: false, version: '' };
}
/** 装好的版本目录（没装返回 ''）：库里的文件按这个目录 import */
export const libDir = id => current(id)?.path || '';
/** import 库里的一个文件；没装返回 null */
export async function libImport(id, file) {
  const d = libDir(id);
  if (!d || !FILE_RE.test(file) || !fs.existsSync(path.join(d, file))) return null;
  return import(pathToFileURL(path.join(d, file)).href);
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

/** 读下载地址上的清单：{ version, files, doc } */
export async function libCheck(id, base, { fetchImpl = fetch } = {}) {
  const L = libOf(id), origin = baseOf(base);
  let m; try { m = JSON.parse((await get(origin + L.manifest, MAX_MANIFEST, fetchImpl)).toString('utf8')); } catch (e) { throw new Error(L.name + '：读不到清单（' + e.message + '）'); }
  if (!m || !VER_RE.test(String(m.version || ''))) throw new Error(L.name + '：清单里的版本号不对');
  const files = m.files && typeof m.files === 'object' && !Array.isArray(m.files) ? m.files : null;
  const names = files ? Object.keys(files) : [];
  if (!names.length || names.length > MAX_FILES) throw new Error(L.name + '：清单里的文件列表不对');
  for (const f of names) if (!FILE_RE.test(f) || f === 'current.json' || !/^[0-9a-f]{64}$/.test(String(files[f]))) throw new Error(L.name + '：清单里有不对的文件名或哈希：' + f.slice(0, 60));
  for (const f of L.need) if (!files[f]) throw new Error(L.name + '：清单里缺 ' + f);
  return { version: m.version, files, doc: typeof m.doc === 'string' ? m.doc : '' };
}

const locks = new Map();
/**
 * 从 base 下载库 id 的最新版本，装好后切过去。已经是这个版本（文件哈希一样）就不重下。
 * @returns {Promise<{ info: object, changed: boolean }>}
 */
export function libInstall(id, base, { log = () => {}, fetchImpl = fetch } = {}) {
  const p = (locks.get(id) || Promise.resolve()).then(() => installNow(id, base, { log, fetchImpl }));   // 同一个库一次只装一个
  const tail = p.then(() => {}, () => {});
  locks.set(id, tail);
  tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
  return p;
}
async function installNow(id, base, { log, fetchImpl }) {
  const L = libOf(id), origin = baseOf(base);
  const m = await libCheck(id, origin, { fetchImpl });
  const cur = current(id);
  const tag = sha256(JSON.stringify(Object.entries(m.files).sort())).slice(0, 8);
  const dirName = m.version.replace(/[^0-9A-Za-z.-]/g, '_') + '-' + tag;
  if (cur?.dir === dirName) return { info: libInfo(id), changed: false };
  const top = path.join(vendorRoot(), id);
  fs.mkdirSync(top, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(top, '.dl-'));
  try {
    for (const [f, h] of Object.entries(m.files)) {
      const b = await get(origin + L.file(f), MAX_FILE, fetchImpl);
      if (sha256(b) !== h) throw new Error(L.name + '：' + f + ' 的 sha256 和清单对不上，没装');
      fs.writeFileSync(path.join(tmp, f), b);
    }
    const dest = path.join(top, dirName);
    fs.rmSync(dest, { recursive: true, force: true });
    fs.renameSync(tmp, dest);
    const meta = { version: m.version, dir: dirName, from: origin, at: Date.now(), files: m.files, ...(m.doc ? { doc: m.doc } : {}) };
    const cj = path.join(top, 'current.json'), t2 = cj + '.tmp';
    fs.writeFileSync(t2, JSON.stringify(meta, null, 2)); fs.renameSync(t2, cj);
    // 留当前和上一个版本，更早的删掉
    for (const e of fs.readdirSync(top, { withFileTypes: true })) {
      if (!e.isDirectory() || e.name === dirName || e.name === cur?.dir) continue;
      fs.rmSync(path.join(top, e.name), { recursive: true, force: true });
    }
    log('vendor', id, (cur ? cur.version + ' → ' : '装好 ') + m.version, 'from', origin);
    return { info: libInfo(id), changed: true };
  } catch (e) { fs.rmSync(tmp, { recursive: true, force: true }); throw e; }
}
