#!/usr/bin/env node
// claw-install：让 claclaw 在这台电脑上装一个 Agent（现在只有 DeepSeek Harness）。只给 kuAi 用（kuAi 自己装不了软件）。
//   claw-install deepseek    开始装；已经装了、正在装的会说明，不重复装
//   claw-install status      看装到哪了
// 真正干活的是 claclaw 服务（src/claws/install.mjs：只装它列出来的包，不认别的包名）；这里只通过本机接口叫它开始、取进度。
// kuAi 跑「开始装」之前会先让用户在网页上点确认（skills/kuai.json 里的 ask）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_DIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
const NAMES = { deepseek: /^(deepseek|deepseekharness|dsh|ds|深度求索)$/ };
const KEY_TIP = '装好后还要填 API Key 才能用：到 Claw 页，在 DeepSeek 那张卡片上点「填 key」，填 DeepSeek 开放平台（platform.deepseek.com）的 API Key。';

function die(msg, code = 1) { process.stdout.write(msg.replace(/\n?$/, '\n')); process.exit(code); }
const norm = s => String(s || '').toLowerCase().replace(/[\s·・.,，、:：「」"'（）()_-]/g, '');
async function call(body) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'local.json'), 'utf8')); } catch { die('claclaw 没在运行（找不到 ' + path.join(HOME_DIR, 'local.json') + '），请先启动 claclaw'); }
  try {
    const r = await fetch(j.url + '/api/local/install', { method: body ? 'POST' : 'GET', headers: { 'x-claclaw-local': j.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
    const o = await r.json().catch(() => null);
    if (!o) die('claclaw 没认这个命令（' + r.status + '），可能要重启 claclaw 才能用安装');
    return o;
  } catch (e) { die('claclaw 没有响应（' + (e.cause?.code || e.message) + '），请先启动 claclaw'); }
}
// 进度 → 一句话
function say(st, label = 'DeepSeek Harness') {
  label = st.label || label;
  if (st.status === 'ok') return label + ' 装好了。' + KEY_TIP;
  if (st.status === 'fail') return label + ' 没装成：' + (st.error || '原因不明') + '';
  if (st.status === 'running') return '已经开始安装 ' + label + '，现在 ' + (st.pct || 0) + '%' + (st.tail ? '（' + st.tail + '）' : '') + '。一般要 1–5 分钟，看网速；进度在 Claw 页 DeepSeek 那张卡片上能看到。' + KEY_TIP;
  return '现在没有在装东西。';
}

const arg = norm(process.argv[2]);
if (!arg || arg === 'status' || arg === 'now') {
  const o = await call();
  if (!o.ok) die(o.error || '查不到安装进度');
  die(say(o.state || {}), o.state?.status === 'fail' ? 1 : 0);
}
const claw = Object.keys(NAMES).find(k => NAMES[k].test(arg));
if (!claw) die('这里只能装：DeepSeek Harness（claw-install deepseek）。别的软件装不了，给出命令让用户自己在电脑的终端里装。', 2);
let o = await call({ claw });
if (!o.ok) die('没装：' + (o.error || '原因不明'));
if (o.installed) die((o.label || 'DeepSeek Harness') + ' 已经装好了，不用再装。还没填 API Key 的话：到 Claw 页，在 DeepSeek 那张卡片上点「填 key」。', 0);
// 等一小会儿：马上就失败的（没有 npm、没有权限）当场说；还在装就报进度，不一直等到装完（要几分钟）
for (let i = 0; i < 8 && o.state?.status === 'running'; i++) { await new Promise(r => setTimeout(r, 2500)); o = await call(); if (!o.ok) break; }
die(say(o.state || {}), o.state?.status === 'fail' ? 1 : 0);
