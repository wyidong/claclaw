#!/usr/bin/env node
// claclaw 会话互找命令：给本机 claclaw 里的其他 AI 会话、或另一台电脑上已配对的会话发消息。任何 Claw 的 AI 都能通过执行命令来用。
// 发起方是哪个会话：不写 --from 时 claclaw 按「命令在哪个目录跑 + 哪个会话正在回复」自动认。
// 只和本机 claclaw 说话：地址和本机令牌在 ~/.claclaw/local.json（claclaw 启动时写，只有本人可读）。
// 配对的钥匙始终只在 claclaw 里，这个命令碰不到。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME_DIR = process.env.CLACLAW_HOME || path.join(os.homedir(), '.claclaw');
const USAGE = `用法：
  claclaw-peer whoami
  claclaw-peer list [--to 本机|对方名字]
  claclaw-peer send --to 本机 --session 会话ID [--wait 秒] "消息"
  claclaw-peer send [--to 对方名字] [--session 对方会话ID] [--wait 秒] "消息"
  claclaw-peer result <任务号> [--wait 秒]
  （认不出你是哪个会话时，加 --from 你的会话ID）`;

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
  if (j.pending) die('对方还在处理。任务号 ' + j.job + '，过一会儿运行：~/.claclaw/bin/claclaw-peer result ' + j.job, 2);
  if (!j.ok) die('出错：' + (j.error || '未知错误') + (j.resets ? '（' + j.resets + ' 恢复）' : ''));
  die((j.peer ? '【' + j.peer + ' 的回复】\n' : '') + (j.reply || '（对方这一轮没有文字回复）'), 0);
}

const [cmd, ...args] = process.argv.slice(2);
const { opts, rest } = parse(args);
const wait = Math.max(5, Math.min(Number(opts.wait) || 110, 280));   // fetch 等响应头最多 5 分钟：再久就断，用 result 分段取

const who = () => '&from=' + encodeURIComponent(opts.from || '') + '&cwd=' + encodeURIComponent(process.cwd());
if (cmd === 'whoami') {
  const j = await call('/api/local/peer/whoami?' + who().slice(1), null, 15);
  if (!j.ok) die('出错：' + (j.error || '未知错误'));
  die('会话 ID：' + j.id + '\nClaw：' + j.claw + (j.title ? '\n标题：' + j.title : '') + '\n' + (j.pool ? '已加入协同，能找另一台电脑' : '没加入协同，只能找本机的会话'), 0);
} else if (cmd === 'list') {
  const j = await call('/api/local/peer/list?to=' + encodeURIComponent(opts.to || '') + who(), null, 30);
  if (!j.ok) die('出错：' + (j.error || '未知错误'));
  const lines = [];
  if (j.local) {
    lines.push('本机（--to 本机）');
    for (const s of j.local) lines.push('  ' + s.id + '  ' + (s.title || '(无标题)') + '  [' + s.claw + ']' + (s.busy ? '  （忙）' : ''));
    if (!j.local.length) lines.push('  （没有别的会话）');
  }
  if (j.peerNote) lines.push(j.peerNote);
  for (const p of j.peers || []) {
    lines.push('对方「' + p.peer + '」' + (p.ok ? '' : '：连不上（' + (p.error || '离线') + '）'));
    for (const s of p.sessions || []) lines.push('  ' + s.id + '  ' + (s.title || '(无标题)') + (s.claw && s.claw !== 'claude' ? '  [' + s.claw + ']' : '') + (s.busy ? '  （忙）' : ''));
    if (p.ok && !(p.sessions || []).length) lines.push('  （没有开放会话）');
  }
  die(lines.join('\n') || '没有能联系的会话', 0);
} else if (cmd === 'send') {
  let text = rest.join(' ').trim();
  if (text === '-' || (!text && !process.stdin.isTTY)) text = fs.readFileSync(0, 'utf8').trim();
  if (!text) die('消息是空的\n' + USAGE);
  done(await call('/api/local/peer/send', { text, from: opts.from || '', cwd: process.cwd(), to: opts.to || '', session: opts.session || '', wait }, wait));
} else if (cmd === 'result') {
  const job = rest[0] || opts.job;
  if (!job) die('缺少任务号\n' + USAGE);
  done(await call('/api/local/peer/result?job=' + encodeURIComponent(job) + '&wait=' + wait, null, wait));
} else die(USAGE, cmd ? 1 : 0);
