#!/usr/bin/env node
// claw-theme：给 claclaw 网页换皮肤（只在现有主题库里选，见 themes.json）。
//   claw-theme                    主题库（id、名字、明暗、颜色、气质）+ 现在用的
//   claw-theme set <主题> [--alt 甲,乙,丙]   换上（所有打开的网页马上变），输出 ```theme 卡片：换上的 + 2～3 个备选，用户点了就换
//   claw-theme show 甲,乙,丙       只出卡片给用户挑，不换
//   claw-theme now                现在用的是哪个
// <主题> 可以写 id（dark、shichen@6）、名字（九紫离火、午 · 少阴心）或别名（深色、紫色、午时、心经）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME_DIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
const THEMES = JSON.parse(fs.readFileSync(path.join(HERE, 'themes.json'), 'utf8'));

function die(msg, code = 1) { process.stdout.write(msg.replace(/\n?$/, '\n')); process.exit(code); }
const norm = s => String(s || '').toLowerCase().replace(/[\s·・.,，、:：「」"'（）()]/g, '');
function find(q) {
  const n = norm(q);
  if (!n) return null;
  return THEMES.find(t => norm(t.id) === n) || THEMES.find(t => norm(t.name) === n) || THEMES.find(t => t.alias.some(a => norm(a) === n))
    || THEMES.find(t => norm(t.name).startsWith(n)) || null;
}
function need(q) { const t = find(q); if (!t) die('没有这个主题：' + q + '\n可选的：' + THEMES.map(t => t.name).join('、'), 2); return t; }

async function call(pathname, body) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'local.json'), 'utf8')); } catch { die('claclaw 没在运行（找不到 ' + path.join(HOME_DIR, 'local.json') + '），请先启动 claclaw'); }
  try {
    const r = await fetch(j.url + pathname, { method: body ? 'POST' : 'GET', headers: { 'x-claclaw-local': j.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const o = await r.json().catch(() => null);
    if (!o) die('claclaw 没认这个命令（' + r.status + '），可能要重启 claclaw 才能换主题');
    return o;
  } catch (e) { die('claclaw 没有响应（' + (e.cause?.code || e.message) + '），请先启动 claclaw'); }
}
function cards(list) {
  const seen = new Set();
  const rows = list.filter(t => t && !seen.has(t.id) && seen.add(t.id)).map(t => [t.id, t.name, t.color + (t.tone === '自动' ? '' : '，' + t.tone + '色')].join(' | '));
  return '```theme\n' + rows.join('\n') + '\n```';
}
function table(cur) {
  return THEMES.map(t => (t.id === cur ? '* ' : '  ') + t.id.padEnd(11) + ' ' + t.name + ' ｜' + t.tone + ' ｜' + t.color + ' ｜' + t.mood).join('\n');
}
function alts(argv) {
  const i = argv.indexOf('--alt'); if (i < 0) return [];
  return String(argv[i + 1] || '').split(/[,，、]/).map(s => s.trim()).filter(Boolean).map(need);
}

const argv = process.argv.slice(2), cmd = argv[0] || 'list';
if (cmd === 'list' || cmd === 'ls') {
  const j = await call('/api/local/theme');
  process.stdout.write('现在用的：' + (find(j.theme)?.name || j.theme) + '（* 标出）\n\n' + table(j.theme) + '\n');
} else if (cmd === 'now') {
  const j = await call('/api/local/theme');
  const t = find(j.theme);
  process.stdout.write('现在用的：' + (t ? t.name + '（' + t.id + '）' : j.theme) + '\n');
} else if (cmd === 'show') {
  const list = argv.slice(1).filter(a => !a.startsWith('--')).join(',').split(/[,，、]/).map(s => s.trim()).filter(Boolean).map(need);
  if (!list.length) die('用法：claw-theme show 甲,乙,丙');
  process.stdout.write(cards(list) + '\n');
} else if (cmd === 'set') {
  const ai = argv.indexOf('--alt'), q = argv.slice(1).filter((a, i) => i + 1 !== ai && i + 1 !== ai + 1).join(' ');
  if (!q) die('用法：claw-theme set <主题> [--alt 甲,乙,丙]');
  const t = need(q), more = alts(argv).filter(x => x.id !== t.id).slice(0, 3);
  const j = await call('/api/local/theme', { theme: t.id });
  if (!j.ok) die('没换成：' + (j.error || '未知错误'));
  process.stdout.write('已换成「' + t.name + '」，打开着的 claclaw 网页都马上变了。\n\n' + cards([t, ...more]) + '\n');
} else die('用法：claw-theme [list] | set <主题> [--alt 甲,乙,丙] | show 甲,乙,丙 | now');
