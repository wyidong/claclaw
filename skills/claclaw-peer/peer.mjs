#!/usr/bin/env node
// claclaw 协同命令：给另一台电脑上已配对的 AI 会话发消息。任何 Claw 的 AI 都能通过执行命令来用。
// 只和本机 claclaw 说话：地址和本机令牌在 ~/.claclaw/local.json（claclaw 启动时写，只有本人可读）。
// 配对的钥匙始终只在 claclaw 里，这个命令碰不到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_DIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
const USAGE = `用法：
  claclaw-peer list
  claclaw-peer send [--from 你的会话ID] [--to 对方名字] [--session 对方会话ID] [--wait 秒] "消息"
  claclaw-peer result <任务号> [--wait 秒]`;

function die(msg, code = 1) { process.stdout.write(msg.replace(/\n?$/, '\n')); process.exit(code); }

function parse(argv) {
  const opts = {}, rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2), eq = k.indexOf('=');
      if (eq >= 0) opts[k.slice(0, eq)] = k.slice(eq + 1);
      else opts[k] = argv[++i] ?? '';
    } else rest.push(a);
  }
  return { opts, rest };
}

function local() {
  let j;
  try { j = JSON.parse(fs.readFileSync(path.join(HOME_DIR, 'local.json'), 'utf8')); }
  catch { die('claclaw 没在运行（找不到 ' + path.join(HOME_DIR, 'local.json') + '），请先启动 claclaw'); }
  if (!j.url || !j.token) die('claclaw 本机配置不完整，请重启 claclaw');
  return j;
}

async function call(pathname, body, waitSec) {
  const { url, token } = local();
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), (waitSec + 15) * 1000);
  try {
    const r = await fetch(url + pathname, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-claclaw-local': token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctl.signal,
    });
    return await r.json();
  } catch (e) {
    die(e.name === 'AbortError' ? 'claclaw 没有响应' : 'claclaw 没在运行（' + (e.cause?.code || e.message) + '），请先启动 claclaw');
  } finally { clearTimeout(t); }
}

function done(j) {
  if (j.pending) die('对方还在处理。任务号 ' + j.job + '，过一会儿运行：claclaw-peer result ' + j.job, 2);
  if (!j.ok) die('出错：' + (j.error || '未知错误') + (j.resets ? '（' + j.resets + ' 恢复）' : ''));
  die((j.peer ? '【' + j.peer + ' 的回复】\n' : '') + (j.reply || '（对方这一轮没有文字回复）'), 0);
}

const [cmd, ...args] = process.argv.slice(2);
const { opts, rest } = parse(args);
const wait = Math.max(5, Math.min(Number(opts.wait) || 110, 590));

if (cmd === 'list') {
  const j = await call('/api/local/peer/list', null, 30);
  if (!j.ok) die('出错：' + (j.error || '未知错误'));
  const lines = [];
  for (const p of j.peers || []) {
    lines.push('对方「' + p.peer + '」' + (p.ok ? '' : '：连不上（' + (p.error || '离线') + '）'));
    for (const s of p.sessions || []) lines.push('  ' + s.id + '  ' + (s.title || '(无标题)') + (s.claw && s.claw !== 'claude' ? '  [' + s.claw + ']' : '') + (s.busy ? '  （忙）' : ''));
    if (p.ok && !(p.sessions || []).length) lines.push('  （没有开放会话）');
  }
  die(lines.join('\n') || '还没有可以联系的已配对对方', 0);
} else if (cmd === 'send') {
  let text = rest.join(' ').trim();
  if (text === '-' || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, 'utf8').trim();
  if (!text) die('消息是空的\n' + USAGE);
  done(await call('/api/local/peer/send', { text, from: opts.from || '', to: opts.to || '', session: opts.session || '', wait }, wait));
} else if (cmd === 'result') {
  const job = rest[0] || opts.job;
  if (!job) die('缺少任务号\n' + USAGE);
  done(await call('/api/local/peer/result?job=' + encodeURIComponent(job) + '&wait=' + wait, null, wait));
} else die(USAGE, cmd ? 1 : 0);
