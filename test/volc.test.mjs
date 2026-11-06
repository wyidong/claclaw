// 火山豆包语音：拼音频块、错误信息不带 Key、保存 Key 只记能用的资源
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-volc-'));
process.env.CLACLAW_DATA = DATA;
const { volcSay, volcSetKey, volcInfo, ttsVoices } = await import('../tts.mjs');
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
