// 电脑合成语音：电脑把文字合成音频，给手机网页播放（iPhone 只开放很少几个语音给网页）。两种来源：
// - 微软在线语音（Edge 的自然语音，最好听）：要联网，一句约 2 秒，装了 edge-tts 才有（tools/setup-edge-tts.sh）
// - macOS 自带的 say：不联网，一句约 0.3 秒，能用 Mac 上装的中文语音
// - 火山引擎豆包语音（付费）：设置里填了 API Key 才有，一句约 0.5～1 秒
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA, writeJsonAtomic } from './auth.mjs';

// ---------- 微软在线语音（Edge 的自然语音：晓伊、晓晓、云希…） ----------
// 装了才有（tools/setup-edge-tts.sh，Windows 上 tools/setup-edge-tts.ps1：在 data/edge-tts 里建 Python 环境装 edge-tts）。常驻一个 Python 助手进程，一句约 2 秒。
// 没装 / 没有 Python：声音列表里没有微软的，网页自动用浏览器自带的声音念
const EDGE_PY = process.platform === 'win32'
  ? path.join(DATA, 'edge-tts', 'venv', 'Scripts', 'python.exe')
  : path.join(DATA, 'edge-tts', 'venv', 'bin', 'python');
const EDGE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'edge-tts-helper.py');
let edge = null, edgeSeq = 0, edgeVoices = { at: 0, list: [] };
const edgePending = new Map();
function edgeProc() {
  if (edge) return edge;
  if (!fs.existsSync(EDGE_PY)) return null;
  let p;
  try { p = spawn(EDGE_PY, ['-I', EDGE_HELPER], { stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch { return null; }   // Windows 上 python.exe 坏了时 spawn 直接同步抛（spawn UNKNOWN）：当没装
  let buf = '';
  // 起不来（环境坏了、python.exe 被删）或中途退出：都不抛到进程级把服务弄崩，等着的请求一律回掉，下次再试着起
  const gone = why => { if (edge === p) edge = null; for (const q of edgePending.values()) { clearTimeout(q.t); q.no(new Error(why)); } edgePending.clear(); };
  p.on('error', e => gone('微软语音助手起不来：' + e.message));
  p.stdin.on('error', () => {});   // 进程已经没了还往里写：EPIPE
  p.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let m; try { m = JSON.parse(line); } catch { continue; }
      const q = edgePending.get(m.id); if (!q) continue;
      edgePending.delete(m.id); clearTimeout(q.t);
      m.ok ? q.ok(m) : q.no(new Error(m.error || '微软语音合成失败'));
    }
  });
  p.on('exit', () => gone('微软语音助手退出了'));
  edge = p;
  return p;
}
function edgeCall(req, ms = 20000) {
  const p = edgeProc();
  if (!p) return Promise.reject(new Error('没装微软语音（运行 tools/setup-edge-tts.sh）'));
  return new Promise((ok, no) => {
    const id = ++edgeSeq;
    edgePending.set(id, { ok, no, t: setTimeout(() => { edgePending.delete(id); no(new Error('微软语音超时（要联网）')); }, ms) });
    p.stdin.write(JSON.stringify({ id, ...req }) + '\n');
  });
}
// 先把到微软的连接建好：开始回复时调一下，第一句就不用再花 1～1.5 秒握手
export function ttsWarm() { if (fs.existsSync(EDGE_PY)) edgeCall({ op: 'warm' }, 15000).catch(() => {}); }
async function edgeVoiceList() {
  if (!fs.existsSync(EDGE_PY)) return [];
  if (edgeVoices.list.length && Date.now() - edgeVoices.at < 6 * 3600 * 1000) return edgeVoices.list;
  try {
    const r = await edgeCall({ op: 'voices' }, 15000);
    edgeVoices = { at: Date.now(), list: r.voices.map(v => ({ name: 'edge:' + v.name, lang: v.locale, gender: v.gender, engine: 'edge' })) };
  } catch { /* 没网：这次先不列 */ }
  return edgeVoices.list;
}

const run = (cmd, args, ms = 20000) => new Promise((ok, no) =>
  execFile(cmd, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => e ? no(new Error(String(err || e.message).trim())) : ok(String(out))));

