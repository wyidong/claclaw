// 阶段 0 探针 2：SDK 会话回复完后保持常驻，看它在 ~/.claude/sessions/ 的登记是否还在
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const REG = path.join(os.homedir(), '.claude', 'sessions');
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-idle-'));
const reg = id => { for (const f of fs.readdirSync(REG).filter(f => f.endsWith('.json'))) { try { const o = JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8')); if (o.sessionId === id) return { pid: o.pid, status: o.status, sock: o.messagingSocketPath, name: o.name }; } catch {} } return null; };
let wake; const msgs = [{ type: 'user', message: { role: 'user', content: '回复 ok 两个字母即可' }, parent_tool_use_id: null }];
const input = { async *[Symbol.asyncIterator]() { for (;;) { while (msgs.length) yield msgs.shift(); await new Promise(r => (wake = r)); } } };
const q = query({ prompt: input, options: { cwd: CWD, permissionMode: 'default', settingSources: ['project', 'local'],
  env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))),
  canUseTool: async (t, i) => { console.log('[idle] canUseTool', t, JSON.stringify(i).slice(0, 300)); return { behavior: 'deny', message: 'probe' }; } } });
let id;
(async () => { for await (const m of q) {
  if (m.type === 'system' && m.subtype === 'init') id = m.session_id;
  if (m.type === 'result') console.log('[idle] result', m.subtype, 'registry', JSON.stringify(reg(id)));
  if (m.type === 'user' || (m.type === 'system' && !['init', 'status'].includes(m.subtype))) console.log('[idle] msg', m.type, m.subtype || '', JSON.stringify(m).slice(0, 400));
} })();
const secs = Number(process.env.IDLE_SECS || 8);
for (let i = 0; i < secs; i++) { await new Promise(r => setTimeout(r, 1000)); console.log('[idle] t+' + i, id?.slice(0, 8), JSON.stringify(reg(id))); }
q.close(); process.exit(0);
