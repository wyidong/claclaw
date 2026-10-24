// 聊天里点文件路径：路径解析、本机打开方式（会执行的只在访达里选中）、预览类型
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanUserPath, findUserPath, openArgs, previewType } from '../localfile.mjs';

const HOME = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-lf-')));
const WS = path.join(HOME, 'ws');                       // 会话开在上级目录
fs.mkdirSync(path.join(WS, 'repo', 'data'), { recursive: true });
fs.writeFileSync(path.join(WS, 'repo', 'data', 'note.md'), '# hi\n');
fs.writeFileSync(path.join(WS, 'top.txt'), 'top');
fs.writeFileSync(path.join(HOME, 'h.txt'), 'home');

test('去掉行号、锚点、引号，展开 ~，不认 URL', () => {
  assert.equal(cleanUserPath('server.mjs:123', HOME), 'server.mjs');
  assert.equal(cleanUserPath('a.mjs:12:5', HOME), 'a.mjs');
  assert.equal(cleanUserPath('a.md#L5-L9', HOME), 'a.md');
  assert.equal(cleanUserPath('"x y.md"', HOME), 'x y.md');
  assert.equal(cleanUserPath('~/a.md', HOME), HOME + '/a.md');
  assert.equal(cleanUserPath('https://x.com/a.md', HOME), '');
  assert.equal(cleanUserPath('a\0b', HOME), '');
});

test('相对路径：会话目录 → 下一层目录 → 主目录', () => {
  assert.equal(findUserPath('top.txt', WS, HOME).abs, path.join(WS, 'top.txt'));
  assert.equal(findUserPath('data/note.md:3', WS, HOME).abs, path.join(WS, 'repo', 'data', 'note.md'));
  assert.equal(findUserPath('h.txt', WS, HOME).abs, path.join(HOME, 'h.txt'));
  assert.equal(findUserPath(path.join(WS, 'top.txt'), '', HOME).abs, path.join(WS, 'top.txt'));
  assert.equal(findUserPath('nope.md', WS, HOME), null);
  assert.equal(findUserPath('top.txt', 'relative/cwd', HOME).abs, path.join(WS, 'top.txt'));   // cwd 不是绝对路径：按主目录（及其下一层）找
});

test('会执行代码的不直接打开，只在访达里选中', () => {
  const f = path.join(HOME, 'run.command'); fs.writeFileSync(f, 'echo hi');
  const x = path.join(HOME, 'tool'); fs.writeFileSync(x, '#!/bin/sh'); fs.chmodSync(x, 0o755);
  const app = path.join(HOME, 'X.app'); fs.mkdirSync(app);
  const md = path.join(WS, 'top.txt');
  assert.deepEqual(openArgs(f, fs.statSync(f)), ['-R', f]);
  assert.deepEqual(openArgs(x, fs.statSync(x)), ['-R', x]);
  assert.deepEqual(openArgs(app, fs.statSync(app)), ['-R', app]);
  assert.deepEqual(openArgs(md, fs.statSync(md)), [md]);
  assert.deepEqual(openArgs(WS, fs.statSync(WS)), [WS]);   // 普通文件夹：在访达里打开
});

test('预览类型：图片 / PDF 按扩展名，没有 0 字节的当文本', () => {
  const g = path.join(HOME, 'main.go'); fs.writeFileSync(g, 'package main\n');
  const bin = path.join(HOME, 'blob.dat'); fs.writeFileSync(bin, Buffer.from([1, 0, 2]));
  assert.equal(previewType(path.join(HOME, 'a.PNG'), 10), 'image/png');
  assert.equal(previewType(path.join(HOME, 'a.pdf'), 10), 'application/pdf');
  assert.equal(previewType(g, fs.statSync(g).size), 'text/plain; charset=utf-8');
  assert.equal(previewType(bin, 3), 'application/octet-stream');
});
