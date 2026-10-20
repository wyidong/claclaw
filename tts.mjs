// 电脑合成语音：用 macOS 自带的 say 把文字合成 AAC 音频，给手机网页播放。
// iPhone 只开放很少几个语音给网页；电脑这边能用 Mac 上装的所有中文语音（系统设置里下载的「优化音质」也算）。
// 不联网、不花钱；一句一句合成，首句约 0.3 秒出来。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';

const run = (cmd, args, ms = 20000) => new Promise((ok, no) =>
  execFile(cmd, args, { timeout: ms, maxBuffer: 4 * 1024 * 1024 }, (e, out, err) => e ? no(new Error(String(err || e.message).trim())) : ok(String(out))));

let voiceCache = { at: 0, list: [] };
// 中文（普通话 / 台湾 / 香港）语音；1 分钟内复用（Mac 上新下载了语音，过一会儿就能出现在列表里）
export async function ttsVoices() {
  if (process.platform !== 'darwin') return [];
  if (Date.now() - voiceCache.at < 60000) return voiceCache.list;
  const out = await run('say', ['-v', '?']).catch(() => '');
  const list = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(.+?)\s+([a-z]{2,3}_[A-Za-z0-9]+)\s+#/);
    if (!m || !/^(zh|yue|cmn)_/i.test(m[2])) continue;
    list.push({ name: m[1].trim(), lang: m[2].replace('_', '-') });
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
  const wpm = Math.round(Math.min(2.2, Math.max(0.5, Number(rate) || 1)) * 190);   // say 的语速是「每分钟词数」，190 约等于正常语速
  const key = crypto.createHash('sha1').update(voice + '|' + wpm + '|' + text).digest('hex');
  if (cache.has(key)) { const b = cache.get(key); cache.delete(key); cache.set(key, b); return b; }
  await slot();
  const file = path.join(os.tmpdir(), 'claclaw-tts-' + key + '.m4a');
  try {
    // 文字放在 -- 之后，开头是 - 也不会被当成参数
    await run('say', ['-v', voice, '-r', String(wpm), '--file-format=m4af', '--data-format=aac', '-o', file, '--', text]);
    const buf = fs.readFileSync(file);
    cache.set(key, buf);
    while (cache.size > 60) cache.delete(cache.keys().next().value);
    return buf;
  } finally {
    release();
    fs.rm(file, { force: true }, () => {});
  }
}
