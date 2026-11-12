// 会话头像 / 网名（skins.mjs）：引用校验、清单、保存、上传
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSkins } from '../skins.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-skins-'));
fs.mkdirSync(path.join(DATA, 'avatars', 'qq'), { recursive: true });
fs.writeFileSync(path.join(DATA, 'avatars', 'qq', '01.jpg'), Buffer.from([0xff, 0xd8, 0xff]));
fs.writeFileSync(path.join(DATA, 'avatars', 'qq', 'notes.txt'), 'x');
const sk = makeSkins(DATA, ROOT);
const PNG = 'data:image/png;base64,' + Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(20)]).toString('base64');

test('清单：仓库预设 + 本机目录（排在前面，只列图片）+ 网名', () => {
  const ix = sk.index();
  assert.equal(ix.groups[0].base, 'l/qq');
  assert.deepEqual(ix.groups[0].items, ['01.jpg']);
  assert.ok(ix.groups.some(g => g.base === 'p/animal' && g.items.includes('bear.png')));
  assert.ok(ix.names.length >= 60);
  for (const g of ix.groups) for (const f of g.items) assert.ok(sk.fileOf(g.base + '/' + f), g.base + '/' + f);
});

test('引用校验：不认路径穿越、不认 l/up、不认本机 svg', () => {
  assert.ok(sk.fileOf('p/animal/bear.png'));
  assert.equal(sk.fileOf('p/../server.mjs'), null);
  assert.equal(sk.fileOf('p/animal/../../../server.mjs'), null);
  assert.equal(sk.fileOf('l/up/x.png'), null);
  assert.equal(sk.fileOf('l/qq/a.svg'), null);
  assert.equal(sk.fileOf('u/zz.png'), null);
  assert.equal(sk.fileOf('p/animal/nope.png'), null);
});

test('保存：头像、网名分开改；都清掉就删这一条；坏头像 / 太长的网名报错', () => {
  assert.deepEqual(sk.set('s1', { av: 'p/animal/bear.png' }), { av: 'p/animal/bear.png' });
  assert.deepEqual(sk.set('s1', { name: '  ☆卡布奇諾☆ ' }), { av: 'p/animal/bear.png', name: '☆卡布奇諾☆' });
  assert.throws(() => sk.set('s1', { av: 'p/animal/nope.png' }), /没有这个头像/);
  assert.throws(() => sk.set('s1', { name: 'x'.repeat(41) }), /太长/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DATA, 'skins.json'), 'utf8')).s1.name, '☆卡布奇諾☆');
  assert.equal(sk.set('s1', { av: null, name: '' }), null);
  assert.equal(sk.all().s1, undefined);
});

test('上传：只收 png / jpeg / webp，内容要对得上，按哈希存同一张只一份', () => {
  const a = sk.upload(PNG), b = sk.upload(PNG);
  assert.match(a, /^u\/[a-f0-9]{16}\.png$/);
  assert.equal(a, b);
  assert.ok(sk.fileOf(a));
  assert.deepEqual(sk.set('s2', { av: a }), { av: a });
  assert.throws(() => sk.upload('data:image/svg+xml;base64,PHN2Zz4='), /只支持/);
  assert.throws(() => sk.upload('data:image/jpeg;base64,' + Buffer.from('hello').toString('base64')), /对不上/);
});

test('个性提示音 / 抖一抖：只收认识的声音或 off，只有这两样也留下这一条，清掉就删', () => {
  const s2 = makeSkins(fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-skins2-')), ROOT, { soundOk: (n) => n === 'Glass' });
  assert.deepEqual(s2.set('a', { snd: 'Glass' }), { snd: 'Glass' });
  assert.deepEqual(s2.set('a', { still: true }), { snd: 'Glass', still: true });
  assert.deepEqual(s2.set('a', { snd: 'off' }), { snd: 'off', still: true });
  assert.throws(() => s2.set('a', { snd: 'Nope' }), /没有这个提示音/);
  assert.deepEqual(s2.set('a', { av: null, name: null }), { snd: 'off', still: true });   // 清头像网名不动提示音
  assert.equal(s2.set('a', { snd: null, still: false }), null);
  assert.equal(s2.all().a, undefined);
});

test('预设改名：旧引用读出来换成新的并存回，旧网址也能取到新图', () => {
  const D2 = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-skins-mv-'));
  fs.writeFileSync(path.join(D2, 'skins.json'), JSON.stringify({ a: { av: 'p/cartoon/03-zhuque-huo.png' }, b: { av: 'p/cartoon/03-zhuque.png', name: 'x' }, c: { name: 'y' } }));
  const s2 = makeSkins(D2, ROOT);
  const all = s2.all();
  assert.equal(all.a.av, 'p/cartoon/c-zhuque-huo.png');
  assert.equal(all.b.av, 'p/cartoon/c-zhuque-huo.png');
  assert.equal(all.c.name, 'y');
  assert.equal(JSON.parse(fs.readFileSync(path.join(D2, 'skins.json'), 'utf8')).a.av, 'p/cartoon/c-zhuque-huo.png');
  assert.equal(s2.fileOf('p/cartoon/03-zhuque-huo.png'), s2.fileOf('p/cartoon/c-zhuque-huo.png'));
  assert.ok(s2.fileOf('p/cartoon/c-zhuque-huo.png'));
});
