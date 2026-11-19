#!/usr/bin/env node
// claw-audio：找歌、找音频（B 站、YouTube、SoundCloud、Internet Archive、Openverse），默认给能在 claclaw 聊天里直接播的链接。用法见 SKILL.md。
import { run, split } from '../_lib/media/cli.mjs';
const USAGE = `用法：
  claw-audio "歌名 歌手" [--n 1] [--max 秒] [--src a,b]   能在聊天里直接播的链接（默认 60 分钟以内）
  claw-audio find "关键词" [--n 10]                        候选列表
  claw-audio get "关键词或网址" [--pick 序号] [--clip 秒]   下载成 m4a 文件
  claw-audio sources                                       各来源成败、耗时
通用：[--proxy URL] [--out 目录]`;
const [sub, rest] = split(process.argv.slice(2), ['find', 'get', 'sources']);
await run(sub === 'sources' ? ['sources'] : [sub || 'link', 'audio', ...rest], USAGE);