// ---------- 火山引擎豆包语音（付费，新版控制台 API Key） ----------
// 接口：POST https://openspeech.bytedance.com/api/v3/tts/unidirectional，头 X-Api-Key + X-Api-Resource-Id；
// 回的是一串 JSON（code 0 的 data 是 base64 音频块，20000000 是结束）。文档：volcengine.com/docs/6561/1598757
// 音色和资源要对上：*_uranus_bigtts 是 2.0（seed-tts-2.0），其余是 1.0（seed-tts-1.0），对不上报 45000000。
// 账号开通了哪个就列哪个：保存 Key 时两种各试一句，记下能用的。Key 存 data/volc-tts.json（600），网页只看到末 4 位
const VOLC_FILE = path.join(DATA, 'volc-tts.json');
const VOLC_URL = 'https://openspeech.bytedance.com/api/v3/tts/unidirectional';
const VOLC_VOICES = [
  ['zh_female_vv_uranus_bigtts', 'Vivi', 'Female'], ['zh_female_xiaohe_uranus_bigtts', '小何', 'Female'],
  ['zh_female_shuangkuaisisi_uranus_bigtts', '爽快思思', 'Female'], ['zh_female_qingxinnvsheng_uranus_bigtts', '清新女声', 'Female'],
  ['zh_male_m191_uranus_bigtts', '云舟', 'Male'], ['zh_male_taocheng_uranus_bigtts', '小天', 'Male'], ['zh_male_ruyayichen_uranus_bigtts', '儒雅逸辰', 'Male'],
  // 方言：音色 ID 后面接 @方言。只有 Vivi 有官方方言参数（explicit_dialect：东北 / 陕西 / 四川）。
  // 男声试过用语音指令（context_texts「请用四川话说」）：实听还是普通话，不提供
  ['zh_female_vv_uranus_bigtts@sichuan', 'Vivi · 四川话', 'Female'],
  ['zh_female_shuangkuaisisi_moon_bigtts', '爽快思思 1.0', 'Female'], ['zh_female_tianmeitaozi_mars_bigtts', '甜美桃子', 'Female'],
  ['zh_female_qinqienvsheng_moon_bigtts', '亲切女声', 'Female'], ['zh_male_qingyiyuxuan_mars_bigtts', '清逸宇轩', 'Male'],
];
const volcRes = speaker => /_uranus_/.test(speaker) ? 'seed-tts-2.0' : 'seed-tts-1.0';
const DIALECT = { sichuan: '四川话', dongbei: '东北话', shaanxi: '陕西话' };
const DIALECT_NATIVE = new Set(['zh_female_vv_uranus_bigtts']);   // 有官方方言参数的音色
// 「音色@方言」拆成真正的音色 ID 和要附加的 additions（接口要求 additions 是 JSON 字符串）
// 2.0 音色一句一句分开合成时，每句的情绪各不相同（这句激动、下句低落）：每次都带同一条语音指令（context_texts，不计费）把语气定住。
// 1.0 音色不认这个字段
export const VOLC_TONE = '请用平稳自然、前后一致的语气说，不要有大的情绪起伏。';
function volcSpeaker(id, sec = '') {
  const [sp, dia] = String(id).split('@');
  const v2 = volcRes(sp) === 'seed-tts-2.0';
  const add = {};
  if (dia && DIALECT[dia]) { if (DIALECT_NATIVE.has(sp)) add.explicit_dialect = dia; else add.context_texts = ['请用' + DIALECT[dia] + '说']; }
  if (v2 && !add.context_texts) add.context_texts = [VOLC_TONE];   // 只有第一条生效：方言指令优先
  if (v2 && sec) add.section_id = sec;
  return { sp, additions: Object.keys(add).length ? JSON.stringify(add) : null };
}
const volcCfg = () => { try { return JSON.parse(fs.readFileSync(VOLC_FILE, 'utf8')) || {}; } catch { return {}; } };
// 完整的 Key：只给「查看 / 复制 Key」（先核对过 claclaw 密码）用
export function volcKey() { return String(volcCfg().key || ''); }
export function volcInfo() { const c = volcCfg(); return { set: !!c.key, tail: c.key ? String(c.key).slice(-4) : '', res: c.res || [] }; }
// 合成一句：返回 mp3。出错的信息里不带 Key
// sec：同一段朗读的会话 ID（section_id，只 2.0 认）：豆包按它记住前面念过的，后面的语气接着来；请求要一句念完再发下一句（网页那边串着发）
export async function volcSay(text, speaker, rate = 1, key = volcCfg().key, ms = 20000, signal = null, sec = '') {
  if (!key) throw new Error('没填火山语音的 API Key');
  const vs = volcSpeaker(speaker, sec);
  const r = await fetch(VOLC_URL, {
    method: 'POST', signal: signal && AbortSignal.any ? AbortSignal.any([AbortSignal.timeout(ms), signal]) : AbortSignal.timeout(ms),   // signal：网页那边停了就别再等（也别计费）
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'x-api-resource-id': volcRes(speaker), 'x-api-request-id': crypto.randomUUID() },
    body: JSON.stringify({ user: { uid: 'claclaw' }, req_params: { text, speaker: vs.sp, ...(vs.additions ? { additions: vs.additions } : {}), audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: Math.max(-50, Math.min(100, Math.round((rate - 1) * 100))) } } }),
  }).catch(e => { throw new Error(signal?.aborted ? '已取消' : '连不上火山语音：' + (e.name === 'TimeoutError' ? '超时' : e.message)); });
  const body = await r.text();
  const chunks = [];
  let err = '';
  for (const j of jsonSeq(body)) {
    if (j.code === 0 && j.data) chunks.push(Buffer.from(j.data, 'base64'));
    else if (j.code && j.code !== 0 && j.code !== 20000000) err = j.code + ' ' + (j.message || '');
    else if (j.header?.code) err = j.header.code + ' ' + (j.header.message || '');   // 鉴权错误是 {header:{code,message}}
  }
  if (!r.ok && !err) err = 'HTTP ' + r.status + ' ' + body.slice(0, 120);
  if (/^45000010\b/.test(err)) throw new Error('API Key 不对（火山说无效）');
  if (/^45000030\b/.test(err)) throw new Error('Key 是对的，但账号还没开通「' + (volcRes(speaker) === 'seed-tts-2.0' ? '豆包语音合成模型 2.0' : '豆包语音合成模型 1.0') + '」（控制台 → 语音合成 → 开通）');
  if (/^45000000\b/.test(err)) throw new Error('这个账号没开通这类音色（' + volcRes(speaker) + '）');
  if (err) throw new Error('火山语音：' + err.split(key).join('***').slice(0, 200));
  const buf = Buffer.concat(chunks);
  if (!buf.length) throw new Error('火山语音没有返回声音');
  return buf;
}
// 连着的一串 JSON（一行一个，也可能粘在一起）：按括号配对切开
function* jsonSeq(s) {
  let depth = 0, start = -1, q = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') q = false; continue; }
    if (c === '"') q = true;
    else if (c === '{') { if (!depth++) start = i; }
    else if (c === '}' && depth && !--depth) { try { yield JSON.parse(s.slice(start, i + 1)); } catch {} }
  }
}
// 保存 Key：两种资源各试一句，记下能用的；都不能用就不存，把错误告诉网页。key 为空 = 清除
export async function volcSetKey(key) {
  key = String(key || '').trim();
  if (!key) { fs.rmSync(VOLC_FILE, { force: true }); return volcInfo(); }
  const res = [], errs = [];
  for (const sp of ['zh_female_vv_uranus_bigtts', 'zh_female_shuangkuaisisi_moon_bigtts']) {
    try { await volcSay('你好', sp, 1, key, 15000); res.push(volcRes(sp)); } catch (e) { errs.push(volcRes(sp) + '：' + e.message); }
  }
  if (!res.length) throw new Error([...new Set(errs.map(e => e.replace(/^seed-tts-[\d.]+：(?=API Key)/, '')))].join('；'));
  writeJsonAtomic(VOLC_FILE, { key, res, at: new Date().toISOString() });
  return volcInfo();
}
function volcVoices() {
  const { set, res } = volcInfo();
  if (!set) return [];
  return VOLC_VOICES.filter(([sp]) => res.includes(volcRes(sp))).map(([sp, label, gender]) => ({ name: 'volc:' + sp, label, lang: 'zh-CN', gender, engine: 'volc' }));
}

