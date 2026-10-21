// DeepSeek 会话改名：往追加式会话日志里写一条 session/title，列表要读到新标题
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

const HAS_ZSTD = typeof zlib.zstdCompressSync === 'function';
const DSH = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-dsh-rename-'));
const SID = '11111111-2222-4333-8444-555555555555';
const CWD = '/tmp/dsh-rename-test';
const DIR = path.join(DSH, 'sessions', '--tmp-dsh-rename-test--', SID);
let lockOk = false;

if (HAS_ZSTD) {
  fs.mkdirSync(DIR, { recursive: true });
  const header = { type: 'session', version: 4, id: SID, createdAt: Date.now(), cwd: CWD, isSeeded: false, delegationDepth: 0 };
  const first = { type: 'permission/preset', seq: 0, time: Date.now(), data: { preset: 'workspace-write' } };
  const log = Buffer.from(JSON.stringify(header) + '\n' + JSON.stringify(first) + '\n');
  fs.writeFileSync(path.join(DIR, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(log));
}

process.env.DSH_HOME = DSH;
process.env.CLACLAW_DATA = path.join(DSH, 'data');   // 别把测试备份写进真实 data/trash
const { dsRename, dsSessionList, dsSupported, dsLockAvailable, dsRunners } = await import('../dsh.mjs');
if (HAS_ZSTD) lockOk = await dsLockAvailable();
const skip = !HAS_ZSTD || !lockOk;

after(() => fs.rmSync(DSH, { recursive: true, force: true }));

test('改名后列表读到新标题，序号接在最后一条之后', { skip }, async () => {
  const id = 'ds:' + SID;
  assert.equal(dsSessionList().find(s => s.id === id)?.title, '新会话');
  const r = await dsRename(id, '  HTTP 改名验证  ');
  assert.equal(r.title, 'HTTP 改名验证');
  assert.equal(r.seq, 1);
  assert.equal(dsSessionList().find(s => s.id === id)?.title, 'HTTP 改名验证');
  const trash = path.join(DSH, 'data', 'trash');
  assert.ok(fs.readdirSync(trash).some(f => f.endsWith('.jsonl.zstd')), '改名前的日志应备份到回收站');
});

test('会话在网页里打开着 / 正在回复时返回 409', { skip }, async () => {
  const id = 'ds:' + SID;
  dsRunners.set(id, { closed: false, subs: new Set([{}]), busy: false, dispose() {} });
  await assert.rejects(() => dsRename(id, 'x'), (e) => e.code === 409);
  dsRunners.set(id, { closed: false, subs: new Set(), busy: true, dispose() {} });
  await assert.rejects(() => dsRename(id, 'x'), (e) => e.code === 409);
  dsRunners.delete(id);
});

test('标题按 dsh 的 80 字节上限和 bidi 规则归一化', { skip }, async () => {
  const id = 'ds:' + SID;
  const r = await dsRename(id, '\u202E' + 'a'.repeat(100));
  assert.equal(r.title.length, 80);
  assert.ok(!r.title.includes('\u202E'));
  assert.equal(dsSessionList().find(s => s.id === id)?.title, r.title);
});

test('找不到会话时报 404', { skip }, async () => {
  await assert.rejects(() => dsRename('ds:00000000-0000-4000-8000-000000000000', 'x'), (e) => e.code === 404);
});

test('空标题被拒绝', { skip }, async () => {
  await assert.rejects(() => dsRename('ds:' + SID, '   '), (e) => e.code === 400);
});

test('日志尾部有半帧时拒绝追加，原标题不变', { skip }, async () => {
  const id = 'ds:' + SID;
  const before = dsSessionList().find(s => s.id === id)?.title;
  fs.appendFileSync(path.join(DIR, 'session.v4.jsonl.zstd'), Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00]));
  await assert.rejects(() => dsRename(id, '不应该写进去'), (e) => e.code === 409);
  assert.equal(dsSessionList().find(s => s.id === id)?.title, before);
});
