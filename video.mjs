// 收视频：网页把原文件传上来存到 data/uploads/，发消息时由服务器用 ffmpeg 按时间均匀截帧当图片交给 AI，
// 同时告诉 AI 原文件路径（需要更细的画面、声音，AI 可以自己用 ffmpeg 处理原文件）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { findBin as bin } from './util.mjs';

export const MAX_VIDEO_BYTES = 10 * 1024 * 1024;
export const VIDEO_FRAMES = 12;
export const KEEP_DAYS_DEFAULT = 60;
const EXT = { 'video/quicktime': 'mov', 'video/mp4': 'mp4', 'video/x-m4v': 'm4v', 'video/webm': 'webm', 'video/3gpp': '3gp' };
const ID_RE = /^(v[0-9a-f]{16}\.(mov|mp4|m4v|webm|3gp)|f[0-9a-f]{16}\.[a-z0-9]{1,8})$/;   // v = 视频，f = 其他文件

const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { maxBuffer: 20 * 1024 * 1024, timeout: 60000, ...opts }, (e, out) => e ? reject(e) : resolve(out)));

export function uploadsDir(data) { return path.join(data, 'uploads'); }

// 存上传的视频：边收边写，超过上限就断开删掉
// doc = 任意文件：扩展名取自文件名（只留字母数字），没有就用 bin
export function saveVideo(req, dir, { doc = false, name = '', keepDays = KEEP_DAYS_DEFAULT } = {}) {
  return new Promise((resolve, reject) => {
    const type = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    const ext = doc ? ((/\.([a-z0-9]{1,8})$/i.exec(String(name || '')) || [])[1] || 'bin').toLowerCase() : EXT[type];
    if (!ext) return reject(Object.assign(new Error('不支持的视频格式：' + (type || '未知')), { code: 415 }));
    const len = Number(req.headers['content-length'] || 0);
    if (len > MAX_VIDEO_BYTES) return reject(Object.assign(new Error((doc ? '文件' : '视频') + '太大（上限 ' + (MAX_VIDEO_BYTES >> 20) + 'MB）'), { code: 413 }));
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    cleanup(dir, keepDays);
    const id = (doc ? 'f' : 'v') + crypto.randomBytes(8).toString('hex') + '.' + ext, file = path.join(dir, id);
    const out = fs.createWriteStream(file, { mode: 0o600 });
    let bytes = 0, failed = false;
    const fail = (e) => { if (failed) return; failed = true; out.destroy(); fs.rm(file, { force: true }, () => {}); reject(e); };
    req.on('data', c => { bytes += c.length; if (bytes > MAX_VIDEO_BYTES) { fail(Object.assign(new Error('视频太大'), { code: 413 })); req.destroy(); } });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('上传中断')));
    out.on('error', fail);
    out.on('finish', () => { if (!failed) (bytes ? resolve({ id, file, bytes }) : fail(new Error('空文件'))); });
    req.pipe(out);
  });
}

export function videoFile(dir, id) {
  if (typeof id !== 'string' || !ID_RE.test(id)) return null;
  const f = path.join(dir, id);
  return fs.existsSync(f) ? f : null;
}

// 截帧：时长内均匀取点（约每秒一帧，最多 VIDEO_FRAMES 帧），长边压到 1280 内的 JPEG
export async function videoFrames(file, maxFrames = VIDEO_FRAMES) {
  const ffprobe = bin('ffprobe'), ffmpeg = bin('ffmpeg');
  if (!ffprobe || !ffmpeg) return { dur: 0, frames: [], error: '这台电脑没装 ffmpeg，没法截帧' };
  let dur = 0;
  try { dur = parseFloat(String(await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])).trim()); } catch {}
  if (!(dur > 0)) return { dur: 0, frames: [], error: '读不出视频时长' };
  const n = Math.min(maxFrames, Math.max(2, Math.ceil(dur)));
  const frames = [];
  const scale = "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(1280,ih))'";
  for (let i = 0; i < n; i++) {
    const t = Math.min(Math.max(0, dur - 0.05), dur * (i + 0.5) / n);
    try {
      const buf = await run(ffmpeg, ['-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '4', '-f', 'image2', '-c:v', 'mjpeg', 'pipe:1'], { encoding: 'buffer' });
      if (buf?.length) frames.push({ media_type: 'image/jpeg', data: buf.toString('base64'), t });
    } catch {}
  }
  return { dur, frames, error: frames.length ? '' : '截帧失败' };
}

// 播放原文件（手机本地没存时用）：支持 Range，iPhone 播视频必须
const MIME = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v', webm: 'video/webm', '3gp': 'video/3gpp',
  pdf: 'application/pdf', txt: 'text/plain; charset=utf-8', log: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', json: 'application/json', csv: 'text/csv; charset=utf-8',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', zip: 'application/zip',
  mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', ogg: 'audio/ogg', oga: 'audio/ogg', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac' };