// 语音平台（语音管理页用）：本机（设备自带）由网页自己列；这里给电脑合成的几家。以后加平台在这里加一项
export function ttsEngines() {
  const v = volcInfo();
  return [
    { id: 'edge', name: '微软', free: true, ready: fs.existsSync(EDGE_PY), hint: '电脑联网合成，免费' },
    { id: 'volc', name: '豆包', free: false, needKey: true, ready: v.set, key: v, hint: '火山引擎豆包语音，按字数付费' },
  ];
}

let voiceCache = { at: 0, list: [] };
// 中文（普通话 / 台湾 / 香港）语音；1 分钟内复用（Mac 上新下载了语音，过一会儿就能出现在列表里）
export async function ttsVoices() {
  return [...volcVoices(), ...await edgeVoiceList(), ...await macVoices()];
}
async function macVoices() {
  if (process.platform !== 'darwin') return [];
  if (Date.now() - voiceCache.at < 60000) return voiceCache.list;
  const out = await run('say', ['-v', '?']).catch(() => '');
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/);
    if (!m || !/^(zh|yue|cmn)_/i.test(m[2])) continue;
    list.push({ name: m[1].trim(), lang: m[2].replace('_', '-'), engine: 'mac' });
  }
  voiceCache = { at: Date.now(), list };
  return list;
}

