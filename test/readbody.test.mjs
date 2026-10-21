// readBody：按字节算大小 + 跨分块的多字节字符不能乱码
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readBody } from '../httpbody.mjs';

const body = (text) => Readable.from([Buffer.from(text, 'utf8')]);

test('正常读出 body', async () => {
  assert.equal(await readBody(body('你好'), 1024), '你好');
});

test('超出字节上限就报错', async () => {
  await assert.rejects(() => readBody(body('中'.repeat(500)), 1024), /too large/);
});

test('按字符算会漏掉的量，按字节算能挡住', async () => {
  // 500 个汉字：字符数 500 < 1024，但字节数 1500 > 1024
  await assert.rejects(() => readBody(body('中'.repeat(500)), 1024));
  const ok = await readBody(body('a'.repeat(500)), 1024);
  assert.equal(ok.length, 500);
});

test('多字节字符跨在分块边界上也不乱码', async () => {
  // 「中文」两个字 6 字节，从第 2 字节切开 —— 逐块解码的写法会得到乱码
  const buf = Buffer.from('中文', 'utf8');
  const r = Readable.from([buf.subarray(0, 2), buf.subarray(2)]);
  assert.equal(await readBody(r, 1024), '中文');
});

test('分得更碎也不乱码', async () => {
  const text = '中文测试 abc 123';
  const buf = Buffer.from(text, 'utf8');
  const r = Readable.from([...buf].map(b => Buffer.from([b])));
  assert.equal(await readBody(r, 1024), text);
});