export function serveVideo(req, res, file, name = '') {
  const size = fs.statSync(file).size, type = MIME[path.extname(file).slice(1)] || 'application/octet-stream';
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
  const head = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': 'private, max-age=604800', 'x-content-type-options': 'nosniff',
    ...(name ? { 'content-disposition': "inline; filename*=UTF-8''" + encodeURIComponent(String(name).slice(0, 120)) } : {}) };
  if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(200, { ...head, 'content-length': size }); return fs.createReadStream(file).pipe(res); }
  let start = m[1] === '' ? size - Number(m[2]) : Number(m[1]), end = m[1] !== '' && m[2] !== '' ? Number(m[2]) : size - 1;
  start = Math.max(0, start); end = Math.min(size - 1, end);
  if (start > end) { res.writeHead(416, { 'content-range': 'bytes */' + size }); return res.end(); }
  res.writeHead(206, { ...head, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': end - start + 1 });
  fs.createReadStream(file, { start, end }).pipe(res);
}

// 聊天里图片的缩略图：大于 THUMB_MIN 的图，用 macOS 自带 sips 把长边缩到 THUMB_PX（聊天里最大显示 180，三倍屏够清楚），存在原图旁边（<id>.t.jpg / .t.png，随附件一起过期清理）。
// 只给聊天里的小图用；点开看大图、保存还是原图。不是 macOS、不是图片、缩失败 → 原图
const THUMB_MIN = 300 * 1024, THUMB_PX = 540, thumbJobs = new Map();
export async function imageThumb(file) {
  const ext = path.extname(file).slice(1).toLowerCase();
  if (process.platform !== 'darwin' || !/^(png|jpe?g|heic|heif|webp|tiff?|bmp)$/.test(ext)) return file;
  let st; try { st = fs.statSync(file); } catch { return file; }
  if (st.size <= THUMB_MIN) return file;
  const fmt = /^(jpe?g|heic|heif)$/.test(ext) ? 'jpeg' : 'png';   // 可能带透明的转 png，免得透明处变黑
  const out = file + '.t.' + (fmt === 'jpeg' ? 'jpg' : 'png');
  try { if (fs.statSync(out).mtimeMs >= st.mtimeMs) return out; } catch {}
  if (!thumbJobs.has(out)) {
    const tmp = out + '.' + process.pid + '.tmp';
    thumbJobs.set(out, run('/usr/bin/sips', ['-s', 'format', fmt, ...(fmt === 'jpeg' ? ['-s', 'formatOptions', '80'] : []), '-Z', String(THUMB_PX), file, '--out', tmp], { timeout: 20000 })
      .then(() => { const t = fs.statSync(tmp); if (!t.size || t.size >= st.size) throw new Error('缩略图没更小'); fs.renameSync(tmp, out); return out; })
      .catch(() => { fs.rm(tmp, { force: true }, () => {}); return file; })
      .finally(() => thumbJobs.delete(out)));
  }
  return thumbJobs.get(out);
}

// 时长（不截帧，很快）
export async function videoDuration(file) {
  const ffprobe = bin('ffprobe');
  if (!ffprobe) return 0;
  try { return parseFloat(String(await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file])).trim()) || 0; } catch { return 0; }
}
// 聊天区显示用的缩略图：截一帧、长边 480，存在视频旁边（只给网页看，不给 AI）
export async function videoThumb(file) {
  const out = file + '.jpg';
  if (fs.existsSync(out)) return out;
  const ffmpeg = bin('ffmpeg');
  if (!ffmpeg) return null;
  const scale = "scale='if(gt(iw,ih),min(480,iw),-2)':'if(gt(iw,ih),-2,min(480,ih))'";
  for (const t of ['0.5', '0']) {
    try { await run(ffmpeg, ['-v', 'error', '-y', '-ss', t, '-i', file, '-frames:v', '1', '-vf', scale, '-q:v', '5', out]); if (fs.existsSync(out)) return out; } catch {}
  }
  return null;
}

// 电脑上的附件（上传的、AI 发回的）按设置保留天数，默认 2 个月
export function cleanup(dir, keepDays = KEEP_DAYS_DEFAULT) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cut = Date.now() - keepDays * 86400e3;
  for (const n of names) { const p = path.join(dir, n); try { if (fs.statSync(p).mtimeMs < cut) fs.rmSync(p, { force: true }); } catch {} }
}