// ---------- 裁掉首尾静音 ----------
// 微软的音频每段前面带约 0.15 秒、后面带约 0.85 秒静音，手机一段接一段放，每个切口就停 1 秒。
// 这里在电脑上解码（afconvert）→ 裁掉首尾静音、按标点留一点自然停顿 → 重新编成 AAC；约 0.1 秒。
function wavInfo(b) {
  let pos = 12, fmt = null, data = null;
  while (pos + 8 <= b.length) {
    const id = b.toString('ascii', pos, pos + 4), size = b.readUInt32LE(pos + 4);
    if (id === 'fmt ') fmt = { ch: b.readUInt16LE(pos + 10), rate: b.readUInt32LE(pos + 12), bits: b.readUInt16LE(pos + 22) };
    else if (id === 'data') { data = { off: pos + 8, len: Math.min(size, b.length - pos - 8) }; break; }
    pos += 8 + size + (size & 1);
  }
  return fmt && data && fmt.bits === 16 ? { ...fmt, ...data } : null;
}
function wavBuild(pcm, rate, ch) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(ch, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * ch * 2, 28);
  h.writeUInt16LE(ch * 2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}
const pauseFor = text => /[。！？!?；;]\s*$/.test(text) ? 0.3 : /[，,：:、]\s*$/.test(text) ? 0.12 : 0.2;
async function trimAudio(buf, ext, text) {
  const base = path.join(os.tmpdir(), 'claclaw-trim-' + crypto.randomBytes(6).toString('hex'));
  const src = base + '.' + ext, wav = base + '.wav', out = base + '.m4a';
  try {
    fs.writeFileSync(src, buf);
    await run('afconvert', ['-f', 'WAVE', '-d', 'LEI16', src, wav]);
    const w = fs.readFileSync(wav), info = wavInfo(w);
    if (!info) return null;
    const frame = info.ch * 2, n = Math.floor(info.len / frame), th = 400;
    const amp = i => Math.abs(w.readInt16LE(info.off + i * frame));
    let a = 0, z = n - 1;
    while (a < n && amp(a) < th) a++;
    while (z > a && amp(z) < th) z--;
    if (a >= z) return null;
    const from = Math.max(0, a - Math.round(0.03 * info.rate)), to = Math.min(n, z + Math.round(0.06 * info.rate));
    const gap = Buffer.alloc(Math.round(pauseFor(text) * info.rate) * frame);   // 句末的自然停顿（静音）
    const pcm = Buffer.concat([w.subarray(info.off + from * frame, info.off + to * frame), gap]);
    fs.writeFileSync(wav, wavBuild(pcm, info.rate, info.ch));
    await run('afconvert', ['-f', 'm4af', '-d', 'aac', wav, out]);
    return fs.readFileSync(out);
  } catch { return null; }
  finally { for (const f of [src, wav, out]) fs.rm(f, { force: true }, () => {}); }
}

