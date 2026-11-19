#!/usr/bin/env node
// claw-image：找图片（Bing、百度、360、Wikimedia Commons、Openverse），下载成文件发给用户。用法见 SKILL.md。
import { run, split } from '../_lib/media/cli.mjs';
const USAGE = `用法：
  claw-image "关键词" [--n 3] [--src a,b]   下载图片（每行一个文件路径）
  claw-image find "关键词" [--n 10]         候选列表；再 claw-image "同一个关键词" --pick 序号 下载那一张
  claw-image sources                        各来源成败、耗时
通用：[--proxy URL] [--out 目录]`;
const [sub, rest] = split(process.argv.slice(2), ['find', 'sources']);
await run(sub === 'sources' ? ['sources'] : [sub || 'get', 'image', ...rest], USAGE);
