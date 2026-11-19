#!/usr/bin/env node
// claw-video：找视频（B 站、YouTube、Dailymotion、Internet Archive），默认给能在 claclaw 聊天里直接播的链接。用法见 SKILL.md。
import { run, split } from '../_lib/media/cli.mjs';
const USAGE = `用法：
  claw-video "关键词" [--n 1] [--max 秒] [--src a,b]     能在聊天里直接播的视频链接（默认 30 分钟以内）
  claw-video find "关键词" [--n 10] [--max 秒]            候选列表
  claw-video get "关键词或网址" [--pick 序号] [--clip 秒] [--max-mb 45]   下载成 mp4 文件
  claw-video related "B 站 / YouTube 视频网址" [--n 10]   相关视频
  claw-video sources                                      各来源成败、耗时
通用：[--proxy URL] [--out 目录]`;
const [sub, rest] = split(process.argv.slice(2), ['find', 'get', 'related', 'sources']);
await run(sub === 'related' ? ['related', ...rest] : sub === 'sources' ? ['sources'] : [sub || 'link', 'video', ...rest], USAGE);
