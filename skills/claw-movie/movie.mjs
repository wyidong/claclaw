#!/usr/bin/env node
// claw-movie：找电影：版权方官方频道免费公开的完整版和公版老片，出片单（就是播放列表）。用法见 SKILL.md。
import { run } from '../_lib/media/cli.mjs';
const USAGE = `用法：
  claw-movie "类型 / 片名 / 演员" [--n 10] [--min 7] [--year 2026] [--since 2006] [--new]   片单
  claw-movie --latest [--n 50] [--min 7]   最新上映的华语电影
  claw-movie --pick 3                      上次片单里的第 3 部：出播放链接
通用：[--proxy URL]`;
const a = process.argv.slice(2);
await run(a.length ? ['movies', ...a] : [], USAGE);
