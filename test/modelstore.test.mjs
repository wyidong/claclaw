import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { emptyStore, applyOp, publicView, loadStore, saveStore } from '../modelstore.mjs';

const KEY = 'sk-test-0123456789abcdefWXYZ';
const add = (s, b) => applyOp(s, { op: 'provider-save', ...b });
const err = (fn, re) => assert.throws(fn, e => e.user === true && re.test(e.message));

test('供应商：新增（ID 自动按名字生成、重名加序号）、改名改地址、key 留空不改 / 整个替换 / 清掉', () => {
  const s = emptyStore();
  assert.equal(add(s, { name: 'DeepSeek', endpoints: { anthropic: 'https://api.deepseek.com/anthropic/', openai: 'https://api.deepseek.com' }, key: KEY }).saved, 'deepseek');
  assert.equal(s.providers[0].endpoints.anthropic, 'https://api.deepseek.com/anthropic');   // 去掉末尾的 /
  assert.equal(add(s, { name: 'deepseek 备用', endpoints: { openai: 'https://x.example' } }).saved, 'deepseek-2');
  assert.match(add(s, { name: '月之暗面', endpoints: { openai: 'https://api.moonshot.cn/v1' } }).saved, /^p-[0-9a-f]{6}$/);   // 名字里没有字母数字
  add(s, { orig: 'deepseek', name: 'DeepSeek 官方', endpoints: { openai: 'https://api.deepseek.com' }, key: '' });
  assert.equal(s.providers[0].name, 'DeepSeek 官方');
  assert.equal(s.providers[0].key, KEY, 'key 留空 = 不改');
  assert.equal(s.providers[0].endpoints.anthropic, undefined, '清空的地址去掉');
  add(s, { orig: 'deepseek', name: 'DeepSeek 官方', endpoints: { openai: 'https://api.deepseek.com' }, key: 'sk-new-9999' });
  assert.equal(s.providers[0].key, 'sk-new-9999');
  add(s, { orig: 'deepseek', name: 'DeepSeek 官方', endpoints: { openai: 'https://api.deepseek.com' }, clearKey: true });
  assert.equal(s.providers[0].key, undefined);
});

test('供应商：输入检查', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' } });
  err(() => add(s, { name: '', endpoints: { openai: 'https://a.example' } }), /名字/);
  err(() => add(s, { name: 'B', endpoints: {} }), /至少填一个/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'ftp://a' } }), /https/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'https://u:p@a.example' } }), /用户名密码/);
  err(() => add(s, { name: 'B', endpoints: { openai: 'https://a.example/?key=1' } }), /\?/);
  err(() => add(s, { name: 'B', endpoints: { openai: '不是网址' } }), /不是网址/);
  err(() => add(s, { name: 'A', endpoints: { openai: 'https://b.example' } }), /已经有/);
  err(() => add(s, { name: 'C', id: 'A B', endpoints: { openai: 'https://b.example' } }), /小写字母/);
  err(() => add(s, { name: 'C', id: 'a', endpoints: { openai: 'https://b.example' } }), /已经有/);
  err(() => add(s, { name: 'C', endpoints: { openai: 'https://b.example' }, key: 'sk a' }), /空格/);
  err(() => add(s, { orig: 'nope', name: 'C', endpoints: { openai: 'https://b.example' } }), /没有这个供应商/);
  err(() => applyOp(s, { op: 'xx' }), /不认识/);
});

test('模型：增、改（可改 ID）、删；同一供应商下 ID 不重复', () => {
  const s = emptyStore();
  add(s, { name: 'DeepSeek', endpoints: { openai: 'https://api.deepseek.com' } });
  const m = b => applyOp(s, { op: 'model-save', provider: 'deepseek', ...b });
  m({ id: 'deepseek-v4-pro', name: 'V4 Pro', context: 1000000, reasoning: true });
  m({ id: 'deepseek-v4-flash', context: '' });
  assert.deepEqual(s.providers[0].models, [{ id: 'deepseek-v4-pro', name: 'V4 Pro', context: 1000000, reasoning: true }, { id: 'deepseek-v4-flash' }]);
  err(() => m({ id: 'deepseek-v4-pro' }), /已经有/);
  err(() => m({ id: 'a b' }), /模型 ID/);
  err(() => m({ id: 'x', context: 12 }), /上下文/);
  m({ orig: 'deepseek-v4-flash', id: 'deepseek-v4-lite', vision: true });
  assert.deepEqual(s.providers[0].models[1], { id: 'deepseek-v4-lite', vision: true });
  err(() => m({ orig: 'deepseek-v4-lite', id: 'deepseek-v4-pro' }), /已经有/);
  m({ id: 'Qwen/Qwen3-Coder-480B' });
  applyOp(s, { op: 'model-delete', provider: 'deepseek', id: 'deepseek-v4-lite' });
  assert.deepEqual(s.providers[0].models.map(x => x.id), ['deepseek-v4-pro', 'Qwen/Qwen3-Coder-480B']);
  err(() => applyOp(s, { op: 'model-delete', provider: 'deepseek', id: 'nope' }), /没有这个模型/);
  err(() => applyOp(s, { op: 'model-save', provider: 'nope', id: 'x' }), /没有这个供应商/);
});

test('删除供应商：返回删掉的（调用方备份）', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: KEY });
  const r = applyOp(s, { op: 'provider-delete', id: 'a' });
  assert.equal(r.removed.key, KEY);
  assert.equal(s.providers.length, 0);
  err(() => applyOp(s, { op: 'provider-delete', id: 'a' }), /没有这个供应商/);
});

test('给网页看的不带 key，只有后 4 位；存盘权限 600', () => {
  const s = emptyStore();
  add(s, { name: 'A', endpoints: { openai: 'https://a.example' }, key: KEY });
  add(s, { name: 'B', endpoints: { gemini: 'https://b.example' } });
  const v = publicView(s);
  assert.ok(!JSON.stringify(v).includes(KEY.slice(0, -4)));
  assert.deepEqual([v.providers[0].hasKey, v.providers[0].keyLast4, v.providers[1].hasKey], [true, 'WXYZ', false]);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ms-')), f = path.join(dir, 'models.json');
  try {
    saveStore(f, s);
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.deepEqual(loadStore(f), s);
    fs.writeFileSync(f, '{坏的');
    assert.deepEqual(loadStore(f), emptyStore());
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
