#!/usr/bin/env node
// claw-movie：找电影：版权方官方频道免费公开的完整版和公版老片，出片单（就是播放列表）；也能把片单里的一部投到电视上。用法见 SKILL.md。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '../_lib/media/cli.mjs';
const USAGE = `用法：
  claw-movie "类型 / 片名 / 演员" [--n 10] [--min 7] [--year 2026] [--since 2006] [--new]   片单
  claw-movie --latest [--n 50] [--min 7]   最新上映的华语电影
  claw-movie --pick 3                      上次片单里的第 3 部：出播放链接
  claw-movie --tv                          局域网里能投屏的电视
  claw-movie --cast 3 [--to 电视名] [--at 秒]   把上次片单里的第 3 部投到电视（也可以 --cast 网址）
  claw-movie --cast-status | --cast-stop | --cast-pause | --cast-resume
通用：[--proxy URL]`;
const a = process.argv.slice(2);
const flag = n => { const i = a.indexOf(n); return i < 0 ? undefined : a[i + 1] && !a[i + 1].startsWith('--') ? a[i + 1] : true; };

if (['--tv', '--cast', '--cast-status', '--cast-stop', '--cast-pause', '--cast-resume'].some(f => a.includes(f))) await cast();
else await run(a.length ? ['movies', ...a] : [], USAGE);

// 投屏：交给正在跑的 claclaw（它在局域网里找电视、转发视频），见 src/cast/cast.mjs
async function cast() {
  const HOME = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
  let j; try { j = JSON.parse(fs.readFileSync(path.join(HOME, 'local.json'), 'utf8')); } catch { die('claclaw 没在运行，投不了屏'); }
  const api = async body => {
    const r = await fetch(j.url + '/api/local/cast', { method: 'POST', headers: { 'x-claclaw-local': j.token, 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const v = await r.json();
    if (v.ok === false) die(v.error || '投屏失败');
    return v;
  };
  const fmt = s => { s = Math.round(s || 0); return `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };
  const show = s => s.active ? `${s.device?.name}：${s.title || s.page}　${{ resolving: '取视频中', starting: '电视正在打开', error: '失败：' + s.error }[s.phase] || ({ PLAYING: '播放中', PAUSED_PLAYBACK: '已暂停', TRANSITIONING: '缓冲中' }[s.state] || s.state || '')}${s.dur ? `　${fmt(s.pos)} / ${fmt(s.dur)}` : ''}` : '没有在投屏';

  if (a.includes('--tv')) {
    const d = await api({ op: 'devices', fresh: true });
    if (!d.devices.length) die('没找到电视：电视 / 投影要开着、和这台电脑连同一个路由器，并打开投屏接收', 2);
    console.log('电视\t型号');
    for (const x of d.devices) console.log(x.name + '\t' + (x.model || x.host));
    return;
  }
  if (a.includes('--cast-status')) return console.log(show(await api({ op: 'status' })));
  for (const [f, action] of [['--cast-stop', 'stop'], ['--cast-pause', 'pause'], ['--cast-resume', 'play']]) if (a.includes(f)) { await api({ op: 'ctl', action }); return console.log(action === 'stop' ? '已停止投屏' : show(await api({ op: 'status' }))); }

  // --cast 3 / --cast 网址
  const v = flag('--cast');
  let page = '', title = '';
  if (/^https?:\/\//.test(v)) page = v;
  else {
    const n = +v || 1;
    let last; try { last = JSON.parse(fs.readFileSync(path.join(HOME, 'media', 'movies-last.json'), 'utf8')); } catch {}
    const x = last?.items?.[n - 1];
    if (!x) die('没有第 ' + n + ' 部（先搜片单）');
    page = x.page; title = x.name;
  }
  const { devices, last } = await api({ op: 'devices' });
  if (!devices.length) die('没找到电视：电视 / 投影要开着、和这台电脑连同一个路由器，并打开投屏接收', 2);
  const to = flag('--to');
  let dev = typeof to === 'string' ? devices.find(d => d.name === to) || devices.find(d => d.name.includes(to)) : devices.length === 1 ? devices[0] : devices.find(d => d.id === last) || null;   // 没指定：只有一台就它，否则上次投过的那台
  if (!dev) die((typeof to === 'string' ? `没有叫「${to}」的电视。` : '有好几台电视，用 --to 指定一台。') + '能投的：' + devices.map(d => d.name).join('、'), 2);
  await api({ op: 'play', page, title, device: dev.id, start: +flag('--at') || 0 });
  // 等电视开始播（最多 60 秒）
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const s = await api({ op: 'status' });
    if (s.phase === 'error') die('投屏失败：' + s.error);
    if (s.phase === 'playing') return console.log('已投到 ' + show(s));
  }
  console.log('已发给电视，还没开始播：' + show(await api({ op: 'status' })));
}
function die(s, code = 1) { console.error(s); process.exit(code); }
