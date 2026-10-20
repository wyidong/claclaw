// 电脑合成语音：电脑把文字合成音频，给手机网页播放（iPhone 只开放很少几个语音给网页）。两种来源：
// - 微软在线语音（Edge 的自然语音，最好听）：要联网，一句约 2 秒，装了 edge-tts 才有（tools/setup-edge-tts.sh）
// - macOS 自带的 say：不联网，一句约 0.3 秒，能用 Mac 上装的中文语音
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DATA } from './auth.mjs';

// ---------- 微软在线语音（Edge 的自然语音：晓伊、晓晓、云希…） ----------
// 装了才有（tools/setup-edge-tts.sh：在 data/edge-tts 里建 Python 环境装 edge-tts）。常驻一个 Python 助手进程，一句约 2 秒。
const EDGE_PY = path.join(DATA, 'edge-tts', 'venv', 'bin', 'python');
const EDGE_HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'tools', 'edge-tts-helper.py');
let edge = null, edgeSeq = 0, edgeVoices = { at: 0, list: [] };
const edgePending = new Map();
function edgeProc() {
  if (edge) return edge;
  if (!fs.existsSync(EDGE_PY)) return null;
  const p = spawn(EDGE_PY, ['-I', EDGE_HELPER], { stdio: ['pipe', 'pipe', 'ignore'] });
  let buf = '';
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
  p.on('exit', () => { if (edge === p) edge = null; for (const q of edgePending.values()) { clearTimeout(q.t); q.no(new Error('微软语音助手退出了')); } edgePending.clear(); });
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

let voiceCache = { at: 0, list: [] };
// 中文（普通话 / 台湾 / 香港）语音；1 分钟内复用（Mac 上新下载了语音，过一会儿就能出现在列表里）
export async function ttsVoices() {
  return [...await edgeVoiceList(), ...await macVoices()];
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

// 合成结果缓存（同一句重听不用再合成）；最多 60 条
const cache = new Map();
let running = 0;
const waiters = [];
const slot = () => running < 2 ? (running++, Promise.resolve()) : new Promise(ok => waiters.push(ok));
const release = () => { const w = waiters.shift(); if (w) w(); else running--; };

export async function ttsSynth(text, voice, rate) {
  text = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 1000);
  if (!text) throw new Error('没有要念的文字');
  const voices = await ttsVoices();
  if (!voices.some(v => v.name === voice)) throw new Error('电脑上没有这个声音：' + voice);
  const r = Math.min(2.2, Math.max(0.5, Number(rate) || 1));
  if (voice.startsWith('edge:')) {
    const key = crypto.createHash('sha1').update(voice + '|' + r + '|' + text).digest('hex');
    if (cache.has(key)) return { buf: cache.get(key), type: 'audio/mpeg' };
    const pct = Math.round((r - 1) * 100);
    const res = await edgeCall({ op: 'say', text, voice: voice.slice(5), rate: (pct >= 0 ? '+' : '') + pct + '%' });
    const buf = Buffer.from(res.audio, 'base64');
    if (!buf.length) throw new Error('微软语音没有返回声音');
    cache.set(key, buf);
    while (cache.size > 60) cache.delete(cache.keys().next().value);
    return { buf, type: 'audio/mpeg' };
  }
  const wpm = Math.round(Math.min(2.2, Math.max(0.5, Number(rate) || 1)) * 190);   // say 的语速是「每分钟词数」，190 约等于正常语速
  const key = crypto.createHash('sha1').update(voice + '|' + wpm + '|' + text).digest('hex');
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return { buf: b, type: 'audio/mp4' }; }
  await slot();
  const file = path.join(os.tmpdir(), 'claclaw-tts-' + key + '.m4a');
  try {
    // 文字放在 -- 之后，开头是 - 也不会被当成参数
    await run('say', ['-v', voice, '-r', String(wpm), '--file-format=m4af', '--data-format=aac', '-o', file, '--', text]);
    const buf = fs.readFileSync(file);
    cache.set(key, buf);
    while (cache.size > 60) cache.delete(cache.keys().next().value);
    return { buf, type: 'audio/mp4' };
  } finally {
    release();
    fs.rm(file, { force: true }, () => {});
  }
}
