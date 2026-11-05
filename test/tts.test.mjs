// 电脑合成语音：没装 / 装坏了微软语音时不能把服务弄崩，声音列表为空（网页就用浏览器自带的声音念）
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-tts-'));
process.env.CLACLAW_DATA = DATA;
// 放一个坏掉的 python（不是可执行文件）：Windows 上 spawn 会同步抛，macOS 上是异步的 error 事件
const py = process.platform === 'win32'
  ? path.join(DATA, 'edge-tts', 'venv', 'Scripts', 'python.exe')
  : path.join(DATA, 'edge-tts', 'venv', 'bin', 'python');
fs.mkdirSync(path.dirname(py), { recursive: true });
fs.writeFileSync(py, 'junk', { mode: 0o600 });
const { ttsVoices, ttsWarm, ttsSynth } = await import('../tts.mjs');
after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('微软语音装坏了：预热不崩，列表里没有微软的声音，合成报错而不是抛到进程级', async () => {
  ttsWarm();
  await new Promise(r => setTimeout(r, 300));
  const list = await ttsVoices();
  assert.ok(Array.isArray(list));
  assert.equal(list.filter(v => v.engine === 'edge').length, 0);
  await assert.rejects(ttsSynth('你好', 'edge:zh-CN-XiaoyiNeural', 1));
});
