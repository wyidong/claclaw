// dsh 0.1 的旧会话文件（session.jsonl.zstd，头里 version 0）：升级到 0.2 后旧会话不转格式，也要能列出来、读得到
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-legacy-'));
const OLD = 'session-043e1aa9-6130-43e5-af10-9ce9e60ba623';
const BOTH = 'session-11111111-2222-4333-8444-555555555555';
const T = Date.parse('2026-08-20T02:00:00Z');
const zst = recs => zlib.zstdCompressSync(Buffer.from(recs.map(r => JSON.stringify(r)).join('\n') + '\n'));

if (HAS_ZSTD) {
  const d = path.join(DSH, 'sessions', '--D-Users-yidong--', OLD);
  fs.mkdirSync(d, { recursive: true });
  // 和真实 0.1 文件一样：一段段 zstd 帧接在一起
  fs.writeFileSync(path.join(d, 'session.jsonl.zstd'), Buffer.concat([
    zst([{ type: 'session', version: 0, id: OLD, createdAt: T, cwd: 'D:\\Users\\yidong', delegationDepth: 0, agentPreset: 'standard' }]),
    zst([
      { type: 'user/message', seq: 7, time: T, data: { content: [{ type: 'text', text: '删除插件 claude-code-skin' }], source: { kind: 'user' }, role: 'user' } },
      { type: 'session/title', seq: 9, time: T, data: { title: '删除插件', source: { kind: 'fallback' } } },
      { type: 'assistant/message', seq: 10, time: T, data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的' }] } } },
    ]),
  ]));
  // 0.2 转过格式的：旧文件还在，读新的 v4
  const b = path.join(DSH, 'sessions', '--tmp--', BOTH);
  fs.mkdirSync(b, { recursive: true });
  fs.writeFileSync(path.join(b, 'session.jsonl.zstd'), zst([{ type: 'session', version: 0, id: BOTH, createdAt: T, cwd: '/tmp' }, { type: 'session/title', seq: 1, time: T, data: { title: '旧标题' } }]));
  fs.writeFileSync(path.join(b, 'session.v4.jsonl.zstd'), zst([{ type: 'session', version: 4, id: BOTH, createdAt: T, cwd: '/tmp' }, { type: 'session/title', seq: 1, time: T, data: { title: '新标题' } }]));
}

process.env.DSH_HOME = DSH;
const { dsSessionList, dsRecordsOf, dsExists } = await import('../dsh.mjs');

test('0.1 的旧会话能列出来，标题和目录对', { skip: !HAS_ZSTD }, () => {
  const s = dsSessionList().find(x => x.id === 'ds:' + OLD);
  assert.ok(s, '旧会话应该在列表里');
  assert.equal(s.title, '删除插件');
  assert.equal(s.cwd, 'D:\\Users\\yidong');
  assert.ok(dsExists('ds:' + OLD));
  assert.equal(dsRecordsOf('ds:' + OLD).filter(r => r.type === 'assistant/message').length, 1);
});

test('同一会话旧文件和 v4 都在时读 v4', { skip: !HAS_ZSTD }, () => {
  assert.equal(dsSessionList().find(x => x.id === 'ds:' + BOTH)?.title, '新标题');
});
