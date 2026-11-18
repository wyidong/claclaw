// claclaw-media 的数据来源。每个来源一项：
//   id      名字（命令行 --src 用）
//   kinds   能找哪几类：video / audio / image
//   proxy   true = 要出墙（没有代理时自动跳过）
//   search(q, ctx) → [{ title, page?, file?, thumb?, dur?, plays?, w?, h? }]
//     page：视频 / 音频所在网页（用 yt-dlp 下载）；file：媒体文件直链（直接下载）；thumb：缩略图直链（原图下不来时用）
//     ctx：{ kind, n, max, get(url, opts) → 文本, json(url, opts), ytdlp(args) → stdout, kv：get(k) / set(k, v) 跨次保存的小数据 }
//   embed(x, ctx) → true/false（可选）：这一条能不能嵌在 claclaw 聊天里直接播放（不写 = 都能）；
//     没有 embed 也不是 file 直链的来源（只能下载的）不会出现在 link 结果里，见 media.mjs 的 EMBEDDABLE
// 加来源：在 SOURCES 里加一项即可，引擎负责并发、超时、排序、去重、失败降级。
const enc = encodeURIComponent;
const secs = s => String(s || '').split(':').reduce((a, x) => a * 60 + (+x || 0), 0);
const num = s => { const m = /([\d.,]+)\s*(万|亿|K|M|B)?/i.exec(String(s || '')); if (!m) return undefined; const v = parseFloat(m[1].replace(/,/g, '')); return Math.round(v * ({ 万: 1e4, 亿: 1e8, K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 }[m[2]] || 1)); };
const strip = s => String(s || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

// 从网页里抠出 `var ytInitialData = {...};` 这类内嵌 JSON
function embedded(html, name) {
  const i = html.indexOf(name);
  if (i < 0) return null;
  const s = html.indexOf('{', i);
  let d = 0, q = false, e = false;
  for (let j = s; j < html.length; j++) {
    const c = html[j];
    if (q) { if (e) e = false; else if (c === '\\') e = true; else if (c === '"') q = false; continue; }
    if (c === '"') q = true; else if (c === '{') d++; else if (c === '}' && --d === 0) { try { return JSON.parse(html.slice(s, j + 1)); } catch { return null; } }
  }
  return null;
}
function* walk(o, key) {
  if (!o || typeof o !== 'object') return;
  if (o[key]) yield o[key];
  for (const v of Object.values(o)) yield* walk(v, key);
}

export const SOURCES = [
  // ---------- 视频 / 音频 ----------
  {
    id: 'bili', label: 'B 站', kinds: ['video', 'audio'],
    // 搜索接口要登录态 cookie；搜索页 HTML 里内嵌了结果（bvid、title、play、duration）
    async search(q, { get }) {
      const out = [], seen = new Set();
      const re = /bvid:"(BV[0-9A-Za-z]{10})",title:"((?:[^"\\]|\\.)*)"((?:(?!bvid:)[\s\S]){0,1500}?)duration:(?:"(\d+(?::\d+){1,2})"|[A-Za-z_$][\w$]*)/g;
      // 两页一起取（一页约 20 条），省一次往返
      const pages = await Promise.all([1, 2].map(p => get('https://search.bilibili.com/video?keyword=' + enc(q) + (p > 1 ? '&page=' + p : '')).catch(() => '')));
      for (const html of pages) {
        for (let m; (m = re.exec(html));) {
          if (seen.has(m[1])) continue; seen.add(m[1]);
          let t = m[2]; try { t = JSON.parse('"' + t + '"'); } catch {}
          out.push({ title: strip(t), page: 'https://www.bilibili.com/video/' + m[1], dur: m[4] ? secs(m[4]) : undefined, plays: +(/(?:^|,)play:(\d+)/.exec(m[3])?.[1]) || undefined });
        }
        re.lastIndex = 0;
      }
      return out;
    },
  },
  {
    id: 'youtube', label: 'YouTube', kinds: ['video', 'audio'], proxy: true,
    async search(q, { get }) {
      const html = await get('https://www.youtube.com/results?search_query=' + enc(q) + '&sp=EgIQAQ%253D%253D&hl=zh-CN', { proxy: true });
      const out = [];
      for (const v of walk(embedded(html, 'ytInitialData'), 'videoRenderer')) {
        if (!v.videoId || !v.lengthText) continue;   // 没有时长的是直播
        out.push({ title: v.title?.runs?.map(r => r.text).join('') || '', page: 'https://www.youtube.com/watch?v=' + v.videoId, dur: secs(v.lengthText.simpleText), plays: num(v.viewCountText?.simpleText),
          channel: (v.ownerText || v.longBylineText)?.runs?.map(r => r.text).join('') || '',
          verified: (v.ownerBadges || []).some(b => /VERIFIED/.test(b.metadataBadgeRenderer?.style || '')) });   // 频道名、认证标记（找官方电影用）
      }
      return out;
    },
    // 作者关了「允许嵌入」的，oEmbed 回 401 / 403
    async embed(x, { get }) { try { await get('https://www.youtube.com/oembed?format=json&url=' + enc(x.page), { proxy: true, timeout: 6000 }); return true; } catch (e) { return !/HTTP 40[134]/.test(e.message); } },   // 只有明确回 401 / 403 / 404 才算不能嵌入；网络慢、超时不冤枉它
  },
  {
    id: 'dailymotion', label: 'Dailymotion', kinds: ['video'], proxy: true,
    async search(q, { json, n }) {
      const j = await json('https://api.dailymotion.com/videos?search=' + enc(q) + '&fields=id,title,duration,views_total,allow_embed&limit=' + Math.min(n * 2, 30), { proxy: true });
      return (j.list || []).filter(v => v.allow_embed !== false).map(v => ({ title: v.title, page: 'https://www.dailymotion.com/video/' + v.id, dur: v.duration, plays: v.views_total }));
    },
  },
  {
    id: 'soundcloud', label: 'SoundCloud', kinds: ['audio'], proxy: true,
    // 网页版的公开 client_id：从首页引用的脚本里取，存起来复用（失效了重取）
    async search(q, { get, json, kv, n }) {
      const cid = async fresh => {
        if (!fresh && kv.get('scid')) return kv.get('scid');
        const home = await get('https://soundcloud.com/', { proxy: true });
        const js = [...home.matchAll(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g)].map(m => m[0]).reverse();
        for (const u of js.slice(0, 4)) { const m = /client_id:"(\w{32})"/.exec(await get(u, { proxy: true }).catch(() => '')); if (m) { kv.set('scid', m[1]); return m[1]; } }
        throw new Error('没取到 client_id');
      };
      const api = async id => json(`https://api-v2.soundcloud.com/search/tracks?q=${enc(q)}&limit=${Math.min(n * 2, 30)}&client_id=${id}`, { proxy: true });
      let j; try { j = await api(await cid(false)); } catch { j = await api(await cid(true)); }
      return (j.collection || []).filter(t => t.policy !== 'BLOCK' && t.monetization_model !== 'SUB_HIGH_TIER' && (t.embeddable_by || 'all') === 'all').map(t => ({ title: t.title, page: t.permalink_url, dur: t.full_duration ? t.full_duration / 1000 : t.duration / 1000, plays: t.playback_count }));
    },
  },
  {
    id: 'openverse', label: 'Openverse（CC 授权）', kinds: ['audio', 'image'], proxy: true,
    async search(q, { json, kind, n }) {
      const j = await json(`https://api.openverse.org/v1/${kind === 'audio' ? 'audio' : 'images'}/?q=${enc(q)}&page_size=${Math.min(n * 2, 20)}`, { proxy: true, timeout: 15000 });
      return (j.results || []).map(r => ({ title: r.title, file: r.url, thumb: r.thumbnail, page: r.foreign_landing_url, dur: r.duration ? r.duration / 1000 : undefined, w: r.width, h: r.height }));
    },
  },
  {
    id: 'archive', label: 'Internet Archive', kinds: ['video', 'audio'], proxy: true,
    async search(q, { json, kind, n }) {
      const j = await json(`https://archive.org/advancedsearch.php?q=${enc(q)}+AND+mediatype:${kind === 'video' ? 'movies' : 'audio'}&fl[]=identifier&fl[]=title&fl[]=downloads&sort[]=downloads+desc&rows=${Math.min(n * 2, 20)}&output=json`, { proxy: true });
      return (j.response?.docs || []).map(d => ({ title: [].concat(d.title)[0], page: 'https://archive.org/details/' + d.identifier, plays: d.downloads }));
    },
  },

  // ---------- 图片 ----------
  {
    id: 'bing', label: 'Bing 图片', kinds: ['image'],
    async search(q, { get }) {
      const html = await get('https://cn.bing.com/images/async?q=' + enc(q) + '&first=0&count=35&mmasync=1&adlt=strict');
      return [...html.matchAll(/\sm="(\{[^"]+\})"/g)].map(m => { try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')); } catch { return null; } })
        .filter(j => j?.murl).map(j => ({ title: strip(j.t), file: j.murl, thumb: j.turl, page: j.purl }));
    },
  },
  {
    id: 'baidu', label: '百度图片', kinds: ['image'],
    async search(q, { json }) {
      const j = await json('https://image.baidu.com/search/acjson?tn=resultjson_com&ipn=rj&word=' + enc(q) + '&pn=0&rn=30');
      return (j.data || []).filter(d => d.thumbURL).map(d => ({ title: strip(d.fromPageTitle), file: d.replaceUrl?.[0]?.ObjURL || d.middleURL, thumb: d.middleURL || d.thumbURL, page: d.replaceUrl?.[0]?.FromURL, w: d.width, h: d.height }));
    },
  },
  {
    id: 'so360', label: '360 图片', kinds: ['image'],
    async search(q, { json }) {
      const j = await json('https://image.so.com/j?q=' + enc(q) + '&pn=30&sn=0');
      return (j.list || []).map(d => ({ title: strip(d.title), file: d.img, thumb: d.thumb || d._thumb, page: d.link, w: +d.width || undefined, h: +d.height || undefined }));
    },
  },
  {
    id: 'commons', label: 'Wikimedia Commons', kinds: ['image'],
    async search(q, { json, n }) {
      const j = await json('https://commons.wikimedia.org/w/api.php?action=query&format=json&generator=search&gsrnamespace=6&gsrsearch=' + enc(q + ' filetype:bitmap') + '&gsrlimit=' + Math.min(n * 2, 20) + '&prop=imageinfo&iiprop=url|size&iiurlwidth=1280');
      return Object.values(j.query?.pages || {}).sort((a, b) => a.index - b.index).map(p => { const i = p.imageinfo?.[0] || {}; return { title: p.title.replace(/^File:|\.\w+$/g, ''), file: i.thumburl || i.url, page: i.descriptionurl, w: i.thumbwidth || i.width, h: i.thumbheight || i.height }; });
    },
  },
];
