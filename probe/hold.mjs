// 测试用：另起一个进程「占着」某个会话，模拟 VS Code / 终端那一侧（不发消息，只挂着）
import { query, getSessionInfo } from '@anthropic-ai/claude-agent-sdk';
const [id, secs = '120'] = process.argv.slice(2);
const info = await getSessionInfo(id);
const q = query({ prompt: { async *[Symbol.asyncIterator]() { await new Promise(() => {}); } },
  options: { resume: id, cwd: info.cwd, permissionMode: 'default', settingSources: [],
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^CLAUDE/.test(k))) } });
(async () => { try { for await (const m of q) {} } catch (e) { console.log('[hold] stream ended', e.message); } })();
console.log('[hold] pid', process.pid, 'holding', id.slice(0, 8));
setTimeout(() => { q.close(); process.exit(0); }, Number(secs) * 1000);
