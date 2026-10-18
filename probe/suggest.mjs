// 探针：promptSuggestions 什么情况下会发 prompt_suggestion
import { query } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
const force = process.argv[2] === 'force';
const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-sug-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k)));
if (force) env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION = 'true';
const msgs = ['记住数字 7。只回复 ok', '刚才的数字乘以 3 是多少？只回复数字'];
let wake; const q2 = [msgs[0]];
const input = { async *[Symbol.asyncIterator]() { for (;;) { while (q2.length) yield { type: 'user', message: { role: 'user', content: q2.shift() }, parent_tool_use_id: null }; await new Promise(r => (wake = r)); } } };
const q = query({ prompt: input, options: { cwd: CWD, permissionMode: 'default', settingSources: ['project', 'local'], env, promptSuggestions: true } });
let turn = 0; const t0 = Date.now();
setTimeout(() => { console.log('[sug] end'); q.close(); process.exit(0); }, 75000);
for await (const m of q) {
  const k = m.type + (m.subtype ? ':' + m.subtype : '');
  if (m.type === 'result') { turn++; console.log('[sug]', ((Date.now() - t0) / 1000).toFixed(1), 'result turn', turn); setTimeout(() => { if (turn < msgs.length) { q2.push(msgs[turn]); wake?.(); } }, 12000); }
  else if (m.type === 'prompt_suggestion') console.log('[sug] SUGGESTION', JSON.stringify(m.suggestion));
  else if (m.type === 'rate_limit_event') console.log('[sug] rate_limit', JSON.stringify(m.rate_limit_info).slice(0, 200));
  else if (turn > 0 && !['stream_event', 'assistant', 'user'].includes(m.type)) console.log('[sug] after-result msg', k);
}
