#!/usr/bin/env node
// claw-theme：给 claclaw 网页换皮肤（只在现有主题库里选，见 themes.json）。
//   claw-theme                    主题库（id、名字、明暗、颜色、气质）+ 现在用的
//   claw-theme set <主题> [--alt 甲,乙,丙]   换上（所有打开的网页马上变），输出 ```theme 卡片：换上的 + 2～3 个备选，用户点了就换
//   claw-theme show 甲,乙,丙       只出卡片给用户挑，不换
//   claw-theme now                现在用的是哪个、背景图开没开
//   claw-theme img off|on         时辰主题的背景图：off 纯色，on 铺图（只有 6 个浅色时辰有图）；set 也能带 --img off
//   claw-theme bg [图片路径|last] [--on 时辰主题] [--fit cover|center] [--alt 甲,乙]   用户自己的图当背景（12 个时辰都铺）；
//                                 不写路径 / last = 用户在聊天里最近发的那张图；reset 回到时辰自带的图
//   claw-theme fit cover|center   背景图铺法：cover 按比例拉伸铺满（默认），center 原尺寸居中、不拉伸
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
const opt = k => { const i = argv.indexOf(k); return i > 0 ? argv[i + 1] : undefined; };
const FIT = { cover: 'cover', center: 'center', 拉伸: 'cover', 铺满: 'cover', 居中: 'center', 不拉伸: 'center' };
const FIT_TXT = { cover: '按比例拉伸铺满', center: '原尺寸居中、不拉伸' };
if (cmd === 'list' || cmd === 'ls') {
  const j = await call('/api/local/theme');
  process.stdout.write('现在用的：' + (find(j.theme)?.name || j.theme) + '（* 标出）\n\n' + table(j.theme) + '\n');
} else if (cmd === 'now') {
  const j = await call('/api/local/theme');
  const t = find(j.theme);
  process.stdout.write('现在用的：' + (t ? t.name + '（' + t.id + '）' : j.theme) + '；时辰背景图：' + (j.img === 'on' ? '开' : '关（纯色）')
    + '；背景图：' + (j.bg === 'mine' ? '用户自己的图' : '时辰自带的') + '，' + FIT_TXT[j.fit || 'cover'] + '\n');
} else if (cmd === 'bg') {
  const file = argv[1] && !argv[1].startsWith('--') ? argv[1] : 'last';   // 不写路径 = 用户在聊天里最近发的那张图
  const fit = opt('--fit') ? FIT[opt('--fit')] : undefined;
  if (opt('--fit') && !fit) die('--fit 只能是 cover（拉伸铺满）或 center（居中不拉伸）');
  if (file === 'reset') {
    const j = await call('/api/local/theme', { bg: 'reset', fit });
    if (!j.ok) die('没换成：' + (j.error || '未知错误'));
    die('已不用自己的图，回到时辰自带的背景图（只有 6 个浅色时辰有图，其余是纯色），打开着的 claclaw 网页都马上变了。', 0);
  }
  const on = opt('--on') ? need(opt('--on')) : null;
  if (on && !on.id.startsWith('shichen')) die('背景图只有时辰主题能铺（子午流注或某个时辰），「' + on.name + '」不行，换一个时辰主题');
  const j = await call('/api/local/theme', { bg: file === 'last' ? 'last' : path.resolve(file), theme: on?.id, fit });
  if (!j.ok) die('没换成：' + (j.error || '未知错误'));
  const t = find(j.theme), more = alts(argv).filter(x => x.id !== t?.id && x.id.startsWith('shichen')).slice(0, 3);
  if (j.lastAgo > 30) process.stderr.write('注意：用的是 ' + j.lastAgo + ' 分钟前用户发的图\n');
  process.stdout.write('已把这张图设成背景（' + FIT_TXT[j.fit || 'cover'] + '），配色用「' + (t?.name || j.theme) + '」，打开着的 claclaw 网页都马上变了。'
    + (more.length ? '换配色点下面的卡片（图不变）：\n\n' + cards([t, ...more].filter(Boolean)) : '') + '\n');
} else if (cmd === 'fit') {
  const fit = FIT[argv[1] || ''];
  if (!fit) die('用法：claw-theme fit cover|center');
  const j = await call('/api/local/theme', { fit });
  if (!j.ok) die('没换成：' + (j.error || '未知错误'));
  process.stdout.write('背景图改成' + FIT_TXT[fit] + '，打开着的 claclaw 网页都马上变了。\n');
} else if (cmd === 'img') {
  const v = { off: 'off', on: 'on', 关: 'off', 开: 'on', 纯色: 'off', 图片: 'on' }[argv[1] || ''];
  if (!v) die('用法：claw-theme img off|on');
  const j = await call('/api/local/theme', { img: v });
  if (!j.ok) die('没换成：' + (j.error || '未知错误'));
  process.stdout.write(v === 'off' ? '已关掉时辰背景图，改成纯色背景，打开着的 claclaw 网页都马上变了。\n' : '已打开时辰背景图（只有 6 个浅色时辰有图：子、卯、辰、未、申、亥），打开着的 claclaw 网页都马上变了。\n');
} else if (cmd === 'show') {
  const list = argv.slice(1).filter(a => !a.startsWith('--')).join(',').split(/[,，、]/).map(s => s.trim()).filter(Boolean).map(need);
  if (!list.length) die('用法：claw-theme show 甲,乙,丙');
  process.stdout.write(cards(list) + '\n');
} else if (cmd === 'set') {
  const skip = new Set(); for (const o of ['--alt', '--img']) { const k = argv.indexOf(o); if (k > 0) { skip.add(k); skip.add(k + 1); } }
  const q = argv.slice(1).filter((a, i) => !skip.has(i + 1)).join(' ');
  const ii = argv.indexOf('--img'), img = ii > 0 ? { off: 'off', on: 'on' }[argv[ii + 1]] : undefined;
  if (!q) die('用法：claw-theme set <主题> [--alt 甲,乙,丙]');
  const t = need(q), more = alts(argv).filter(x => x.id !== t.id).slice(0, 3);
  const j = await call('/api/local/theme', { theme: t.id, img });
  if (!j.ok) die('没换成：' + (j.error || '未知错误'));
  process.stdout.write('已换成「' + t.name + '」，打开着的 claclaw 网页都马上变了。\n\n' + cards([t, ...more]) + '\n');
} else die('用法：claw-theme [list] | set <主题> [--alt 甲,乙,丙] [--img off|on] | show 甲,乙,丙 | img off|on | bg [图片路径|last|reset] [--on 时辰] [--fit cover|center] | fit cover|center | now');
