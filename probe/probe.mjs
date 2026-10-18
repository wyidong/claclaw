// 阶段 0 核实用探针：不是服务代码。
// 在一个临时目录里新建会话（绝不碰已有会话），验证：
//   1) canUseTool 能拦到权限请求，拿到哪些字段
//   2) SDK 起的进程会不会登记到 ~/.claude/sessions/、有没有 messagingSocketPath
//   3) 会话写到 ~/.claude/projects/ 的哪里；resume 后是否续写同一个文件
import { query, listSessions } from '@anthropic-ai/claude-agent-sdk';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'claclaw-probe-'));
const REG = path.join(os.homedir(), '.claude', 'sessions');
const log = (...a) => console.log('[probe]', ...a);

function registryFor(sessionId) {
  for (const f of fs.readdirSync(REG).filter(f => f.endsWith('.json'))) {
    try {
      const o = JSON.parse(fs.readFileSync(path.join(REG, f), 'utf8'));
      if (o.sessionId === sessionId) {
        const { pid, kind, entrypoint, status, version, messagingSocketPath, peerFeatures } = o;
        return { pid, kind, entrypoint, status, version, messagingSocketPath, peerFeatures };
      }
    } catch {}
  }
  return null;
}

// 流式输入：保持会话常驻，才能用 interrupt / setPermissionMode
function inbox() {
  const q = []; let wake;
  return {
    push(text) {
      q.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
      wake?.();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) { while (q.length) yield q.shift(); await new Promise(r => (wake = r)); }
    },
  };
}

async function run(label, opts, prompt) {
  const box = inbox();
  box.push(prompt);
  let sessionId, perms = [];
  const q = query({
    prompt: box,
    options: {
      cwd: CWD,
      permissionMode: 'default',
      includePartialMessages: true,
      // 去掉从父会话继承的 CLAUDE_* / CLAUDECODE，模拟 launchd 常驻服务的干净环境
      env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))),
      ...(process.env.PROBE_NO_USER ? { settingSources: ['project', 'local'] } : {}),
      ...opts,
      canUseTool: async (toolName, input, o) => {
        const { title, displayName, description, decisionReason, suggestions, toolUseID, requestId, defaultToNo, suppressAlwaysAllowRule } = o;
        perms.push({ toolName, input, title, displayName, description, decisionReason, suggestions, toolUseID, requestId, defaultToNo, suppressAlwaysAllowRule });
        log(label, 'registry while waiting on permission:', JSON.stringify(registryFor(sessionId)));
        return { behavior: 'allow', updatedInput: input };
      },
    },
  });
  const seen = {};
  for await (const m of q) {
    const k = m.type + (m.subtype ? ':' + m.subtype : '') + (m.type === 'stream_event' ? ':' + m.event?.type : '');
    seen[k] = (seen[k] || 0) + 1;
    if (m.type === 'system' && m.subtype === 'init') {
      sessionId = m.session_id;
      log(label, 'init session', sessionId, 'permissionMode', m.permissionMode, 'tools has SendMessage:', m.tools?.includes('SendMessage'), 'ListAgents:', m.tools?.includes('ListAgents'));
    }
    if (m.type === 'result') { log(label, 'result', m.subtype, 'cost', m.total_cost_usd); break; }
  }
  log(label, 'message kinds:', JSON.stringify(seen));
  log(label, 'permission requests:', JSON.stringify(perms, null, 1));
  log(label, 'registry after result:', JSON.stringify(registryFor(sessionId)));
  q.close?.();
  return sessionId;
}

const s1 = await run('A', {}, '在当前目录用 Write 工具新建 hello.txt，内容是 hi。只做这一件事，然后回复 done。');
const proj = fs.readdirSync(path.join(os.homedir(), '.claude', 'projects')).filter(d => d.includes('claclaw-probe'));
log('project dirs:', proj);
const file = proj.map(d => path.join(os.homedir(), '.claude', 'projects', d, s1 + '.jsonl')).find(fs.existsSync);
const lines1 = file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
log('jsonl', file, 'lines', lines1, 'entrypoint', file && JSON.parse(fs.readFileSync(file, 'utf8').split('\n').find(l => l.includes('"entrypoint"')) || '{}').entrypoint);

const s2 = await run('B', { resume: s1 }, '刚才那个文件叫什么？只回答文件名。');
const lines2 = file ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0;
log('resume kept id:', s1 === s2, 'jsonl lines', lines1, '->', lines2);

const listed = await listSessions({ dir: CWD });
log('listSessions(dir):', JSON.stringify(listed.map(s => ({ id: s.sessionId, summary: s.summary, cwd: s.cwd }))));
const all = await listSessions({ includeProgrammatic: false, limit: 5 });
log('listSessions(all, no programmatic) top5:', JSON.stringify(all.map(s => ({ id: s.sessionId.slice(0, 8), summary: s.summary?.slice(0, 30), cwd: s.cwd }))));
log('cwd', CWD);
process.exit(0);
