// DeepSeek 会话改名：往追加式会话日志里写一条 session/title，列表要读到新标题
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-rename-'));
const SID = '11111111-2222-4333-8444-555555555555';
const CWD = '/tmp/dsh-rename-test';
const DIR = path.join(DSH, 'sessions', '--tmp-dsh-rename-test--', SID);
fs.mkdirSync(DIR, { recursive: true });
const header = { type: 'session', version: 4, id: SID, createdAt: Date.now(), cwd: CWD, isSeeded: false, delegationDepth: 0 };
const first = { type: 'permission/preset', seq: 0, time: Date.now(), data: { preset: 'workspace-write' } };
const log = Buffer.from(JSON.stringify(header) + '\n' + JSON.stringify(first) + '\n');
fs.writeFileSync(path.join(DIR, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(log));

process.env.DSH_HOME = DSH;
const { dsRename, dsSessionList, dsSupported } = await import('../dsh.mjs');

after(() => fs.rmSync(DSH, { recursive: true, force: true }));

test('改名后列表读到新标题，序号接在最后一条之后', { skip: !dsSupported() }, async () => {
  const id = 'ds:' + SID;
  assert.equal(dsSessionList().find(s => s.id === id)?.title, '新会话');
  const r = await dsRename(id, '  HTTP 改名验证  ');
  assert.equal(r.title, 'HTTP 改名验证');
  assert.equal(r.seq, 1);
  assert.equal(dsSessionList().find(s => s.id === id)?.title, 'HTTP 改名验证');
});

test('找不到会话时报 404', { skip: !dsSupported() }, async () => {
  await assert.rejects(() => dsRename('ds:00000000-0000-4000-8000-000000000000', 'x'), (e) => e.code === 404);
});

test('空标题被拒绝', { skip: !dsSupported() }, async () => {
  await assert.rejects(() => dsRename('ds:' + SID, '   '), (e) => e.code === 400);
});
