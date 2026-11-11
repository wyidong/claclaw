// 会话的头像和网名（「最近」列表里点头像换；长按随机一套）
// 存在 data/skins.json：{ 会话 ID: { av: 头像引用, name: 网名 } }，两样都可以只有一样。
// 头像引用（网址就是 /avatars/<引用>）：
//   p/<组>/<文件>  仓库自带的预设（public/avatars/，来源和授权见那里的 LICENSE.md）
//   l/<组>/<文件>  只在本机的图（data/avatars/<组>/，比如版权不能进仓库的经典 QQ 头像），别的电脑上没有
//   u/<哈希>.<扩展名>  用户上传的（data/avatars/up/）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeJsonAtomic } from './auth.mjs';

const REF = /^(?:p\/[a-z0-9-]+\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif|svg)|l\/[a-z0-9-]+\/[A-Za-z0-9_-]+\.(?:png|jpe?g|webp|gif)|u\/[a-f0-9]{16}\.(?:png|jpe?g|webp))$/;
const IMG = /\.(png|jpe?g|webp|gif)$/i;
const TYPES = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' };
const LOCAL_NAMES = { qq: '经典 QQ', 'qq-oicq': '初代 OICQ', 'qq-2019': 'QQ 20 周年重绘' };   // 本机组的显示名和顺序（没列的按目录名排在后面）
export const NAME_MAX = 40;
export const UPLOAD_MAX = 1536 * 1024;

export function makeSkins(DATA, ROOT) {
  const FILE = path.join(DATA, 'skins.json');
  const REPO = path.join(ROOT, 'public', 'avatars');
  const LOCAL = path.join(DATA, 'avatars');
  const UP = path.join(LOCAL, 'up');
  let cache = null;
  const all = () => {
    if (!cache) { try { cache = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { cache = {}; } if (!cache || typeof cache !== 'object' || Array.isArray(cache)) cache = {}; }
    return cache;
  };
  // 引用 → 磁盘上的文件（不合法 / 不存在都给 null）
  const fileOf = (ref) => {
    if (typeof ref !== 'string' || !REF.test(ref)) return null;
    const [kind, ...rest] = ref.split('/');
    if (kind === 'l' && rest[0] === 'up') return null;   // 上传的只走 u/
    const f = kind === 'p' ? path.join(REPO, ...rest) : kind === 'l' ? path.join(LOCAL, ...rest) : path.join(UP, ...rest);
    return fs.existsSync(f) ? f : null;
  };
  const typeOf = (f) => TYPES[path.extname(f).slice(1).toLowerCase()] || 'application/octet-stream';
  // 选头像的页面要的清单：仓库预设 + 本机有的（每个子目录一组）+ 预设网名
  const index = () => {
    let base = { groups: [], names: [] };
    try { base = JSON.parse(fs.readFileSync(path.join(REPO, 'index.json'), 'utf8')); } catch {}
    const groups = (base.groups || []).map(g => ({ id: g.id, name: g.name, base: 'p/' + g.id, items: g.items || [] }));
    let dirs = [];
    try { dirs = fs.readdirSync(LOCAL, { withFileTypes: true }).filter(d => d.isDirectory() && d.name !== 'up' && /^[a-z0-9-]+$/.test(d.name)).map(d => d.name).sort(); } catch {}
    const known = Object.keys(LOCAL_NAMES), rank = d => (known.includes(d) ? known.indexOf(d) : known.length);
    dirs.sort((x, y) => rank(x) - rank(y) || (x < y ? -1 : 1));
    const local = [];
    for (const d of dirs) {
      let items = [];
      try { items = fs.readdirSync(path.join(LOCAL, d)).filter(f => IMG.test(f) && /^[A-Za-z0-9_-]+\.[a-z]+$/i.test(f)).sort(); } catch {}
      if (items.length) local.push({ id: 'l-' + d, name: (LOCAL_NAMES[d] || d) + '（本机）', base: 'l/' + d, items, local: true });
    }
    return { groups: local.concat(groups), names: Array.isArray(base.names) ? base.names : [] };
  };
  // 改一个会话：av / name 传 null 或空就清掉；两样都没了就删掉这一条
  const set = (id, { av, name } = {}) => {
    if (typeof id !== 'string' || !id || id.length > 200) throw Object.assign(new Error('会话 ID 不对'), { code: 400 });
    const m = all(), cur = { ...(m[id] || {}) };
    if (av !== undefined) {
      if (av === null || av === '') delete cur.av;
      else if (!fileOf(av)) throw Object.assign(new Error('没有这个头像'), { code: 400 });
      else cur.av = av;
    }
    if (name !== undefined) {
      const n = typeof name === 'string' ? name.trim() : '';
      if (n.length > NAME_MAX) throw Object.assign(new Error('网名太长了（最多 ' + NAME_MAX + ' 个字）'), { code: 400 });
      if (n) cur.name = n; else delete cur.name;
    }
    if (cur.av || cur.name) m[id] = cur; else delete m[id];
    writeJsonAtomic(FILE, m);
    return m[id] || null;
  };
  // 上传：网页先缩成小图再传 data URL；只收 png / jpeg / webp（不收 svg：里面能带脚本），按内容哈希存，同一张图只存一份
  const upload = (dataUrl) => {
    const mt = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(typeof dataUrl === 'string' ? dataUrl : '');
    if (!mt) throw Object.assign(new Error('只支持 PNG / JPEG / WebP 图片'), { code: 400 });
    const buf = Buffer.from(mt[2], 'base64');
    if (!buf.length || buf.length > UPLOAD_MAX) throw Object.assign(new Error('图片太大了'), { code: 400 });
    const magic = { png: buf.subarray(0, 4).toString('hex') === '89504e47', jpeg: buf[0] === 0xff && buf[1] === 0xd8, webp: buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP' };
    if (!magic[mt[1]]) throw Object.assign(new Error('图片内容和格式对不上'), { code: 400 });
    const ext = mt[1] === 'jpeg' ? 'jpg' : mt[1];
    const name = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + '.' + ext;
    fs.mkdirSync(UP, { recursive: true, mode: 0o700 });
    const f = path.join(UP, name);
    if (!fs.existsSync(f)) fs.writeFileSync(f, buf, { mode: 0o600 });
    return 'u/' + name;
  };
  return { all, set, upload, index, fileOf, typeOf };
}
