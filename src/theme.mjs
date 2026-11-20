// 换主题 / 背景图（claw-theme 技能 POST /api/local/theme、聊天里的主题卡片 POST /api/theme）。
// 存进网页的个人设置（clientPrefs），再通知所有打开着的网页马上换（ws 事件 theme）；没打开的设备下次打开时按 themeAt 改用电脑上这份。
// set(o) 里各项都可省：
//   theme：auto / light / dark / ziwei / shichen / shichen@0～11
//   img：on / off——时辰主题铺不铺背景图（设置里「时辰背景」）
//   bg：图片文件的完整路径 = 用户自己的背景图（换掉时辰自带的图，12 个时辰都铺）；last = 用户在聊天里最近发的那张；reset = 回到时辰自带的
//   fit：cover（默认，按比例拉伸铺满）/ center（原尺寸居中，不拉伸）
// 背景图只有时辰主题能铺：设了图而主题不是时辰，就换成时辰（默认卯 · 雾蓝灰）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const THEME_RE = /^(auto|light|dark|ziwei|shichen)(?:@(\d{1,2}))?$/;
const IMG_EXT = { 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

// prefs()：现在的个人设置（副本）；save(next)：存回去；notify(o)：发给所有网页
export function makeTheme({ dir, prefs, save, notify, sips = 'sips' }) {
  let last = null;   // 用户在聊天里最近发的一张图（图是直接给 AI 看的，没有文件路径；只在内存里，重启就没了）

  // 存一份背景图到 dir/<内容哈希>.<扩展名>：jpg / png / webp 不大就原样用；大图（长边超过 2560 又超过 1.5MB）、HEIC 等用 macOS 的 sips 转成 jpg、缩到长边 2560；
  // 没有 sips 就原样复制（只收 jpg / png / webp）。只留最近换过的 5 张
  function saveBg(file) {
    let st; try { st = fs.statSync(file); } catch { return { error: '找不到这个文件：' + file }; }
    if (!st.isFile() || !/\.(jpe?g|png|webp|heic|heif|gif|bmp|tiff?)$/i.test(file)) return { error: '只能用图片文件（jpg、png、webp、heic……）' };
    if (st.size > 40e6) return { error: '图片太大（最多 40MB）' };
    fs.mkdirSync(dir, { recursive: true });
    const tmp = path.join(dir, '.new'); let ext = 'jpg';
    const web = (file.match(/\.(jpe?g|png|webp)$/i) || [])[1];   // 网页直接能显示的格式
    let big = true;
    try { big = Math.max(0, ...(execFileSync(sips, ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8', timeout: 30000 }).match(/\d+(?=\s*$)/gm) || []).map(Number)) > 2560; } catch {}
    try {
      if (web && (!big || st.size < 1.5e6)) throw 0;   // 本来就不大：原样用，不重新压（重新压反而变大、变糊）
      execFileSync(sips, ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', ...(big ? ['-Z', '2560'] : []), file, '--out', tmp], { stdio: 'ignore', timeout: 60000 });
    } catch {
      if (!web) return { error: '这种格式在这台电脑上转不了，请发 jpg / png / webp' };
      fs.copyFileSync(file, tmp); ext = web.toLowerCase().replace('jpeg', 'jpg');
    }
    const name = crypto.createHash('sha1').update(fs.readFileSync(tmp)).digest('hex').slice(0, 12) + '.' + ext;
    fs.renameSync(tmp, path.join(dir, name));
    fs.utimesSync(path.join(dir, name), new Date(), new Date());   // 同一张图再设一次也算最近的
    try {
      fs.readdirSync(dir).filter(n => /^[0-9a-f]{12}\.(jpg|png|webp)$/.test(n) && n !== name).map(n => [n, fs.statSync(path.join(dir, n)).mtimeMs])
        .sort((a, b) => b[1] - a[1]).slice(4).forEach(([n]) => fs.rmSync(path.join(dir, n), { force: true }));
    } catch {}
    return { name };
  }
  function current(p = prefs()) { return (p.theme || 'auto') + (p.theme === 'shichen' && /^\d+$/.test(p.scZ || '') ? '@' + p.scZ : ''); }
  function state() { const p = prefs(); return { theme: current(p), img: p.scImg === '1' ? 'on' : 'off', bg: p.bg ? 'mine' : 'default', fit: p.bgFit === 'center' ? 'center' : 'cover' }; }
  function set(o) {
    o = o && typeof o === 'object' ? o : {};
    const { theme: v, img, bg, fit } = o, next = prefs();
    if (!v && img !== 'on' && img !== 'off' && !bg && fit !== 'cover' && fit !== 'center') return { ok: false, error: '没说换什么' };
    if (v) {
      const m = THEME_RE.exec(String(v));
      if (!m || (m[2] != null && (m[1] !== 'shichen' || +m[2] > 11))) return { ok: false, error: '没有这个主题：' + v };
      if (m[1] === 'auto') delete next.theme; else next.theme = m[1];
      if (m[2] != null) next.scZ = String(+m[2]); else delete next.scZ;
    }
    let ago;
    if (bg === 'reset') delete next.bg;
    else if (bg) {
      if (next.theme !== 'shichen' && v) return { ok: false, error: '背景图只有时辰主题能铺，' + v + ' 不行' };
      let file = String(bg), tmp = '';
      if (bg === 'last') {
        if (!last) return { ok: false, error: '没找到用户发来的图（claclaw 重启后要重新发一次）' };
        fs.mkdirSync(dir, { recursive: true });
        file = tmp = path.join(dir, '.last.' + (IMG_EXT[last.type] || 'jpg'));
        fs.writeFileSync(tmp, Buffer.from(last.data, 'base64'));
        ago = Math.round((Date.now() - last.at) / 60000);
      }
      const r = saveBg(file); if (tmp) fs.rmSync(tmp, { force: true });
      if (r.error) return { ok: false, error: r.error };
      next.bg = r.name; next.scImg = '1';
      if (next.theme !== 'shichen') { next.theme = 'shichen'; next.scZ = '3'; }
    }
    if (img === 'on') next.scImg = '1'; else if (img === 'off') delete next.scImg;
    if (fit === 'center') next.bgFit = 'center'; else if (fit === 'cover') delete next.bgFit;
    const at = String(Date.now());
    next.themeAt = at;
    save(next);
    notify({ t: 'theme', theme: next.theme || '', scZ: next.theme === 'shichen' && next.scZ != null ? next.scZ : null, img: next.scImg === '1' ? '1' : '', bg: next.bg || '', fit: next.bgFit || '', at });
    return { ok: true, ...state(), ...(ago != null ? { lastAgo: ago } : {}) };
  }
  return { set, state, dir, lastImage(i) { if (i && i.data) last = { type: i.media_type, data: i.data, at: Date.now() }; } };
}
