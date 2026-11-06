// 火山豆包语音：拼音频块、错误信息不带 Key、保存 Key 只记能用的资源
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-volc-'));
process.env.CLACLAW_DATA = DATA;
const { volcSay, volcSetKey, volcInfo, ttsVoices, ttsSynth, ttsCachePrune, TTS_CACHE_DAYS, VOLC_TONE } = await import('../tts.mjs');
const realFetch = globalThis.fetch;
after(() => { globalThis.fetch = realFetch; fs.rmSync(DATA, { recursive: true, force: true }); });
const KEY = 'k-1234567890-abcd';
const reply = (status, text) => ({ ok: status === 200, status, text: async () => text });

test('音频块按顺序拼起来；一行一个和粘在一起都认', async () => {
  const seen = [];
  globalThis.fetch = async (url, o) => { seen.push(o.headers); return reply(200, JSON.stringify({ code: 0, data: Buffer.from('ab').toString('base64') }) + '\n' + JSON.stringify({ code: 0, data: Buffer.from('c}"d').toString('base64') }) + JSON.stringify({ code: 20000000, message: 'ok', data: null })); };
  assert.equal(String(await volcSay('你好', 'zh_female_vv_uranus_bigtts', 1, KEY)), 'abc}"d');
  assert.equal(seen[0]['x-api-key'], KEY);
  assert.equal(seen[0]['x-api-resource-id'], 'seed-tts-2.0');
  await volcSay('你好', 'zh_female_tianmeitaozi_mars_bigtts', 1, KEY);
  assert.equal(seen[1]['x-api-resource-id'], 'seed-tts-1.0');
});

test('出错：说人话，不带 Key', async () => {
  globalThis.fetch = async () => reply(401, JSON.stringify({ header: { code: 45000010, message: 'Invalid X-Api-Key' } }));
  await assert.rejects(volcSay('x', 'zh_female_vv_uranus_bigtts', 1, KEY), /API Key 不对/);
  globalThis.fetch = async () => reply(200, JSON.stringify({ code: 55000000, message: 'boom ' + KEY }));
  await assert.rejects(volcSay('x', 'zh_female_vv_uranus_bigtts', 1, KEY), e => /55000000/.test(e.message) && !e.message.includes(KEY));
});

test('保存 Key：只记试通的资源，声音列表只列那一类；清空就删掉', async () => {
  globalThis.fetch = async (url, o) => o.headers['x-api-resource-id'] === 'seed-tts-2.0'
    ? reply(200, JSON.stringify({ code: 0, data: 'AA==' }) + JSON.stringify({ code: 20000000 }))
    : reply(200, JSON.stringify({ code: 45000000, message: 'resource not granted' }));
  const r = await volcSetKey(KEY);
  assert.deepEqual([r.set, r.tail, r.res], [true, 'abcd', ['seed-tts-2.0']]);
  assert.equal((fs.statSync(path.join(DATA, 'volc-tts.json')).mode & 0o777).toString(8), process.platform === 'win32' ? (fs.statSync(path.join(DATA, 'volc-tts.json')).mode & 0o777).toString(8) : '600');
  const vs = (await ttsVoices()).filter(v => v.engine === 'volc');
  assert.ok(vs.length && vs.every(v => /_uranus_/.test(v.name)));
  assert.equal(JSON.stringify(volcInfo()).includes(KEY), false);
  await volcSetKey('');
  assert.equal(volcInfo().set, false);
  globalThis.fetch = async () => reply(401, JSON.stringify({ header: { code: 45000010, message: 'Invalid X-Api-Key' } }));
  await assert.rejects(volcSetKey('bad'), /API Key 不对/);
  assert.equal(volcInfo().set, false);
});

test('念过的句子存盘，再念不再合成；7 天没用的清掉', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return reply(200, JSON.stringify({ code: 0, data: Buffer.from('mp3data').toString('base64') }) + JSON.stringify({ code: 20000000 })); };
  await volcSetKey(KEY);
  calls = 0;
  const v = 'volc:zh_female_vv_uranus_bigtts';
  const a = await ttsSynth('缓存测试一句', v, 1);
  const b = await ttsSynth('缓存测试一句', v, 1);
  assert.equal(calls, 1);
  assert.deepEqual(b.buf, a.buf);
  await ttsSynth('缓存测试一句', v, 1.2);   // 语速不同算另一句
  assert.equal(calls, 2);
  const dir = path.join(DATA, 'tts-cache');
  assert.equal(fs.readdirSync(dir).length, 2);
  assert.equal(ttsCachePrune(Date.now() + (TTS_CACHE_DAYS - 1) * 86400e3), 0);
  assert.equal(ttsCachePrune(Date.now() + (TTS_CACHE_DAYS + 1) * 86400e3), 2);
  await ttsSynth('缓存测试一句', v, 1);
  assert.equal(calls, 3);
});

test('方言：Vivi 用官方方言参数，男声用语音指令', async () => {
  const seen = [];
  globalThis.fetch = async (url, o) => { seen.push(JSON.parse(o.body).req_params); return reply(200, JSON.stringify({ code: 0, data: 'AA==' }) + JSON.stringify({ code: 20000000 })); };
  await volcSay('你好', 'zh_female_vv_uranus_bigtts@sichuan', 1, KEY);
  await volcSay('你好', 'zh_male_m191_uranus_bigtts@sichuan', 1, KEY);
  await volcSay('你好', 'zh_male_m191_uranus_bigtts', 1, KEY);
  assert.equal(seen[0].speaker, 'zh_female_vv_uranus_bigtts');
  assert.deepEqual(JSON.parse(seen[0].additions), { explicit_dialect: 'sichuan', context_texts: [VOLC_TONE] });
  assert.equal(seen[1].speaker, 'zh_male_m191_uranus_bigtts');
  assert.deepEqual(JSON.parse(seen[1].additions), { context_texts: ['请用四川话说'] }, '方言指令优先（只有第一条生效）');
  assert.deepEqual(JSON.parse(seen[2].additions), { context_texts: [VOLC_TONE] }, '2.0 音色每句都带同一条语气指令');
});

test('1.0 音色不带语气指令', async () => {
  const seen = [];
  globalThis.fetch = async (url, o) => { seen.push(JSON.parse(o.body).req_params); return reply(200, JSON.stringify({ code: 0, data: 'AA==' }) + JSON.stringify({ code: 20000000 })); };
  await volcSay('你好', 'zh_female_tianmeitaozi_mars_bigtts', 1, KEY);
  assert.equal(seen[0].additions, undefined);
});