// 付费声音（豆包，按字数收费）的合成结果缓存：念过的每一句都存盘（data/tts-cache/<哈希>.m4a|mp3），同一个声音、语速、文字再念直接用，不再合成。
// 免费的（微软、Mac）不缓存，每次现合成
// 用到一次就续期；超过 7 天没用过的定时清掉
const CACHE_DIR = path.join(DATA, 'tts-cache');
export const TTS_CACHE_DAYS = 7;
const EXT = { 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3' }, TYPE = { m4a: 'audio/mp4', mp3: 'audio/mpeg' };
const cache = {
  get(key) {
    for (const e of Object.keys(TYPE)) {
      const f = path.join(CACHE_DIR, key + '.' + e);
      try { const buf = fs.readFileSync(f); const now = new Date(); fs.utimes(f, now, now, () => {}); return { buf, type: TYPE[e] }; } catch {}
    }
    return null;
  },
  set(key, out) {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 }); const f = path.join(CACHE_DIR, key + '.' + (EXT[out.type] || 'mp3')); fs.writeFileSync(f + '.tmp', out.buf); fs.renameSync(f + '.tmp', f); } catch {}
  },
};
export function ttsCachePrune(now = Date.now()) {
  let n = 0;
  try { for (const f of fs.readdirSync(CACHE_DIR)) { const p = path.join(CACHE_DIR, f); try { if (now - fs.statSync(p).mtimeMs > TTS_CACHE_DAYS * 86400e3) { fs.rmSync(p, { force: true }); n++; } } catch {} } } catch {}
  return n;
}
setTimeout(ttsCachePrune, 30e3).unref?.();
setInterval(ttsCachePrune, 6 * 3600e3).unref?.();
let running = 0;
const waiters = [];
const slot = () => running < 2 ? (running++, Promise.resolve()) : new Promise(ok => waiters.push(ok));
const release = () => { const w = waiters.shift(); if (w) w(); else running--; };

// ── 连续朗读（豆包）：一整段做成一条连续的 mp3 流 ─────────────────────────────
// 一句一个文件时，下一句要靠网页的 JS 去取；手机锁屏后网页停了（经 clarelay 直连时连通道也断），念完这句就断。
// 改成浏览器自己取一条流：锁屏后 <audio> 照样往下读、往下放，跟听播客一样。
// 服务端按顺序一句句合成（带 section_id，语气接得上），合成好的接着写进流；只比实际播放领先 STREAM_AHEAD 秒（停了不白花钱）。
// 同一条流浏览器可能连着请求两次（先探一下再正式取）：合成结果存在任务里，重来的直接从头回放，不重复计费。
export const STREAM_AHEAD = 45;
const jobs = new Map();
// mp3 时长：数帧（MPEG1/2/2.5 Layer III）；开头的 ID3 标签跳过
export function mp3Dur(buf) {
  let i = 0, sec = 0;
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'ID3') i = 10 + ((buf[6] & 0x7f) << 21 | (buf[7] & 0x7f) << 14 | (buf[8] & 0x7f) << 7 | (buf[9] & 0x7f));
  const BR = { 1: [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320], 2: [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] };
  const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff || (buf[i + 1] & 0xe0) !== 0xe0) { i++; continue; }
    const ver = (buf[i + 1] >> 3) & 3, layer = (buf[i + 1] >> 1) & 3, bri = buf[i + 2] >> 4, sri = (buf[i + 2] >> 2) & 3, pad = (buf[i + 2] >> 1) & 1;
    if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) { i++; continue; }
    const sr = SR[ver][sri], br = BR[ver === 3 ? 1 : 2][bri] * 1000, spf = ver === 3 ? 1152 : 576;
    const len = Math.floor((spf / 8) * br / sr) + pad;
    if (len < 4) { i++; continue; }
    sec += spf / sr; i += len;
  }
  return sec;
}
export function ttsJob({ parts, voice, rate, sec } = {}) {
  voice = String(voice || '');
  if (!voice.startsWith('volc:')) throw new Error('只有豆包的声音能连续朗读');
  parts = (Array.isArray(parts) ? parts : []).map(p => String(p || '').replace(/\s+/g, ' ').trim().slice(0, 1000)).filter(Boolean).slice(0, 300);
  if (!parts.length) throw new Error('没有要念的文字');
  for (const [k, j] of jobs) if (Date.now() - j.at > 3 * 3600e3 || jobs.size > 8) { j.ac.abort(); jobs.delete(k); }
  const id = crypto.randomBytes(12).toString('base64url');
  jobs.set(id, { parts, sp: voice.slice(5), rate: Math.min(2.2, Math.max(0.5, Number(rate) || 1)), sec: /^[\w-]{8,64}$/.test(String(sec || '')) ? String(sec) : '', at: Date.now(), bufs: [], durs: [], made: [], readers: 0, lastRead: Date.now(), t0: 0, done: false, error: '', ac: new AbortController() });
  return id;
}
// 播到哪了：每句的时长（秒），网页拿它把 currentTime 换成「第几句」
export function ttsJobInfo(id) { const j = jobs.get(id); return j && { n: j.parts.length, durs: j.durs, done: j.done, error: j.error }; }
// 第 i 句：按顺序合成（前一句好了才合成这一句，section_id 才接得上），领先播放太多就等着；没人在听超过 20 秒就放弃
function jobPart(j, i, synth) {
  return j.made[i] ||= (async () => {
    if (i > 0) await jobPart(j, i - 1, synth);
    for (;;) {
      if (j.ac.signal.aborted) throw new Error('已取消');
      const ahead = j.durs.reduce((a, b) => a + b, 0) - (j.t0 ? (Date.now() - j.t0) / 1000 : 0);
      if (!j.readers && Date.now() - j.lastRead > 20000) { j.ac.abort(); throw new Error('没人在听了'); }
      if (i === 0 || (j.readers && ahead < STREAM_AHEAD)) break;
      await new Promise(r => setTimeout(r, 500));
    }
    const buf = await synth(j.parts[i], j.sp, j.rate, undefined, 30000, j.ac.signal, j.sec);
    j.bufs[i] = buf; j.durs[i] = mp3Dur(buf);
    return buf;
  })();
}
// 把任务写进 HTTP 响应（audio/mpeg，不给长度，边合成边写）；返回写了几句
export async function ttsStream(id, res, { synth = volcSay, log = () => {} } = {}) {
  const j = jobs.get(id);
  if (!j) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); res.end('没有这个朗读（过期了）'); return 0; }
  res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-store', 'accept-ranges': 'none', 'x-accel-buffering': 'no' });
  j.readers++; let closed = false, n = 0;
  res.on('close', () => { closed = true; });
  try {
    for (let i = 0; i < j.parts.length && !closed; i++) {
      let buf;
      try { buf = await jobPart(j, i, synth); }
      catch (e) { if (!j.ac.signal.aborted) { j.error = e.message; log('tts stream', i + 1 + '/' + j.parts.length, e.message); } break; }
      if (closed) break;
      if (!j.t0) j.t0 = Date.now();
      j.lastRead = Date.now();
      if (!res.write(buf)) await new Promise(r => { res.once('drain', r); res.once('close', r); });
      n++;
    }
    if (n === j.parts.length) j.done = true;
  } finally { j.readers--; j.lastRead = Date.now(); if (!closed) res.end(); }
  return n;
}

