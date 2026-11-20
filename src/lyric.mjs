// 歌词（顶上音频条里跟着唱到哪句显示哪句）：GET /api/lyric?ne=网易云歌曲ID 或 ?t=标题&d=时长秒
// - 网易云的歌直接按 ID 取（VIP 歌的歌词也能取）；接口标了纯音乐就不显示
// - 别的来源（B 站音轨、酷我、5sing…）按标题找：先清掉【4K】「歌词」这类修饰，网易云搜歌，歌名在标题里、时长对得上（差 30 秒以内）的才算；
//   找不到再查 LRCLIB（开放歌词库）
// 只回带时间轴的歌词；结果（包括「没有」）缓存在内存里
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const NE_REF = 'https://music.163.com/';
const cache = new Map();

async function getJson(url, referer) {
  const r = await fetch(url, { headers: { 'user-agent': UA, ...(referer ? { referer } : {}) }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// LRC 文本 → [[秒, 这句], …]；一行多个时间标签的拆开；网易云开头那种 JSON 行（制作人员）不要
export function parseLrc(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const tags = [...line.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!tags.length) continue;
    const words = line.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push([+m[1] * 60 + +m[2] + (m[3] ? +('0.' + m[3].padStart(2, '0')) : 0), words]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out.filter(x => x[1]).length >= 3 ? out : [];
}

const norm = s => String(s || '').toLowerCase().replace(/[\s·・\-—_()（）【】\[\]《》<>"'“”‘’!！?？,，.。:：|/\\&、]+/g, '');
// B 站那种标题：「在百万豪装录音棚大声听刘若英《后来》【Hi-res】」「【杜比音效】周杰伦《晴天》4K「歌词…」」→ 去掉修饰
export function cleanTitle(t) {
  return String(t || '').replace(/【[^】]*】|「[^」]*」|“[^”]*”|\[[^\]]*\]|（[^）]*(?:版|音质|无损|字幕|修复|cover|伴奏|live)[^）]*）|\([^)]*(?:ver|version|音质|cover|live|remaster)[^)]*\)/gi, ' ')
    .replace(/在百万豪装录音棚大声听|动态歌词|歌词版?|lyrics?|官方|official|完整版|高音质|无损音质|无损|hi-?res|4k\d*|1080p|2160p|60帧|50帧|mv|杜比音效|修复版?|cd音轨|中文字幕|sq|flac[\d/]*/gi, ' ')
    .replace(/[《》]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function neLyric(id) {
  const j = await getJson(`https://music.163.com/api/song/lyric?id=${id}&lv=1&tv=1`, NE_REF);
  if (j.pureMusic || j.nolyric) return { pure: true, lines: [] };
  return { lines: parseLrc(j.lrc?.lyric), src: '网易云' };
}

// 按标题在网易云里找：歌名要在标题里；歌手也在标题里、时长接近的优先；原唱优先于 Live / 伴奏
async function neFind(title, dur) {
  const raw = norm(title), qs = [cleanTitle(title)];
  const book = /《([^》]+)》/.exec(title); if (book) qs.push(book[1]);
  for (const q of qs) {
    if (!q) continue;
    const j = await getJson(`https://music.163.com/api/search/get/web?s=${encodeURIComponent(q)}&type=1&limit=10`, NE_REF).catch(() => null);
    let best = null, bs = -1;
    for (const s of j?.result?.songs || []) {
      const name = norm(String(s.name).replace(/[（(][^）)]*[）)]/g, ''));
      if (!name || !raw.includes(name)) continue;
      const d = Math.round((s.duration || 0) / 1000), diff = dur ? Math.abs(d - dur) : 0;
      if (dur && diff > 30) continue;
      let sc = name.length * 2 + (30 - diff);
      if ((s.artists || []).some(a => raw.includes(norm(a.name)))) sc += 40;
      if (/live|伴奏|dj|remix|翻唱|cover/i.test(s.name) && !/live|伴奏|dj|remix|翻唱|cover/i.test(title)) sc -= 30;
      if (sc > bs) { bs = sc; best = s; }
    }
    if (best) return best.id;
  }
  return 0;
}

async function lrclib(title, dur) {
  const q = cleanTitle(title);
  if (!q) return null;
  const list = await getJson('https://lrclib.net/api/search?q=' + encodeURIComponent(q)).catch(() => []);
  const raw = norm(title);
  const hit = (Array.isArray(list) ? list : []).find(x => x.syncedLyrics && raw.includes(norm(x.trackName)) && (!dur || !x.duration || Math.abs(x.duration - dur) <= 30));
  if (!hit) return null;
  if (hit.instrumental) return { pure: true, lines: [] };
  return { lines: parseLrc(hit.syncedLyrics), src: 'LRCLIB' };
}

export async function findLyric({ ne, title, dur }) {
  const key = ne ? 'ne:' + ne : 't:' + norm(title) + ':' + Math.round((dur || 0) / 15);
  if (cache.has(key)) return cache.get(key);
  let r = { lines: [] };
  try {
    if (ne) r = await neLyric(ne);
    else if (title) {
      const id = await neFind(title, dur);
      if (id) r = await neLyric(id);
      if (!r.lines.length && !r.pure) r = (await lrclib(title, dur)) || r;
    }
  } catch { r = { lines: [] }; }
  if (!r.lines.length) r = { lines: [], ...(r.pure ? { pure: true } : {}) };
  cache.set(key, r);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return r;
}

export async function serveLyric(res, q) {
  const ne = /^\d{1,15}$/.test(q.get('ne') || '') ? q.get('ne') : '';
  const title = String(q.get('t') || '').slice(0, 200), dur = Math.max(0, Math.min(36000, +q.get('d') || 0));
  const send = o => { res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'private, max-age=3600' }); res.end(JSON.stringify(o)); };
  if (!ne && !title) return send({ lines: [] });
  if (dur > 1200) return send({ lines: [] });   // 二十分钟以上是节目，不找歌词
  send(await findLyric({ ne, title, dur }));
}
