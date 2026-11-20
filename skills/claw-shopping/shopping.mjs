#!/usr/bin/env node
// claw-shopping：按关键词搜拼多多（多多进宝）的商品，输出 ```shop 商品卡片（图、标题、券后价、点了跳拼多多）。
//   claw-shopping "保温杯"                       综合排序，6 个
//   claw-shopping "保温杯" --sort 价格|价格高|销量  排序
//   claw-shopping "保温杯" --max 50 [--min 20]   券后价范围（元）
//   claw-shopping "保温杯" --n 10                要几个（最多 10）
//   --json                                   给程序用
// 只和本机 claclaw 说话（~/.claclaw/local.json 里的地址和令牌）；查拼多多由 claclaw 去做（开发者本机直连，或经 clarelay 上的商品服务）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_DIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
function die(msg, code = 1) { process.stdout.write(msg.replace(/\n?$/, '\n')); process.exit(code); }

async function call(pathname, body) {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'local.json'), 'utf8')); } catch { die('claclaw 没在运行（找不到 ' + path.join(HOME_DIR, 'local.json') + '），请先启动 claclaw'); }
  try {
    const r = await fetch(j.url + pathname, { method: 'POST', headers: { 'x-claclaw-local': j.token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(40000) });
    const o = await r.json().catch(() => null);
    if (!o) die('claclaw 没认这个命令（' + r.status + '），可能要重启 claclaw 才能用购物');
    return o;
  } catch (e) { die('claclaw 没有响应（' + (e.cause?.code || e.message) + '），请先启动 claclaw'); }
}
const yuan = v => String(Math.round(v * 100) / 100);
const clean = s => String(s || '').replace(/[|\n\r]/g, ' ').replace(/\s+/g, ' ').trim();
function cardLine(x) {
  const sub = [x.orig > x.price ? '原价 ¥' + yuan(x.orig) : '', x.coupon > 0 ? '券 ¥' + yuan(x.coupon) : '', x.sales ? '已售 ' + x.sales : ''].filter(Boolean).join(' · ');
  return [x.platform || '拼多多', x.img || '', clean(x.title), yuan(x.price), sub, x.url].join(' | ');
}

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
const OPTS = new Set(['--sort', '--n', '--min', '--max']);
const words = argv.filter((a, i) => !a.startsWith('--') && !OPTS.has(argv[i - 1]));
const keyword = words.join(' ').trim();
if (!keyword) die('用法：claw-shopping "关键词" [--sort 综合|价格|价格高|销量] [--max 元] [--min 元] [--n 个数]');
const j = await call('/api/local/shop/search', { keyword, sort: opt('--sort') || '综合', n: Number(opt('--n')) || 6, min: Number(opt('--min')) || 0, max: Number(opt('--max')) || 0 });
if (argv.includes('--json')) { process.stdout.write(JSON.stringify(j) + '\n'); process.exit(j.ok ? 0 : 2); }
if (!j.ok) die('没搜到：' + (j.error || '未知原因'), 2);
if (!j.items.length) die('拼多多上没搜到「' + keyword + '」，换个说法试试', 2);
process.stdout.write('```shop\n' + j.items.map(cardLine).join('\n') + '\n```\n');