export async function ttsSynth(text, voice, rate, signal = null, sec = '') {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new Error('没有要念的文字');
  const voices = await ttsVoices();
  if (!voices.some(v => v.name === voice)) throw new Error('电脑上没有这个声音：' + voice);
  const r = Math.min(2.2, Math.max(0.5, Number(rate) || 1));
  if (voice.startsWith('volc:')) {
    const key = crypto.createHash('sha1').update(voice + '|' + r + '|' + VOLC_TONE + '|' + text).digest('hex');
    { const hit = cache.get(key); if (hit) return hit; }
    const raw = await volcSay(text, voice.slice(5), r, undefined, 30000, signal, sec);
    const trimmed = process.platform === 'darwin' ? await trimAudio(raw, 'mp3', text) : null;
    const out = trimmed ? { buf: trimmed, type: 'audio/mp4' } : { buf: raw, type: 'audio/mpeg' };
    cache.set(key, out);
    return out;
  }
  if (voice.startsWith('edge:')) {
    const pct = Math.round((r - 1) * 100);
    const res = await edgeCall({ op: 'say', text, voice: voice.slice(5), rate: (pct >= 0 ? '+' : '') + pct + '%' });
    const raw = Buffer.from(res.audio, 'base64');
    if (!raw.length) throw new Error('微软语音没有返回声音');
    const trimmed = process.platform === 'darwin' ? await trimAudio(raw, 'mp3', text) : null;
    const out = trimmed ? { buf: trimmed, type: 'audio/mp4' } : { buf: raw, type: 'audio/mpeg' };
    return out;
  }
  const wpm = Math.round(Math.min(2.2, Math.max(0.5, Number(rate) || 1)) * 190);   // say 的语速是「每分钟词数」，190 约等于正常语速
  const key = crypto.createHash('sha1').update(voice + '|' + wpm + '|' + text).digest('hex');
  await slot();
  const file = path.join(os.tmpdir(), 'claclaw-tts-' + key + '.m4a');
  try {
    // 文字放在 -- 之后，开头是 - 也不会被当成参数
    await run('say', ['-v', voice, '-r', String(wpm), '--file-format=m4af', '--data-format=aac', '-o', file, '--', text]);
    const out = { buf: (await trimAudio(fs.readFileSync(file), 'm4a', text)) || fs.readFileSync(file), type: 'audio/mp4' };
    return out;
  } finally {
    release();
    fs.rm(file, { force: true }, () => {});
  }
}
