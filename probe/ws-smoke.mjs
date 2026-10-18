// 冒烟：打开探针会话 → 发一句要写文件的话 → 收到权限请求后点「允许」→ 等本轮结束
import WebSocket from 'ws';
const id = process.argv[2];
const ws = new WebSocket('ws://127.0.0.1:8787/ws');
const seen = {};
ws.on('open', () => ws.send(JSON.stringify({ t: 'session.open', id })));
ws.on('message', raw => {
  const m = JSON.parse(raw); seen[m.t] = (seen[m.t] || 0) + 1;
  if (m.t === 'session.opened') {
    console.log('opened', m.id.slice(0, 8), 'mode', m.mode, 'history', m.history.length, JSON.stringify(m.history.slice(-3)).slice(0, 300));
    ws.send(JSON.stringify({ t: 'message.send', text: '用 Write 工具在当前目录新建 web.txt，内容 ok。然后回复 done。' }));
  } else if (m.t === 'perm.request') {
    console.log('perm', JSON.stringify(m).slice(0, 300));
    ws.send(JSON.stringify({ t: 'permission.reply', requestId: m.requestId, decision: 'allow' }));
  } else if (m.t === 'tool.start' || m.t === 'tool.result' || m.t === 'error' || m.t === 'sys' || m.t === 'session.busy') {
    console.log(m.t, JSON.stringify(m).slice(0, 200));
  } else if (m.t === 'turn.done') {
    console.log('done', JSON.stringify(m), 'events', JSON.stringify(seen)); ws.close(); process.exit(0);
  }
});
setTimeout(() => { console.log('TIMEOUT', JSON.stringify(seen)); process.exit(1); }, 150000);
