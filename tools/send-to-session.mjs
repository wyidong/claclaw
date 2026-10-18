#!/usr/bin/env node
// 通过 claclaw 唤醒一个会话并发一条消息（本机用，给「一个会话叫另一个会话干活」用）。
// 会话在 claclaw 里运行，手机网页上能实时看到、随时插话或接管；跑完空闲 1 分钟后照常关闭。
// 用法：node tools/send-to-session.mjs <会话 ID 或前缀> <消息文件 | -（从标准输入读）> [--wait]
//   --wait：等这一轮跑完（turn.done）再退出，期间把回复文字打印出来；不加则发出去就退出（会话继续在 claclaw 里跑）。
// 认证：临时签一个登录令牌（只存在本机 data/tokens.json），用完立即作废。
import fs from 'node:fs';
import { WebSocket } from 'ws';
import { listSessions } from '@anthropic-ai/claude-agent-sdk';
import { issueToken, revokeToken } from '../auth.mjs';

const [idArg, file, ...rest] = process.argv.slice(2);
const wait = rest.includes('--wait');
if (!idArg || !file) { console.error('用法：node tools/send-to-session.mjs <会话ID> <消息文件|-> [--wait]'); process.exit(2); }
const text = fs.readFileSync(file === '-' ? 0 : file, 'utf8').trim();
if (!text) { console.error('消息是空的'); process.exit(2); }

const all = await listSessions({ includeProgrammatic: true, limit: 2000 });
const hits = all.filter(s => s.sessionId.startsWith(idArg));
if (hits.length !== 1) { console.error(hits.length ? '前缀不唯一：' + hits.map(s => s.sessionId).join(' ') : '找不到会话 ' + idArg); process.exit(2); }
const id = hits[0].sessionId;

const port = Number(process.env.CLACLAW_PORT || 8787);
const token = issueToken('agent', 'local');
const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: 'claclaw_sid=' + token } });
const done = code => { try { revokeToken(token); } catch {} try { ws.close(); } catch {} setTimeout(() => process.exit(code), 100); };
const timer = setTimeout(() => { console.error('超时'); done(1); }, (wait ? 60 : 1) * 60_000);

let sent = false;
ws.on('open', () => ws.send(JSON.stringify({ t: 'session.open', id })));
ws.on('error', e => { console.error('连不上 claclaw：', e.message); done(1); });
ws.on('message', raw => {
  const m = JSON.parse(raw);
  if (m.t === 'session.busy') { console.error('会话正被别处占用：', JSON.stringify(m)); return done(1); }
  if (m.t === 'error') { console.error('claclaw：', m.message); if (!sent) return done(1); }
  if (m.t === 'session.opened' && !sent) {
    if (m.busy) { console.error('会话正在处理上一条，稍后再发'); return done(1); }
    sent = true;
    ws.send(JSON.stringify({ t: 'message.send', text }));
    console.log('已发送到', id, m.title || '');
    if (!wait) { clearTimeout(timer); return done(0); }
  }
  if (wait && m.t === 'ai.full') console.log(m.text);
  if (wait && m.t === 'turn.done') { clearTimeout(timer); done(0); }
});
