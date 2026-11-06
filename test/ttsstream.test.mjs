// 连续朗读：mp3 数帧算时长；流按顺序合成、带同一个 section_id、重来的请求不重复合成
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-ttsstream-'));
process.env.CLACLAW_DATA = DATA;
const { mp3Dur, ttsJob, ttsJobInfo, ttsStream } = await import('../tts.mjs');
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

// MPEG2 Layer III、24kHz、32kbps：一帧 96 字节、576 个采样 = 0.024 秒
const frames = n => Buffer.concat(Array.from({ length: n }, () => { const f = Buffer.alloc(96); f[0] = 0xff; f[1] = 0xf3; f[2] = 0x44; return f; }));
const fakeRes = () => { const r = new EventEmitter(); r.chunks = []; r.writeHead = (c, h) => { r.code = c; r.h = h; }; r.write = b => { r.chunks.push(b); return true; }; r.end = () => { r.ended = true; }; return r; };

test('mp3 时长：数帧；跳过开头的 ID3', () => {
  assert.equal(mp3Dur(frames(10)).toFixed(3), '0.240');
  const id3 = Buffer.concat([Buffer.from('ID3'), Buffer.from([4, 0, 0, 0, 0, 0, 20]), Buffer.alloc(20, 0xff), frames(5)]);
  assert.equal(mp3Dur(id3).toFixed(3), '0.120');
});

test('连续朗读：一句合成完才合成下一句、同一个 section_id、按顺序写进流；第二次请求直接回放', async () => {
  const calls = []; let busy = 0, maxBusy = 0;
  const synth = async (text, sp, rate, key, ms, signal, sec) => { busy++; maxBusy = Math.max(maxBusy, busy); calls.push({ text, sp, sec }); await new Promise(r => setTimeout(r, 5)); busy--; return frames(text.length); };
  assert.throws(() => ttsJob({ parts: ['a'], voice: 'edge:x' }), /豆包/);
  const id = ttsJob({ parts: ['一', '二二', '三三三'], voice: 'volc:zh_male_m191_uranus_bigtts', rate: 1.1, sec: 'ccabc12345' });
  const r1 = fakeRes();
  assert.equal(await ttsStream(id, r1, { synth }), 3);
  assert.equal(r1.code, 200); assert.equal(r1.h['content-type'], 'audio/mpeg'); assert.ok(r1.ended);
  assert.deepEqual(r1.chunks.map(b => b.length / 96), [1, 2, 3]);
  assert.equal(maxBusy, 1, '一次只合成一句');
  assert.deepEqual(calls.map(c => [c.text, c.sp, c.sec]), [['一', 'zh_male_m191_uranus_bigtts', 'ccabc12345'], ['二二', 'zh_male_m191_uranus_bigtts', 'ccabc12345'], ['三三三', 'zh_male_m191_uranus_bigtts', 'ccabc12345']]);
  const info = ttsJobInfo(id);
  assert.ok(info.done); assert.deepEqual(info.durs.map(d => d.toFixed(3)), ['0.024', '0.048', '0.072']);
  const r2 = fakeRes();
  assert.equal(await ttsStream(id, r2, { synth }), 3);
  assert.equal(calls.length, 3, '重来的请求不再合成（不重复计费）');
  const r3 = fakeRes(); await ttsStream('nope', r3, { synth }); assert.equal(r3.code, 404);
});

test('连续朗读：听的人断开了就不再往下合成', async () => {
  let n = 0;
  const id = ttsJob({ parts: ['一', '二', '三'], voice: 'volc:x_uranus_bigtts' });
  const r = fakeRes();
  const synth = async () => { n++; if (n === 1) setTimeout(() => r.emit('close'), 0); await new Promise(res => setTimeout(res, 10)); return frames(1); };
  await ttsStream(id, r, { synth });
  assert.ok(n <= 2, '断开后最多把正在合成的那句做完');
});
